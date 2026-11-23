// Writes the OpenAPI specification the app serves (/openapi.json) to docs/openapi.json, so
// the repository holds the spec file itself. Run: npm run openapi
// test/openapi.test.ts fails if the file is out of date, so it can't drift from the code.
// No database is needed: the document is built from the route definitions, without a query.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../src/app";
import { pool } from "../src/db/db";

export const OPENAPI_FILE = path.join(__dirname, "..", "docs", "openapi.json");

async function main(): Promise<void> {
  const server = createApp(pool).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as { port: number };
    const doc: unknown = await (await fetch(`http://127.0.0.1:${port}/openapi.json`)).json();
    writeFileSync(OPENAPI_FILE, JSON.stringify(doc, null, 2) + "\n");
    console.log(`Wrote ${path.relative(process.cwd(), OPENAPI_FILE)}`);
  } finally {
    server.close();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
