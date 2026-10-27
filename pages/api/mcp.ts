import type { NextApiRequest, NextApiResponse } from "next";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { hasValidMcpBearerToken, hasValidMcpOrigin } from "@/lib/mcp/auth";
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

  if (!hasValidMcpOrigin(req)) {
    res.status(403).json({ error: "Invalid Origin" });
    return;
  }

  // This stateless endpoint has no server-initiated events or session deletion.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const server = createLinkiMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    // Next has already consumed the request body. The SDK's Node/Hono adapter
    // attaches its drain listener too late in that case and can destroy a reused
    // socket 500 ms later. Use the web transport directly with Next's parsed body.
    const headers = new Headers();
    for (const name of ["accept", "content-type", "mcp-protocol-version", "mcp-session-id"]) {
      const value = req.headers[name];
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const request = new Request("http://localhost/api/mcp", { method: "POST", headers });
    const response = await transport.handleRequest(request, { parsedBody: req.body });
    const body = Buffer.from(await response.arrayBuffer());
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.status(response.status).end(body);
  } catch {
    // Transport errors can contain request data; do not log credentials or prospects.
    console.error("[mcp] request failed");
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
