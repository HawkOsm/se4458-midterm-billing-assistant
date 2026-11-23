// The AI agent with a scripted FAKE Claude (no API key, no cost; assignment line 120),
// against the REAL billing API (test database) and the REAL MCP server (in memory).
import "./testEnv";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent, type ModelClient, type TurnResult } from "../src/agent/agent";
import { BillingApiClient } from "../src/agent/billingApiClient";
import { connectMcp, type McpTools } from "../src/agent/mcpClient";
import { BILLING_TOOLS } from "../src/agent/tools";
import { DailyLimit } from "../src/agent/dailyLimit";
import { createAgentApp } from "../src/agent/server";
import { pool } from "../src/db/db";
import { ensureIndexed } from "../src/mcp/docsService";
import { createMcpServer } from "../src/mcp/server";
import { issueToken } from "../src/services/tokenService";
import {
  beginTestTransaction,
  closePool,
  insertBill,
  insertSubscriber,
  insertUser,
  listen,
  prepareTestDatabase,
  startTestServer,
  type TestServer,
  type TestTx,
} from "./helpers";

// ---------- a scripted Claude ----------

type Block = Anthropic.ContentBlock;
const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;
let nextId = 0;
const toolUse = (name: string, input: unknown): Block =>
  ({ type: "tool_use", id: `toolu_${++nextId}`, name, input, caller: { type: "direct" } }) as unknown as Block;

// A step of the script: the reply's content, with the stop reason it implies, or an
// explicit one (e.g. a reply cut off at max_tokens).
type Step = Block[] | { content: Block[]; stop: Anthropic.StopReason };

// The API refuses a history where a tool call has no result in the next message: checked on
// every request, so any test that leaves one behind fails.
function assertValidHistory(messages: Anthropic.MessageParam[]): void {
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => (b as Anthropic.ToolUseBlockParam).id);
    if (ids.length === 0) return;
    const next = messages[i + 1];
    const answered = next && next.role === "user" && typeof next.content !== "string"
      ? next.content.filter((b) => b.type === "tool_result").map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id)
      : [];
    for (const id of ids) assert.ok(answered.includes(id), `tool call ${id} has no tool_result in the next message`);
  });
}

class FakeClaude implements ModelClient {
  readonly calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  gate: Promise<void> | undefined; // when set, every call waits for it
  constructor(private readonly script: Step[]) {}
  messages = {
    create: async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
      assertValidHistory(params.messages);
      // A snapshot: the agent keeps appending to the same array afterwards.
      this.calls.push(structuredClone(params));
      await this.gate;
      const step = this.script.shift() ?? [text("(script ended)")];
      const content = Array.isArray(step) ? step : step.content;
      const stop = Array.isArray(step) ? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn") : step.stop;
      const usage = { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 800 };
      return { id: "msg", type: "message", role: "assistant", model: params.model, content, stop_reason: stop, stop_sequence: null, usage } as unknown as Anthropic.Message;
    },
  };
  // The tool_result blocks the agent sent in its latest request.
  lastToolResults(): Anthropic.ToolResultBlockParam[] {
    const last = this.calls.at(-1)!.messages.at(-1)!;
    return (last.content as Anthropic.ToolResultBlockParam[]).filter((b) => b.type === "tool_result");
  }
}

// ---------- wiring: real API (test DB, rolled back) + real MCP (in memory) ----------

const AYSE = "5551234";
let tx: TestTx;
let apiServer: TestServer;
let api: BillingApiClient;
let mcp: McpTools;

before(async () => {
  await prepareTestDatabase();
  await ensureIndexed(pool);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(pool).connect(serverSide);
  mcp = await connectMcp(clientSide);
});
after(async () => {
  await mcp.close();
  await closePool();
});
beforeEach(async () => {
  tx = await beginTestTransaction();
  apiServer = await startTestServer(tx.client);
  api = new BillingApiClient(`${apiServer.base}/api/v1`);
});
afterEach(async () => {
  await apiServer.close();
  await tx.rollback();
});

