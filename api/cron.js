// GET /api/cron (Bearer CRON_SECRET): the background loop. Called every 10 minutes by Supabase pg_cron
// (supabase/cron.sql), with GitHub Actions and a daily Vercel cron as backups. Each caller adds ?src=.
// Sends any approved posts that are still waiting, marks scheduled posts live, and syncs numbers once an hour.
import { isCron, send } from '../lib/auth.js';
import { tick } from '../lib/publish.js';
import { runSync } from '../lib/sync.js';
import { getDoc, mergeDoc, logRun } from '../lib/store.js';

export const config = { maxDuration: 300 };

const SOURCES = { supabase: 'the Supabase scheduler', github: 'GitHub Actions', vercel: 'the daily Vercel cron' };

// sync/heartbeat remembers when the loop last ran and from where, so the page can show it.
async function heartbeat(src) {
  const hb = await getDoc('sync', 'heartbeat');
  const seen = (hb && hb.sources) || {};
  const at = new Date().toISOString();
  await mergeDoc('sync', 'heartbeat', { at, src, sources: { ...seen, [src]: at } });
  return !seen[src];
}

export default async function handler(req, res) {
  if (!isCron(req)) return send(res, 401, { error: 'unauthorized' });
  const parts = [];
  const src = String((req.query && req.query.src) || '');
  try {
    if (await heartbeat(SOURCES[src] ? src : 'other') && SOURCES[src]) parts.push('Background loop: first run from ' + SOURCES[src]);
  } catch (e) {}
  try {
    const t = await tick();
    if (t.sent.length) parts.push('sent ' + t.sent.join(', '));
    if (t.published.length) parts.push('live: ' + t.published.join(', '));
    if (t.failed.length) parts.push('failed: ' + t.failed.join(', '));
    const s = await getDoc('sync', 'latest');
    const force = req.query && req.query.sync === '1';
    if (force || !s || Date.now() - new Date(s.synced_at).getTime() > 55 * 60 * 1000) {
      const r = await runSync();
      parts.push('synced ' + r.accounts + ' accounts');
    }
    if (parts.length) await logRun(parts.join(' · '));
    send(res, 200, { ok: true, ...t, log: parts });
  } catch (e) {
    await logRun('Background run error: ' + String(e.message || e).slice(0, 300)).catch(() => {});
    send(res, 500, { ok: false, error: String(e.message || e) });
  }
}
