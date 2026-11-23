import { z } from "zod";

// Typed settings from environment variables (see .env.example). A missing or malformed
// value stops a service at startup instead of failing later. Locally they come from .env;
// on AWS, ECS injects them (secrets from Secrets Manager).
//
// Each service reads only what it needs, so it can be given only the secrets it uses:
//   dbConfig     database settings, no secrets beyond the DB password (every service)
//   apiConfig()  + PORT and the JWT signing key (the billing API only)
//   mcpConfig()  + MCP_PORT (the MCP server only; it never sees the JWT key)
//   agentConfig() the AI agent: API and MCP addresses, the model and the Claude key (no DB)

// Host names that mean "the Postgres on this machine": loopback, plus the names Docker
// uses (`postgres` is our compose.yaml service, for when the API itself runs in compose).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "host.docker.internal"]);

// .env.example ships a PUBLIC signing key with this prefix, so `cp .env.example .env`
// works out of the box. Anyone can read it, so anyone could forge tokens with it:
// it is only accepted while the database is local (laptop + demo data).
export const PUBLIC_DEV_SECRET_PREFIX = "local-dev-only-";

const DbEnv = z.object({
  // ECS sets production; everything else defaults to development.
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  POSTGRES_HOST: z.string().default("127.0.0.1"),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().default("billing"),
  POSTGRES_USER: z.string().default("billing"),
  POSTGRES_PASSWORD: z.string().default(""),
  // RDS requires TLS; the local Docker Postgres does not offer it.
  POSTGRES_SSL: z.stringbool().default(false),
});

const ApiEnv = DbEnv.extend({
  PORT: z.coerce.number().int().positive().default(3000),
  // No default on purpose: without a secret the API must not start (a guessable or
  // committed key lets anyone forge tokens). 32+ chars = 256 bits for HS256.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("billing-api"),
  JWT_AUDIENCE: z.string().default("billing-assistant"),
  // 15 minutes, like the teacher's LoginController.
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // On AWS: the header value the API Gateway adds (middleware/gatewayOnly.ts). Required in
  // production, so a deployment can't forget it and leave the service URL open.
  // An empty value (GATEWAY_SECRET= in .env) means not set.
  GATEWAY_SECRET: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(32, "GATEWAY_SECRET must be at least 32 characters").optional(),
  ),
});

const McpEnv = DbEnv.extend({
  MCP_PORT: z.coerce.number().int().positive().default(4000),
});

// The AI agent talks only to the billing API (via the gateway once deployed) and the MCP
// server, never to the database, so it gets neither DB nor JWT settings.
const AgentEnv = z.object({
  AGENT_PORT: z.coerce.number().int().positive().default(5000),
  API_BASE_URL: z.url().default("http://127.0.0.1:3000/api/v1"),
  MCP_URL: z.url().default("http://127.0.0.1:4000/mcp"),
  CLAUDE_MODEL: z.string().default("claude-haiku-5-5"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required for the agent"),
  // Spending cap: the demo logins are public, so anyone could run up the Claude bill.
  // Counted per UTC day: messages + confirmations per subscriber, and for everyone together.
  AGENT_DAILY_LIMIT_PER_USER: z.coerce.number().int().positive().default(40),
  AGENT_DAILY_LIMIT_TOTAL: z.coerce.number().int().positive().default(400),
});

export type DbConfig = z.infer<typeof DbEnv>;
export type AgentConfig = z.infer<typeof AgentEnv>;
export type Config = z.infer<typeof ApiEnv>;
export type McpConfig = z.infer<typeof McpEnv>;

// What the settings say about the database. Not production, no TLS (RDS requires TLS:
// rds.force_ssl defaults to on for PostgreSQL 15+), and a local host name. Settings can't
// see through a tunnel (127.0.0.1 forwarded to RDS), so db/databaseGuard.ts also asks the
// database itself after connecting.
export function isLocalDatabase(cfg: DbConfig): boolean {
  return cfg.APP_ENV !== "production" && !cfg.POSTGRES_SSL && LOCAL_HOSTS.has(cfg.POSTGRES_HOST);
}

export function usesPublicDevSecret(cfg: Config): boolean {
  return cfg.JWT_SECRET.startsWith(PUBLIC_DEV_SECRET_PREFIX);
}

export function parseDbConfig(env: NodeJS.ProcessEnv): DbConfig {
  return DbEnv.parse(env);
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = ApiEnv.parse(env);
  if (usesPublicDevSecret(parsed) && !isLocalDatabase(parsed)) {
    throw new Error(
      "Refusing to start: JWT_SECRET is the public development key from .env.example, " +
        `but this is not a local database (APP_ENV=${parsed.APP_ENV}, ` +
        `POSTGRES_HOST=${parsed.POSTGRES_HOST}, POSTGRES_SSL=${parsed.POSTGRES_SSL}). ` +
        "Set a private random JWT_SECRET.",
    );
  }
  if (parsed.APP_ENV === "production" && !parsed.GATEWAY_SECRET) {
    throw new Error("Refusing to start: GATEWAY_SECRET is required in production (the API Gateway's header).");
  }
  return parsed;
}

export const dbConfig: DbConfig = parseDbConfig(process.env);

let api: Config | undefined;
let mcp: McpConfig | undefined;
let agent: AgentConfig | undefined;

// Read on first use and then kept: only the API needs (and gets) the JWT settings.
export function apiConfig(): Config {
  api ??= parseConfig(process.env);
  return api;
}

export function mcpConfig(): McpConfig {
  mcp ??= McpEnv.parse(process.env);
  return mcp;
}

export function agentConfig(): AgentConfig {
  agent ??= AgentEnv.parse(process.env);
  return agent;
}

