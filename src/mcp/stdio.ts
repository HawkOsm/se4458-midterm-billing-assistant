// MCP over stdio (like the teacher's example): the client starts this as a child process
// and talks over stdin/stdout. Run: npm run mcp
// stdout carries the protocol, so every log line here goes to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pool } from "../db/db";
import { ensureIndexed } from "./docsService";
import { createMcpServer } from "./server";

async function main(): Promise<void> {
  const index = await ensureIndexed(pool); // ready before the first question
  console.error(`billing-docs MCP on stdio: ${index.documentId}, ${index.chunks} sections (${index.rebuilt ? "indexed" : "index up to date"})`);
  await createMcpServer(pool).connect(new StdioServerTransport());
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
