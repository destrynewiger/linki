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

// Native clients may omit Origin. Browser clients must match the configured origin;
// never derive trust from an attacker-controlled Host or X-Forwarded-* header.
export function hasValidMcpOrigin(req: NextApiRequest): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== "string" || !process.env.NEXTAUTH_URL) return false;
  try {
    const configured = new URL(process.env.NEXTAUTH_URL);
    return ["http:", "https:"].includes(configured.protocol) && origin === configured.origin;
  } catch { return false; }
}
