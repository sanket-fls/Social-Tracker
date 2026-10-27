// POST /api/sync: "Refresh numbers" on the dashboard. Pulls every feed from Post for Me now.
import { teamUser, send } from '../lib/auth.js';
import { runSync } from '../lib/sync.js';
import { mergeDoc, logRun } from '../lib/store.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const user = await teamUser(req);
  if (!user) return send(res, 401, { error: 'Sign in with a team account.' });
  const at = new Date().toISOString();
  await mergeDoc('requests', 'refresh', { requested_at: at, by: user.id, by_name: user.name, fired_at: at });
  try {
    const r = await runSync();
    await logRun('Refresh by ' + user.name + ': synced ' + r.accounts + ' accounts, ' + r.posts + ' posts on record.');
    send(res, 200, { ok: true, ...r });
  } catch (e) {
    await logRun('Refresh failed: ' + String(e.message || e).slice(0, 300));
    send(res, 500, { ok: false, error: String(e.message || e) });
  }
}
