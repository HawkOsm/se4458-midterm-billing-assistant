// The agent's web server: the chat page plus three JSON endpoints. Run: npm run agent
//   POST /api/login    username + password -> the billing API's token (through the gateway)
//   POST /api/chat     { conversationId?, message }            (Authorization: Bearer <token>)
//   POST /api/confirm  { conversationId, confirmationId, approve } (same token)
// Conversations stay on the server: if the browser sent the history, it could slip fake
// tool results to the model.
import Anthropic from "@anthropic-ai/sdk";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { agentConfig } from "../config";
import { Agent, type Conversation } from "./agent";
import { BillingApiClient } from "./billingApiClient";
import { DailyLimit } from "./dailyLimit";
import { connectMcp, httpTransport } from "./mcpClient";
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from "./page";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// The subscriber number inside a token, read WITHOUT checking the signature: the agent has
// no signing key on purpose. That's safe because the token is only ever used to call the
// billing API, which checks it on every request; a forged token gets nothing but 401s.
export function subscriberOf(token: string): string {
  const payload = token.split(".")[1];
  if (!payload) throw new HttpError(401, "Missing or malformed token");
  try {
    const sub: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).sub;
    if (typeof sub === "string" && sub !== "") return sub;
  } catch {
    // fall through
  }
  throw new HttpError(401, "Missing or malformed token");
}

function bearer(req: Request): string {
  const [scheme, token] = (req.headers.authorization ?? "").split(" ");
  if (scheme !== "Bearer" || !token) throw new HttpError(401, "Log in first");
  return token;
}

// In-memory conversations (one agent server instance), dropped after 30 idle minutes.
export class ConversationStore {
  private readonly items = new Map<string, { conv: Conversation; seen: number }>();

  constructor(
    private readonly maxIdleMs = 30 * 60_000,
    private readonly maxItems = 1000,
  ) {}

  get(id: string): Conversation | undefined {
    const item = this.items.get(id);
    if (!item || Date.now() - item.seen > this.maxIdleMs) return undefined;
    item.seen = Date.now();
    return item.conv;
  }

  add(conv: Conversation): void {
    if (this.items.size >= this.maxItems) {
      const oldest = [...this.items.entries()].sort((a, b) => a[1].seen - b[1].seen)[0];
      if (oldest) this.items.delete(oldest[0]);
    }
    this.items.set(conv.id, { conv, seen: Date.now() });
  }
}

const Login = z.object({ username: z.string().trim().min(1).max(50), password: z.string().min(1).max(200) });
const Chat = z.object({ conversationId: z.string().nullish(), message: z.string().trim().min(1).max(2000) });
const Confirm = z.object({ conversationId: z.string(), confirmationId: z.string(), approve: z.boolean() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, "Invalid request");
  return result.data;
}