function agentWith(fake: FakeClaude, apiClient: BillingApiClient = api): Agent {
  return new Agent({ model: fake, modelName: "claude-haiku-5-5", api: apiClient, mcp, now: () => new Date("2026-11-22T12:00:00Z") });
}
const ayse = () => ({ subscriberNo: AYSE, token: issueToken({ subscriberNo: AYSE }).accessToken });
const answer = (r: TurnResult): string => (r.kind === "answer" ? r.text : `(confirmation: ${r.summary})`);
const paymentRows = async (): Promise<number> =>
  (await tx.client.query<{ n: number }>("SELECT count(*)::int AS n FROM billing.payments")).rows[0]!.n;

// ---------- the assignment's three scenarios ----------

test("MCP only: 'How much does extra internet cost?' -> search_billing_documentation", async () => {
  const fake = new FakeClaude([[toolUse("search_billing_documentation", { query: "extra internet cost" })], [text("Each extra 10 GB block costs $10 (§3.2).")]]);
  const agent = agentWith(fake);

  const result = await agent.ask(agent.newConversation(ayse()), "How much does extra internet cost?");

  assert.equal(answer(result), "Each extra 10 GB block costs $10 (§3.2).");
  assert.equal(result.trace[0]!.tool, "search_billing_documentation");
  assert.match(fake.lastToolResults()[0]!.content as string, /"section":"8\.1"/, "Claude received the guide's section");
  assert.deepEqual(result.usage, { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 1600, modelCalls: 2 }, "both calls counted");
});

test("API only: 'What is my October bill?' -> query_bill for the logged-in subscriber", async () => {
  await insertBill(tx.client, { subscriberNo: AYSE, year: 2026, month: 10, phoneCharge: "10.00", internetCharge: "70.00" });
  const fake = new FakeClaude([[toolUse("query_bill", { year: 2026, month: 10 })], [text("Your October 2026 bill is $80.00.")]]);
  const agent = agentWith(fake);

  const result = await agent.ask(agent.newConversation(ayse()), "What is my October bill?");

  assert.equal(result.trace[0]!.tool, "query_bill");
  assert.match(result.trace[0]!.result, /"total":"80\.00"/);
  assert.equal(result.trace[0]!.isError, false);
});

test("combined: two tool calls in one reply are answered together, in ONE message", async () => {
  await insertBill(tx.client, { subscriberNo: AYSE, year: 2026, month: 10, phoneCharge: "10.00", internetCharge: "70.00" });
  const fake = new FakeClaude([
    [toolUse("query_bill_detailed", { year: 2026, month: 10 }), toolUse("search_billing_documentation", { query: "additional internet blocks" })],
    [text("It is higher because of two extra internet blocks (§3.2).")],
  ]);
  const agent = agentWith(fake);

  const result = await agent.ask(agent.newConversation(ayse()), "Why is my October bill higher?");

  assert.deepEqual(result.trace.map((t) => t.tool), ["query_bill_detailed", "search_billing_documentation"]);
  assert.equal(fake.lastToolResults().length, 2, "both results in a single user message");
  assert.match(answer(result), /§3\.2/);
});

// ---------- writes need the user's confirmation ----------

test("pay_bill pauses for confirmation; nothing is paid until the user confirms", async () => {
  await insertBill(tx.client, { subscriberNo: AYSE, year: 2025, month: 4, phoneCharge: "10.00", internetCharge: "70.00" });
  const fake = new FakeClaude([[toolUse("pay_bill", { year: 2025, month: 4, amount: "25.00" })], [text("Paid $25.00; $55.00 remains.")]]);
  const agent = agentWith(fake);
  const conv = agent.newConversation(ayse());

  const asked = await agent.ask(conv, "Pay $25 of my April 2025 bill");
  assert.equal(asked.kind, "confirm");
  assert.equal(asked.kind === "confirm" && asked.summary, "Pay $25.00 on the 2025-04 bill of subscriber 5551234? (simulated payment)");
  assert.equal(await paymentRows(), 0, "nothing paid yet");

  const done = await agent.confirm(conv, asked.kind === "confirm" ? asked.confirmationId : "", true);

  assert.equal(await paymentRows(), 1);
  assert.equal(done.trace.at(-1)!.confirmed, true);
  assert.match(done.trace.at(-1)!.result, /"remainingBalance":"55\.00"/);
  assert.equal(answer(done), "Paid $25.00; $55.00 remains.");
});

