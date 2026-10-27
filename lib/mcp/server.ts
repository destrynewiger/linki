import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  getOutreachStatus,
  OutreachStatusSchema,
  stageProspects,
  StageProspectsInputSchema,
  StageProspectsOutputSchema,
} from "@/lib/mcp/outreach";

const EmptyInputSchema = z.object({}).strict();

export function createLinkiMcpServer(): McpServer {
  const server = new McpServer({
    name: "linki-mcp-server",
    version: "0.1.0",
  });

  server.registerTool(
    "get_outreach_status",
    {
      title: "Get Linki outreach status",
      description: "Read the configured account, workflow, daily capacity, and staging state without changing Linki data.",
      inputSchema: EmptyInputSchema,
      outputSchema: OutreachStatusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const status = getOutreachStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
      };
    },
  );

  server.registerTool(
    "stage_prospects",
    {
      title: "Stage reviewed prospects",
      description: "Stage reviewed prospects in the configured paused Linki workflow. This tool never starts a run or sends outreach.",
      inputSchema: StageProspectsInputSchema,
      outputSchema: StageProspectsOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = stageProspects(input);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: error instanceof Error ? error.message : "Unable to stage prospects.",
          }],
        };
      }
    },
  );

  return server;
}
