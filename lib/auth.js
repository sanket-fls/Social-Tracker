// Request guards: team members (Supabase session), Claude's agent token, and the cron secret.
import { timingSafeEqual } from 'node:crypto';
import { sb } from './store.js';

function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

// With OPEN_ACCESS=1 nobody signs in: requests without a session act as the shared "Team" user.
const OPEN_USER = { id: 'team', email: '', name: 'Team' };

export async function teamUser(req) {
  const token = bearer(req);
  if (!token) return process.env.OPEN_ACCESS === '1' ? OPEN_USER : null;
  const { data, error } = await sb().auth.getUser(token);
  if (error || !data || !data.user) return null;
  const email = (data.user.email || '').toLowerCase();
  const { data: rows } = await sb().from('team_emails').select('pattern');
  const ok = (rows || []).some(r => new RegExp('^' + r.pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$').test(email));
  return ok ? { id: data.user.id, email, name: (data.user.user_metadata && (data.user.user_metadata.full_name || data.user.user_metadata.name)) || email.split('@')[0] } : null;
}

export const isAgent = req => safeEq(bearer(req), process.env.AGENT_TOKEN);
export const isCron = req => safeEq(bearer(req), process.env.CRON_SECRET) || safeEq(req.query && req.query.key, process.env.CRON_SECRET);

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}