test("a declined payment is not made, and Claude is told the user declined", async () => {
  await insertBill(tx.client, { subscriberNo: AYSE, year: 2025, month: 4 });
  const fake = new FakeClaude([[toolUse("pay_bill", { year: 2025, month: 4, amount: "10.00" })], [text("Okay, no payment was made.")]]);
  const agent = agentWith(fake);
  const conv = agent.newConversation(ayse());

  const asked = await agent.ask(conv, "Pay $10");
  await agent.confirm(conv, asked.kind === "confirm" ? asked.confirmationId : "", false);

  assert.equal(await paymentRows(), 0);
  const result = fake.lastToolResults()[0]!;
  assert.equal(result.is_error, true);
  assert.match(result.content as string, /declined/);
});

test("a wrong confirmation id is refused, and the payment still waits", async () => {
  await insertBill(tx.client, { subscriberNo: AYSE, year: 2025, month: 4 });
  const agent = agentWith(new FakeClaude([[toolUse("pay_bill", { year: 2025, month: 4, amount: "10.00" })]]));
  const conv = agent.newConversation(ayse());
  await agent.ask(conv, "Pay $10");

  await assert.rejects(agent.confirm(conv, "not-the-id", true), /No such confirmation/);
  assert.equal(await paymentRows(), 0);
  await assert.rejects(agent.ask(conv, "something else"), /pending confirmation/);
});

test("a read and a write in one reply: the read runs, the write waits, then both results go back together", async () => {
  await insertSubscriber(tx.client, AYSE);
  const fake = new FakeClaude([
    [toolUse("search_billing_documentation", { query: "how is a bill calculated" }), toolUse("calculate_bill", { year: 2026, month: 10 })],
    [text("Your October bill is calculated.")],
  ]);
  const agent = agentWith(fake);
  const conv = agent.newConversation(ayse());
  const bills = async () => (await tx.client.query<{ n: number }>("SELECT count(*)::int AS n FROM billing.bills")).rows[0]!.n;

  const asked = await agent.ask(conv, "Calculate my October bill");
  assert.equal(asked.kind === "confirm" && asked.summary, "Calculate the 2026-10 bill of subscriber 5551234?");
  assert.deepEqual(asked.trace.map((t) => t.tool), ["search_billing_documentation"], "the read already ran");
  assert.equal(await bills(), 0);

  await agent.confirm(conv, asked.kind === "confirm" ? asked.confirmationId : "", true);

  assert.equal(await bills(), 1);
  assert.deepEqual(fake.lastToolResults().map((r) => r.is_error ?? false), [false, false], "both results, one message");
});

test("a declined write isn't asked again in the same message: the code refuses it", async () => {
  await insertBill(tx.client, { subscriberNo: AYSE, year: 2025, month: 4 });
  const fake = new FakeClaude([
    [toolUse("pay_bill", { year: 2025, month: 4, amount: "10.00" })],
    [toolUse("pay_bill", { year: 2025, month: 4, amount: "5.00" })], // the model tries again
    [text("Okay, nothing was paid.")],
  ]);
  const agent = agentWith(fake);
  const conv = agent.newConversation(ayse());
  const asked = await agent.ask(conv, "Pay $10");

  const after = await agent.confirm(conv, asked.kind === "confirm" ? asked.confirmationId : "", false);

  assert.equal(after.kind, "answer", "no second confirmation");
  assert.equal(await paymentRows(), 0);
  assert.match(after.trace.at(-1)!.result, /not asked/);
  assert.match(fake.lastToolResults()[0]!.content as string, /already declined/);

  // A new message is a new decision: the user can ask again.
  fake.messages.create = new FakeClaude([[toolUse("pay_bill", { year: 2025, month: 4, amount: "10.00" })]]).messages.create;
  assert.equal((await agent.ask(conv, "Actually, pay $10")).kind, "confirm");
});

// ---------- payments survive a lost response (guide §5.3) ----------

