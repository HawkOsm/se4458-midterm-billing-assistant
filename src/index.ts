// Entry point (like the teacher's index.js / Program.cs): start the HTTP server.
// Dev: npm run dev   Production: npm run build && npm start
import { createApp } from "./app";
import { config } from "./config";
import { assertSafeSigningKey } from "./db/databaseGuard";
import { pool } from "./db/db";

async function main(): Promise<void> {
  // Checked against the real database before any request is served.
  await assertSafeSigningKey(pool);

  const server = createApp(pool).listen(config.PORT, () => {
    console.log(`Billing API on http://localhost:${config.PORT} (Swagger: /api-docs)`);
  });

  // ECS stops a task with SIGTERM: finish open requests, then close the DB pool.
  process.on("SIGTERM", () => {
    server.close(() => void pool.end());
  });
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
