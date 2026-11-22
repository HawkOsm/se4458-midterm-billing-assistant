import { z } from "zod";

// Typed settings read once from environment variables (see .env.example).
// A missing or malformed value stops the app at startup instead of failing later.
// Locally they come from .env; on AWS, ECS injects them (secrets from Secrets Manager).

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

// .env.example ships a PUBLIC signing key with this prefix, so `cp .env.example .env`
// works out of the box. Anyone can read it, so anyone could forge tokens with it:
// it is only accepted while the database is local (laptop + demo data).
export const PUBLIC_DEV_SECRET_PREFIX = "local-dev-only-";

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  POSTGRES_HOST: z.string().default("127.0.0.1"),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().default("billing"),
  POSTGRES_USER: z.string().default("billing"),
  POSTGRES_PASSWORD: z.string().default(""),
  // RDS requires TLS; the local Docker Postgres does not offer it.
  POSTGRES_SSL: z.stringbool().default(false),
  // No default on purpose: without a secret the app must not start (a guessable or
  // committed key lets anyone forge tokens). 32+ chars = 256 bits for HS256.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("billing-api"),
  JWT_AUDIENCE: z.string().default("billing-assistant"),
  // 15 minutes, like the teacher's LoginController.
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(900),
});

export type Config = z.infer<typeof Env>;

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = Env.parse(env);
  if (parsed.JWT_SECRET.startsWith(PUBLIC_DEV_SECRET_PREFIX) && !isLocalHost(parsed.POSTGRES_HOST)) {
    throw new Error(
      `Refusing to start: JWT_SECRET is the public development key from .env.example, ` +
        `but the database (${parsed.POSTGRES_HOST}) is not local. Set a private random JWT_SECRET.`,
    );
  }
  return parsed;
}

export const config: Config = parseConfig(process.env);