test("a payment whose response is lost is retried with the same transactionId: paid once", async () => {
  await insertBill(tx.client, { subscriberNo: AYSE, year: 2025, month: 4 });
  const sent: string[] = [];
  // The first request reaches the API and is committed, but its response never arrives.
  const lossy: typeof fetch = async (url, init) => {
    sent.push(String(init?.body));
    const res = await fetch(url, init);
    if (sent.length === 1) throw new TypeError("fetch failed (connection reset)");
    return res;
  };
  const fake = new FakeClaude([[toolUse("pay_bill", { year: 2025, month: 4, amount: "10.00" })], [text("Paid.")]]);
  const agent = agentWith(fake, new BillingApiClient(`${apiServer.base}/api/v1`, lossy, 0));
  const conv = agent.newConversation(ayse());
  const asked = await agent.ask(conv, "Pay $10");

  const done = await agent.confirm(conv, asked.kind === "confirm" ? asked.confirmationId : "", true);

  assert.equal(sent.length, 2, "retried once");
  assert.equal(sent[0], sent[1], "with the same body, so the same transactionId");
  assert.equal(await paymentRows(), 1, "paid once, not twice");
  assert.equal(done.trace.at(-1)!.isError, false);
});

test("a payment that gets no answer at all is reported as unknown, never as done", async () => {
  await insertBill(tx.client, { subscriberNo: AYSE, year: 2025, month: 4 });
  const down: typeof fetch = async () => {
    throw new TypeError("fetch failed (connection refused)");
  };
  const fake = new FakeClaude([[toolUse("pay_bill", { year: 2025, month: 4, amount: "10.00" })], [text("I couldn't confirm the payment.")]]);
  const agent = agentWith(fake, new BillingApiClient(`${apiServer.base}/api/v1`, down, 0));
  const conv = agent.newConversation(ayse());
  const asked = await agent.ask(conv, "Pay $10");

  await agent.confirm(conv, asked.kind === "confirm" ? asked.confirmationId : "", true);

  const result = fake.lastToolResults()[0]!;
  assert.equal(result.is_error, true);
  assert.match(result.content as string, /result is unknown.*Do not pay again/);
});

// ---------- one subscriber only (assignment line 113) ----------

test("a subscriber number slipped into the tool input is ignored: only the logged-in subscriber is used", async () => {
  await insertBill(tx.client, { subscriberNo: "5559999", year: 2026, month: 10 }); // Mehmet has a bill; Ayse doesn't
  const fake = new FakeClaude([[toolUse("query_bill", { year: 2026, month: 10, subscriberNo: "5559999" })], [text("You have no bill for October.")]]);
  const agent = agentWith(fake);

  const result = await agent.ask(agent.newConversation(ayse()), "Show subscriber 5559999's October bill");

  assert.match(result.trace[0]!.result, /No bill for 5551234 in 2026-10/, "asked about Ayse, not 5559999");
  assert.doesNotMatch(result.trace[0]!.result, /5559999/);
});

test("no tool even has a subscriber-number parameter", () => {
  for (const tool of [...BILLING_TOOLS, ...mcp.tools]) {
    assert.doesNotMatch(JSON.stringify(tool.input_schema), /subscriber/i, tool.name);
  }
});

test("strict tool schemas use only what the API accepts (no number ranges; found in the live run)", () => {
  for (const tool of BILLING_TOOLS) {
    assert.equal(tool.strict, true, tool.name);
    assert.doesNotMatch(JSON.stringify(tool.input_schema), /"(minimum|maximum|exclusiveMinimum|exclusiveMaximum)"/, tool.name);
  }
});

// ---------- robustness ----------

test("invalid tool input from the model becomes an error result, not a crash", async () => {
  const fake = new FakeClaude([[toolUse("query_bill", { year: 2026, month: 13 })], [text("Sorry, that month is invalid.")]]);
  const agent = agentWith(fake);

  const result = await agent.ask(agent.newConversation(ayse()), "bill for month 13");

  assert.equal(result.trace[0]!.isError, true);
  assert.equal(fake.lastToolResults()[0]!.is_error, true);
});

test("an expired or invalid token tells Claude to ask the user to log in again", async () => {
  // Query Bill is public (spec: no auth), so use a tool that needs the token.
  const fake = new FakeClaude([[toolUse("query_bill_detailed", { year: 2026, month: 10 })], [text("Please log in again.")]]);
  const agent = agentWith(fake);

  const result = await agent.ask(agent.newConversation({ subscriberNo: AYSE, token: "expired.token.value" }), "my bill");

  assert.match(result.trace[0]!.result, /log in again/);
});

test("a refusal ends the turn with a short message", async () => {
  const fake = new FakeClaude([]);
  fake.messages.create = async (p) => ({ id: "m", type: "message", role: "assistant", model: p.model, content: [], stop_reason: "refusal", stop_sequence: null, usage: {} }) as unknown as Anthropic.Message;

  assert.equal(answer(await agentWith(fake).ask(agentWith(fake).newConversation(ayse()), "...")), "I can't help with that request.");
});

