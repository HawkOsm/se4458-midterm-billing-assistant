// MCP over Streamable HTTP: the deployable service (POST /mcp). Run: npm run mcp:http
// Stateless: every request gets its own server and transport, so any instance can answer
// any request (several ECS tasks behind a load balancer need no shared session state).
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express } from "express";
import { mcpConfig } from "../config";
import type { Db } from "../db/db";
import { pool } from "../db/db";
import { ensureIndexed } from "./docsService";
import { SEARCH_TOOL, SERVER_NAME, createMcpServer } from "./server";

export function createMcpHttpApp(db: Db): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.post("/mcp", async (req, res) => {
    const server = createMcpServer(db);
    // No sessionIdGenerator = stateless (the SDK's example writes `sessionIdGenerator:
    // undefined`; our strict tsconfig only allows leaving it out, which is the same).
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // A browser opening the address gets a short description instead of a bare error.
  // An MCP client's GET asks for an event stream (Accept: text/event-stream); that still
  // gets the 405 below, which is how the MCP specification says "no stream offered".
  app.get("/mcp", (req, res, next) => {
    if ((req.headers.accept ?? "").includes("text/event-stream")) return next();
    res.json({
      name: SERVER_NAME,
      protocol: "Model Context Protocol (MCP), Streamable HTTP, stateless",
      howToUse: "Connect an MCP client to this URL, or POST JSON-RPC here (initialize, tools/list, tools/call).",
      tools: [SEARCH_TOOL],
    });
  });

  // Stateless: there is no stream to open (GET) or session to end (DELETE).
  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "Method not allowed: use POST" });
  });

  // For the load balancer / ECS health check.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}

async function main(): Promise<void> {
  const { MCP_PORT } = mcpConfig();
  const index = await ensureIndexed(pool); // ready before the first question
  const server = createMcpHttpApp(pool).listen(MCP_PORT, () => {
    console.log(`billing-docs MCP on http://localhost:${MCP_PORT}/mcp: ${index.documentId}, ${index.chunks} sections (${index.rebuilt ? "indexed" : "index up to date"})`);
  });
  process.on("SIGTERM", () => {
    server.close(() => void pool.end());
  });
}

if (require.main === module) {
  main().catch(async (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    await pool.end();
    process.exit(1);
  });
}
