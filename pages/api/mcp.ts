import type { NextApiRequest, NextApiResponse } from "next";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hasValidMcpBearerToken } from "@/lib/mcp/auth";
import { createLinkiMcpServer } from "@/lib/mcp/server";

function unauthorized(res: NextApiResponse): void {
  res.setHeader("WWW-Authenticate", 'Bearer realm="linki-mcp"');
  res.status(401).json({ error: "Unauthorized" });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (!process.env.MCP_API_TOKEN) {
    res.status(503).json({ error: "MCP is not configured" });
    return;
  }

  if (!hasValidMcpBearerToken(req)) {
    unauthorized(res);
    return;
  }

  const server = createLinkiMcpServer();
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[mcp] request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  } finally {
    await transport.close();
    await server.close();
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: "1mb" },
  },
};