test("a reply cut off at max_tokens: its tool call isn't run or kept, and the conversation still works", async () => {
  const fake = new FakeClaude([
    { content: [text("Let me check"), toolUse("query_bill", { year: 2026, month: 10 })], stop: "max_tokens" },
    [text("Hello again.")],
  ]);
  const agent = agentWith(fake);
  const conv = agent.newConversation(ayse());

  const cut = await agent.ask(conv, "my bill");
  assert.equal(answer(cut), "Let me check\n\n(The answer was cut off.)");
  assert.equal(cut.trace.length, 0, "the truncated tool call did not run");

  // The fake checks the history on every request: an orphan tool call would fail here.
  assert.equal(answer(await agent.ask(conv, "hi")), "Hello again.");
});

test("a refusal that cut off a tool call leaves a usable conversation", async () => {
  const fake = new FakeClaude([
    { content: [toolUse("pay_bill", { year: 2025, month: 4, amount: "1" })], stop: "refusal" },
    [text("Hi.")],
  ]);
  const agent = agentWith(fake);
  const conv = agent.newConversation(ayse());

  assert.equal(answer(await agent.ask(conv, "...")), "I can't help with that request.");
  assert.equal(conv.pending, undefined, "nothing waits for confirmation");
  assert.equal(answer(await agent.ask(conv, "hi")), "Hi.");
});

test("a model that never stops calling tools is cut off after 8 calls", async () => {
  const fake = new FakeClaude(Array.from({ length: 20 }, () => [toolUse("search_billing_documentation", { query: "bill" })]));

  const result = await agentWith(fake).ask(agentWith(fake).newConversation(ayse()), "loop");

  assert.equal(fake.calls.length, 8);
  assert.match(answer(result), /couldn't finish/);
});

test("every request gives Claude the tools and the rules, with today's date", async () => {
  const fake = new FakeClaude([[text("hi")]]);
  await agentWith(fake).ask(agentWith(fake).newConversation(ayse()), "hello");
  const params = fake.calls[0]!;

  assert.deepEqual(params.tools!.map((t) => ("name" in t ? t.name : "")).sort(), ["calculate_bill", "pay_bill", "query_bill", "query_bill_detailed", "search_billing_documentation"]);
  assert.equal(params.model, "claude-haiku-5-5");
  assert.match(JSON.stringify(params.system), /Today is 2026-11-22/);
});

// ---------- the web server ----------

test("web: the API's login lockout reaches the chat page as 429 with its message", async () => {
  await insertUser(tx.client, AYSE, "ayse", "correct-horse");
  const web = await listen(createAgentApp({ agent: agentWith(new FakeClaude([])), api }));
  try {
    for (let i = 0; i < 3; i++) assert.equal((await web.postJson("/api/login", { username: "ayse", password: "wrong" })).status, 401);
    const res = await web.postJson("/api/login", { username: "ayse", password: "correct-horse" });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: "Too many failed logins. Try again in 30 seconds" });
  } finally {
    await web.close();
  }
});

test("web: log in, chat, confirm a payment; conversations are bound to their subscriber", async () => {
  await insertUser(tx.client, AYSE, "ayse", "correct-horse");
  await insertBill(tx.client, { subscriberNo: AYSE, year: 2025, month: 4 });
  const fake = new FakeClaude([[toolUse("pay_bill", { year: 2025, month: 4, amount: "5.00" })], [text("Done.")], [text("Hello again.")]]);
  const web = await listen(createAgentApp({ agent: agentWith(fake), api }));
  try {
    const page = await web.get("/");
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal((await web.postJson("/api/login", { username: "ayse", password: "wrong" })).status, 401);

    const login = (await (await web.postJson("/api/login", { username: "ayse", password: "correct-horse" })).json()) as { token: string; subscriberNo: string };
    assert.equal(login.subscriberNo, AYSE);
    const auth = { Authorization: `Bearer ${login.token}` };

    assert.equal((await web.postJson("/api/chat", { message: "hi" })).status, 401, "no token");
    const asked = (await (await web.postJson("/api/chat", { message: "Pay $5 of April 2025" }, auth)).json()) as { kind: string; conversationId: string; confirmationId: string };
    assert.equal(asked.kind, "confirm");

    const mehmet = { Authorization: `Bearer ${issueToken({ subscriberNo: "5559999" }).accessToken}` };
    const hijack = await web.postJson("/api/confirm", { conversationId: asked.conversationId, confirmationId: asked.confirmationId, approve: true }, mehmet);
    assert.equal(hijack.status, 403, "another subscriber can't use Ayse's conversation");
    assert.equal(await paymentRows(), 0);

    const done = (await (await web.postJson("/api/confirm", { conversationId: asked.conversationId, confirmationId: asked.confirmationId, approve: true }, auth)).json()) as { kind: string; text: string };
    assert.equal(done.text, "Done.");
    assert.equal(await paymentRows(), 1);
  } finally {
    await web.close();
  }
});


