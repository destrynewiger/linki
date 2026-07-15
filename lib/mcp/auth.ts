import { createHash, timingSafeEqual } from "node:crypto";
import type { NextApiRequest } from "next";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function hasValidMcpBearerToken(req: NextApiRequest): boolean {
  const expected = process.env.MCP_API_TOKEN;
  if (!expected) return false;

  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;

  const provided = authorization.slice("Bearer ".length).trim();
  if (!provided) return false;

  return timingSafeEqual(digest(provided), digest(expected));
}
