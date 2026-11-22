import { z } from "zod";

// Typed settings read once from environment variables (see .env.example).
// A missing or malformed value stops the app at startup instead of failing later.
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

export const config: Config = Env.parse(process.env);