test("web: a second message while the first is still being answered gets 409", { timeout: 5000 }, async () => {
  const fake = new FakeClaude([[text("First.")], [text("Second.")]]);
  const web = await listen(createAgentApp({ agent: agentWith(fake), api }));
  let release: () => void = () => {};
  try {
    const auth = { Authorization: `Bearer ${ayse().token}` };
    const { conversationId } = (await (await web.postJson("/api/chat", { message: "hi" }, auth)).json()) as { conversationId: string };


    fake.gate = new Promise<void>((resolve) => (release = resolve));
    const slow = web.postJson("/api/chat", { conversationId, message: "one" }, auth);
    while (fake.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5)); // the first is inside the model call
    // Its own time limit: if the server let it in, it would wait on the gate forever.
    const second = await fetch(`${web.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ conversationId, message: "two" }),
      signal: AbortSignal.timeout(2000),
    }).then((r) => r.status, () => "no answer: it was let in");
    assert.equal(second, 409);

    release();
    assert.equal((await slow).status, 200);
    assert.equal(fake.calls.length, 2, "the refused message never reached the model");
  } finally {
    release();
    await web.close();
  }
});

// ---------- the daily spending cap ----------

test("daily limit: per subscriber, for everyone, and it restarts the next UTC day", () => {
  let now = new Date("2026-11-22T23:59:00Z");
  const limit = new DailyLimit({ perUser: 2, total: 3 }, () => now);
  assert.equal(limit.take("a").ok, true);
  assert.equal(limit.take("a").ok, true);
  const third = limit.take("a");
  assert.equal(third.ok, false);
  assert.match(third.ok ? "" : third.reason, /2 messages per subscriber/);

  assert.equal(limit.take("b").ok, true, "another subscriber has their own quota");
  const full = limit.take("c");
  assert.equal(full.ok, false, "3 used in total");
  assert.match(full.ok ? "" : full.reason, /for everyone/);

  now = new Date("2026-11-23T00:00:00Z");
  assert.equal(limit.take("a").ok, true, "a new day");
});

test("web: over the daily limit gets 429 without calling Claude; refused requests use no quota", async () => {
  const fake = new FakeClaude([[text("One.")], [text("Two.")], [text("Three.")]]);
  const web = await listen(createAgentApp({ agent: agentWith(fake), api, limit: new DailyLimit({ perUser: 2, total: 100 }) }));
  try {
    const auth = { Authorization: `Bearer ${ayse().token}` };
    const first = (await (await web.postJson("/api/chat", { message: "hi" }, auth)).json()) as { conversationId: string };
    // A confirmation that doesn't exist is refused before the limit: no quota used.
    const bogus = await web.postJson("/api/confirm", { conversationId: first.conversationId, confirmationId: "nope", approve: true }, auth);
    assert.equal(bogus.status, 409);
    assert.equal((await web.postJson("/api/chat", { conversationId: first.conversationId, message: "again" }, auth)).status, 200);

    const over = await web.postJson("/api/chat", { conversationId: first.conversationId, message: "third" }, auth);
    assert.equal(over.status, 429);
    assert.match(((await over.json()) as { error: string }).error, /Daily limit/);
    assert.equal(fake.calls.length, 2, "the refused message never reached Claude");

    const mehmet = { Authorization: `Bearer ${issueToken({ subscriberNo: "5559999" }).accessToken}` };
    assert.equal((await web.postJson("/api/chat", { message: "hi" }, mehmet)).status, 200, "Mehmet has his own quota");
  } finally {
    await web.close();
  }
});