// limit: the daily cap on Claude calls (dailyLimit.ts); without one, nothing is capped (tests).
export function createAgentApp(deps: { agent: Agent; api: BillingApiClient; store?: ConversationStore; limit?: DailyLimit }): Express {
  const store = deps.store ?? new ConversationStore();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20kb" }));
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.get("/", (_req, res) => void res.type("html").send(PAGE_HTML));
  app.get("/app.js", (_req, res) => void res.type("js").send(PAGE_JS));
  app.get("/app.css", (_req, res) => void res.type("css").send(PAGE_CSS));
  app.get("/health", (_req, res) => void res.json({ status: "ok" }));

  app.post("/api/login", async (req, res) => {
    const { username, password } = parse(Login, req.body);
    const out = await deps.api.login(username, password);
    if (out.status === 401) throw new HttpError(401, "Invalid username or password");
    if (out.status === 429) {
      // The API's lockout after 3 wrong passwords: pass its message ("Try again in N seconds") on.
      const message = (out.body as { error?: unknown } | null)?.error;
      throw new HttpError(429, typeof message === "string" ? message : "Too many failed logins. Try again later");
    }
    if (out.status !== 200) throw new HttpError(502, "Login failed");
    const { accessToken, expiresIn } = out.body as { accessToken: string; expiresIn: number };
    res.json({ token: accessToken, subscriberNo: subscriberOf(accessToken), expiresIn });
  });

  // A conversation belongs to the subscriber who started it; a refreshed token for the same
  // subscriber may continue it (tokens last 15 minutes).
  function conversationFor(token: string, conversationId: string | null | undefined, create: boolean): Conversation {
    const subscriberNo = subscriberOf(token);
    const existing = conversationId ? store.get(conversationId) : undefined;
    if (existing) {
      if (existing.session.subscriberNo !== subscriberNo) throw new HttpError(403, "This conversation belongs to someone else");
      existing.session.token = token;
      return existing;
    }
    if (!create) throw new HttpError(404, "Conversation not found or expired");
    const conv = deps.agent.newConversation({ subscriberNo, token });
    store.add(conv);
    return conv;
  }

  // One turn at a time per conversation: two at once (a double click, a second tab) would
  // interleave their messages and tool results in the same history.
  const running = new WeakSet<Conversation>();
  async function exclusive<T>(conv: Conversation, run: () => Promise<T>): Promise<T> {
    if (running.has(conv)) throw new HttpError(409, "Still answering the previous message");
    running.add(conv);
    try {
      return await run();
    } finally {
      running.delete(conv);
    }
  }

  // Checked last, after everything that can refuse the request, so a refused request
  // doesn't use up the subscriber's quota.
  function spend(conv: Conversation): void {
    const taken = deps.limit?.take(conv.session.subscriberNo) ?? { ok: true };
    if (!taken.ok) throw new HttpError(429, taken.reason);
  }

  app.post("/api/chat", async (req, res) => {
    const token = bearer(req);
    const { conversationId, message } = parse(Chat, req.body);
    const conv = conversationFor(token, conversationId, true);
    const result = await exclusive(conv, async () => {
      if (conv.pending) throw new HttpError(409, "Answer the pending confirmation first");
      spend(conv);
      return deps.agent.ask(conv, message);
    });
    res.json({ conversationId: conv.id, ...result });
  });

  app.post("/api/confirm", async (req, res) => {
    const token = bearer(req);
    const { conversationId, confirmationId, approve } = parse(Confirm, req.body);
    const conv = conversationFor(token, conversationId, false);
    const result = await exclusive(conv, async () => {
      if (conv.pending?.confirmationId !== confirmationId) throw new HttpError(409, "No such pending confirmation");
      spend(conv);
      return deps.agent.confirm(conv, confirmationId, approve);
    });
    res.json({ conversationId: conv.id, ...result });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof Anthropic.APIError) {
      console.error(`Claude API error ${err.status}: ${err.message}`);
      return void res.status(502).json({ error: "The assistant is unavailable right now. Please try again." });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}

async function main(): Promise<void> {
  const cfg = agentConfig();
  const mcp = await connectMcp(httpTransport(cfg.MCP_URL));
  const api = new BillingApiClient(cfg.API_BASE_URL);
  const agent = new Agent({ model: new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY }), modelName: cfg.CLAUDE_MODEL, api, mcp });
  const limit = new DailyLimit({ perUser: cfg.AGENT_DAILY_LIMIT_PER_USER, total: cfg.AGENT_DAILY_LIMIT_TOTAL });
  const server = createAgentApp({ agent, api, limit }).listen(cfg.AGENT_PORT, () => {
    console.log(`Billing assistant on http://localhost:${cfg.AGENT_PORT} (model ${cfg.CLAUDE_MODEL}; API ${cfg.API_BASE_URL}; MCP ${cfg.MCP_URL}; ` +
      `daily limit ${cfg.AGENT_DAILY_LIMIT_PER_USER}/subscriber, ${cfg.AGENT_DAILY_LIMIT_TOTAL} total)`);
  });
  // ECS stops a task with SIGTERM: finish the answers in progress, then close the MCP connection.
  process.on("SIGTERM", () => {
    server.close(() => void mcp.close());
  });
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
