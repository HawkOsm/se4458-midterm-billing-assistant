// The MCP server (like the teacher's MCP/index.ts): one tool, search_billing_documentation.
// Shared by both ways to reach it: stdio.ts (a child process) and http.ts (a web service).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "../db/db";
import { searchDocumentation } from "./docsService";

const Match = z.object({
  document: z.string().describe("File name, e.g. Mobile_Provider_Billing_Guide.md"),
  documentId: z.string().describe("e.g. MOB-BILLING-2026-01"),
  section: z.string().describe("Section number to cite, e.g. 3.2"),
  heading: z.string(),
  text: z.string(),
});

export function createMcpServer(db: Db): McpServer {
  const server = new McpServer({ name: "billing-docs", version: "1.0.0" });

  server.registerTool(
    "search_billing_documentation",
    {
      title: "Search the billing guide",
      description:
        "Search the Mobile Provider Billing Guide (policies: pricing, allowances, billing cycles, " +
        "partial payments, due dates, late payments, disputes). Returns the best-matching sections " +
        "with section number, heading, document ID and text. Cite the section numbers in answers. " +
        "Policy text only: it has no subscriber's usage, bills or payments (use the billing API).",
      inputSchema: {
        query: z.string().trim().min(1).max(500).describe("What to look for, e.g. 'extra internet cost'"),
        limit: z.number().int().min(1).max(10).default(3).describe("How many sections to return (1-10)"),
      },
      outputSchema: { query: z.string(), matches: z.array(Match), note: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const result = await searchDocumentation(db, query, limit);
      return {
        // Both forms: text for any client, structured data for clients that read it.
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
      };
    },
  );

  return server;
}
