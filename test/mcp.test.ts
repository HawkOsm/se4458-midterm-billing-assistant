// The MCP server: guide parsing, the index (built once, rebuilt only on change), ranked
// search, and real MCP clients over both transports (stdio and Streamable HTTP).
import "./testEnv";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pool } from "../src/db/db";
import { GUIDE_PATH, ensureIndexed, searchDocumentation, searchTerms } from "../src/mcp/docsService";
import { parseGuide } from "../src/mcp/guideParser";
import { createMcpHttpApp } from "../src/mcp/http";
import { beginTestTransaction, closePool, prepareTestDatabase, type TestTx } from "./helpers";

interface SearchOutput {
  query: string;
  matches: { document: string; documentId: string; section: string; heading: string; text: string }[];
  note: string;
}

const ROOT = path.join(__dirname, "..");
const GUIDE = readFileSync(GUIDE_PATH, "utf8");

before(async () => {
  await prepareTestDatabase();
  await ensureIndexed(pool); // committed, like a real server start (rebuilds only on change)
});
after(closePool);

const sections = async (query: string, limit = 3): Promise<string[]> =>
  (await searchDocumentation(pool, query, limit)).matches.map((m) => m.section);

// ---------- parsing ----------

test("the guide splits into one chunk per numbered section (25), title block excluded", () => {
  const guide = parseGuide(GUIDE);

  assert.equal(guide.documentId, "MOB-BILLING-2026-01");
  assert.equal(guide.version, "1.0");
  assert.deepEqual(
    guide.chunks.map((c) => c.section),
    ["1", "2.1", "2.2", "2.3", "3.1", "3.2", "3.3", "4.1", "4.2", "4.3", "4.4", "5.1", "5.2", "5.3",
     "6.1", "6.2", "6.3", "7.1", "7.2", "7.3", "8.1", "8.2", "8.3", "8.4", "9"],
  );
  assert.equal(guide.chunks.find((c) => c.section === "3.2")?.heading, "Additional internet blocks");
  assert.ok(guide.chunks.every((c) => !c.text.includes("Fictitious teaching document")), "no title block");
});

test("a file without the expected structure is refused, not half-indexed", () => {
  assert.throws(() => parseGuide("just text"), /no "# Title"/);
  assert.throws(() => parseGuide("# T\n\n**Document ID:** X\n**Version:** 1\n\ntext only"), /no "## N\." or "### N\.M"/);
});

// ---------- the index ----------

let tx: TestTx;
let dir: string;
beforeEach(async () => {
  tx = await beginTestTransaction();
  dir = mkdtempSync(path.join(tmpdir(), "guide-"));
});
afterEach(async () => {
  await tx.rollback(); // undoes any index change a test made
  rmSync(dir, { recursive: true, force: true });
});

