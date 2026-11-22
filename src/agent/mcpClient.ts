// The agent's MCP client: connects to the documentation server (over Streamable HTTP by
// default; tests connect in memory) and turns its tools into tools Claude can call.
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface McpTools {
  tools: Anthropic.Tool[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export async function connectMcp(transport: Transport): Promise<McpTools> {
  const client = new Client({ name: "billing-agent", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();

  return {
    // The server's own names, descriptions and input schemas, passed through unchanged.
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    })),
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as { type: string; text?: string }[];
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return { text, isError: result.isError === true };
    },
    close: () => client.close(),
  };
}

export function httpTransport(url: string): Transport {
  return new StreamableHTTPClientTransport(new URL(url));
}
