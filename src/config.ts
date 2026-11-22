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
});

export type Config = z.infer<typeof Env>;

export const config: Config = Env.parse(process.env);
