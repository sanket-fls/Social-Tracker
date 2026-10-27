// /api/connector: the link a teammate pastes into Claude to add the "Social Command" connector.
// Shown on the dashboard's How it works page, so only people who can open the dashboard get it.
import { teamUser, send } from '../lib/auth.js';
import { connectorKey, connectorUrl } from '../lib/connector.js';

export default async function handler(req, res) {
  const user = await teamUser(req);
  if (!user) return send(res, 401, { error: 'Sign in with a team account.' });
  if (!connectorKey()) return send(res, 503, { error: 'The connector needs AGENT_TOKEN (or MCP_KEY) set on the server.' });
  send(res, 200, { url: connectorUrl(req) });
}
