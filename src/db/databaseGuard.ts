// Asks the connected database whether it is Amazon RDS. Settings alone can't tell:
// POSTGRES_HOST=127.0.0.1 may be a tunnel to RDS. RDS has an `rds.extensions` setting
// (AWS docs: "SHOW rds.extensions;"); plain PostgreSQL, like our Docker one, has none,
// so current_setting(..., true) returns NULL there instead of failing.
import { config, usesPublicDevSecret, type Config } from "../config";
import type { Db } from "./db";

export async function isAmazonRds(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ setting: string | null }>(
    "SELECT current_setting('rds.extensions', true) AS setting",
  );
  return rows[0]?.setting != null;
}

// Called at startup, before the server accepts requests: the public dev signing key
// must never protect an RDS database, however the connection got there.
export async function assertSafeSigningKey(db: Db, cfg: Config = config): Promise<void> {
  if (usesPublicDevSecret(cfg) && (await isAmazonRds(db))) {
    throw new Error(
      "Refusing to start: JWT_SECRET is the public development key from .env.example, " +
        "but the connected database is Amazon RDS. Set a private random JWT_SECRET.",
    );
  }
}
