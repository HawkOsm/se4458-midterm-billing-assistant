import { z } from "zod";

// Typed settings from environment variables (see .env.example). A missing or malformed
// value stops a service at startup instead of failing later. Locally they come from .env;
// on AWS, ECS injects them (secrets from Secrets Manager).
//
// Each service reads only what it needs, so it can be given only the secrets it uses:
//   dbConfig     database settings, no secrets beyond the DB password (every service)
//   apiConfig()  + PORT and the JWT signing key (the billing API only)
//   mcpConfig()  + MCP_PORT (the MCP server only; it never sees the JWT key)

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
});

const McpEnv = DbEnv.extend({
  MCP_PORT: z.coerce.number().int().positive().default(4000),
});

export type DbConfig = z.infer<typeof DbEnv>;
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
  return parsed;
}

export const dbConfig: DbConfig = parseDbConfig(process.env);

let api: Config | undefined;
let mcp: McpConfig | undefined;

// Read on first use and then kept: only the API needs (and gets) the JWT settings.
export function apiConfig(): Config {
  api ??= parseConfig(process.env);
  return api;
}

export function mcpConfig(): McpConfig {
  mcp ??= McpEnv.parse(process.env);
  return mcp;
}