test("the index is built once and reused until the file changes; stale sections go away", async () => {
  const file = path.join(dir, "guide.md");
  writeFileSync(file, GUIDE);
  await tx.client.query("DELETE FROM docs.documents");

  const first = await ensureIndexed(tx.client, file);
  const again = await ensureIndexed(tx.client, file);
  writeFileSync(file, GUIDE.replace(/### 8\.4[\s\S]*?(?=## 9\.)/, "")); // section 8.4 removed
  const changed = await ensureIndexed(tx.client, file);

  assert.deepEqual([first.rebuilt, again.rebuilt, changed.rebuilt], [true, false, true]);
  assert.equal(changed.chunks, 24);
  const { rows } = await tx.client.query("SELECT section FROM docs.chunks WHERE section = '8.4'");
  assert.equal(rows.length, 0, "the removed section is gone from the index");
});

test("a parser change that cuts different chunks rebuilds, without touching the file", async () => {
  const file = path.join(dir, "guide.md");
  writeFileSync(file, GUIDE);
  await tx.client.query("DELETE FROM docs.documents");
  const withoutLast = (source: string): ReturnType<typeof parseGuide> => {
    const guide = parseGuide(source);
    return { ...guide, chunks: guide.chunks.slice(0, -1) }; // a "new chunker" that drops §9
  };
  const sameOutput = (source: string): ReturnType<typeof parseGuide> => parseGuide(source);

  const first = await ensureIndexed(tx.client, file);
  const newChunker = await ensureIndexed(tx.client, file, withoutLast);
  const back = await ensureIndexed(tx.client, file);
  const sameChunks = await ensureIndexed(tx.client, file, sameOutput);

  assert.deepEqual([first.rebuilt, newChunker.rebuilt, back.rebuilt, sameChunks.rebuilt], [true, true, true, false]);
  assert.equal(newChunker.chunks, 24);
});

// ---------- search: three distinct retrievals (assignment) and more ----------

test("retrieval 1, pricing: 'How much does extra internet cost?' finds 8.1 and 3.2", async () => {
  const found = await sections("How much does extra internet cost?");

  assert.equal(found[0], "8.1");
  assert.ok(found.includes("3.2"));
});

test("retrieval 2, payments: 'Can I pay only part of my bill?' finds 8.3 first", async () => {
  assert.equal((await sections("Can I pay only part of my bill?"))[0], "8.3");
});

test("retrieval 3, late payment: a due-date question finds 6.1 and 6.2", async () => {
  const found = await sections("When is my bill due and what happens if I pay late?");

  assert.ok(found.includes("6.1") && found.includes("6.2"), found.join(","));
});

test("disputes: 'How do I dispute a charge?' finds 8.4 first and the 7.1 window", async () => {
  const found = await sections("How do I dispute a charge?");

  assert.equal(found[0], "8.4");
  assert.ok(found.includes("7.1"));
});

test("a common word doesn't outrank the specific answer ('Why is my bill higher?' -> 8.2)", async () => {
  assert.equal((await sections("Why is my bill higher this month?"))[0], "8.2");
});

test("results carry what the guide's §9 asks to cite: document, document ID, section, heading, text", async () => {
  const result = await searchDocumentation(pool, "extra internet", 1);

  assert.deepEqual(Object.keys(result.matches[0]!).sort(), ["document", "documentId", "heading", "section", "text"]);
  assert.equal(result.matches[0]!.document, "Mobile_Provider_Billing_Guide.md");
  assert.equal(result.matches[0]!.documentId, "MOB-BILLING-2026-01");
});

test("hostile or empty-meaning queries return no matches instead of failing", async () => {
  for (const q of ['" OR * ) -- ; DROP TABLE docs.chunks;', "the and of", "!!!", "x".repeat(500)]) {
    const result = await searchDocumentation(pool, q, 3);
    assert.deepEqual(result.matches, [], q.slice(0, 20));
    assert.match(result.note, /No matching section/);
  }
  assert.deepEqual(searchTerms("Bill's DUE-date?"), ["bill", "s", "due", "date"]);
});

test("limit caps the number of sections", async () => {
  assert.equal((await sections("bill", 5)).length, 5);
  assert.equal((await sections("bill", 1)).length, 1);
});

// ---------- real MCP clients ----------

async function exerciseClient(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["search_billing_documentation"]);
  assert.deepEqual(tools[0]!.inputSchema.required, ["query"]);

  const result = await client.callTool({ name: "search_billing_documentation", arguments: { query: "extra internet cost", limit: 2 } });
  const out = result.structuredContent as unknown as SearchOutput;
  assert.equal(out.matches.length, 2);
  assert.equal(out.matches[0]!.section, "8.1");
  assert.deepEqual(JSON.parse((result.content as { text: string }[])[0]!.text), out, "text and structured forms agree");

  const invalid = await client.callTool({ name: "search_billing_documentation", arguments: { query: "   " } });
  assert.equal(invalid.isError, true, "an empty query is refused by the tool's schema");
}

test("over stdio, started like an agent would, WITHOUT the API's JWT secret", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== "JWT_SECRET"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/stdio.ts"],
    cwd: ROOT,
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    await exerciseClient(client);
  } finally {
    await client.close();
  }
});

test("over Streamable HTTP (the deployable service), stateless", async () => {
  const server = createMcpHttpApp(pool).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Client({ name: "http-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    await exerciseClient(client);

    // Stateless: no session is created, so any instance can answer any request.
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }),
    });
    assert.equal(init.status, 200);
    assert.equal(init.headers.get("mcp-session-id"), null);

    // A browser's GET gets a description; an MCP client's GET (event stream) and DELETE get 405.
    const info = await fetch(`${base}/mcp`, { headers: { Accept: "text/html,*/*" } });
    assert.equal(info.status, 200);
    assert.deepEqual(((await info.json()) as { name: string; tools: string[] }).tools, ["search_billing_documentation"]);
    assert.equal((await fetch(`${base}/mcp`, { headers: { Accept: "text/event-stream" } })).status, 405);
    assert.equal((await fetch(`${base}/mcp`, { method: "DELETE" })).status, 405);
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: "ok" });
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
