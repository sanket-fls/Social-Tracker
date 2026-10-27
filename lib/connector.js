// The Claude connector's link. Its key is the only credential, so teammates paste one link and nothing else.
// The key comes from MCP_KEY if set, otherwise it is derived from AGENT_TOKEN (changing that token changes the link).
import { createHmac, timingSafeEqual } from 'node:crypto';

export function connectorKey() {
  if (process.env.MCP_KEY) return process.env.MCP_KEY;
  if (!process.env.AGENT_TOKEN) return null;
  return createHmac('sha256', process.env.AGENT_TOKEN).update('social-command-connector').digest('base64url').slice(0, 32);
}

export function isConnectorKey(k) {
  const want = connectorKey();
  if (!want || !k) return false;
  const a = Buffer.from(String(k)), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const appOrigin = req => 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
export const connectorUrl = req => appOrigin(req) + '/api/mcp/' + connectorKey();
