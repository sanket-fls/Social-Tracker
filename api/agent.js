// /api/agent: the API Claude's scheduled task uses (Bearer AGENT_TOKEN).
// Claude drafts, writes captions and covers, and refreshes recommendations. It can never approve, schedule or publish:
// those stay with the team and the server. The one exception is a post the team already sent with Publish now:
// when Claude marks it finished, the server publishes it straight away instead of asking for a second OK.
import { waitUntil } from '@vercel/functions';
import { isAgent, send, readJson } from '../lib/auth.js';
import { getDoc, setDoc, mergeDoc, listDocs, logRun, appendHistory, sb } from '../lib/store.js';
import { pfm } from '../lib/pfm.js';
import { publishDoc } from '../lib/publish.js';
import { randomUUID } from 'node:crypto';

export const config = { maxDuration: 300 };

const READ = ['queue', 'requests', 'accounts', 'sync', 'insights', 'runs', 'snapshots', 'config'];
const WRITE = ['queue', 'requests', 'insights', 'config'];
const SERVER_ONLY = ['pfm_post_id', 'live_url', 'live_urls', 'scheduled_in_pfm_at', 'publishing_at', 'approved_by', 'approved_at', 'post_now'];
const AGENT_STATUSES = ['awaiting', 'drafting', 'changes'];

function clean(collection, data, existing) {
  const d = { ...data };
  if (collection === 'queue') {
    for (const k of SERVER_ONLY) delete d[k];
    if (d.status && !AGENT_STATUSES.includes(d.status)) throw new Error('Claude can only set status to ' + AGENT_STATUSES.join(', '));
    if (existing && ['approved', 'scheduled', 'published', 'rejected'].includes(existing.status) && d.status) throw new Error('This post is ' + existing.status + '; Claude cannot change its status.');
  }
  return d;
}

export default async function handler(req, res) {
  if (!isAgent(req)) return send(res, 401, { error: 'unauthorized' });
  const q = req.query || {};
  try {
    if (req.method === 'GET') {
      if (q.op === 'list') {
        if (!READ.includes(q.collection)) return send(res, 400, { error: 'unknown collection' });
        return send(res, 200, { docs: await listDocs(q.collection, { status: q.status ? String(q.status).split(',') : undefined }) });
      }
      if (q.op === 'get') {
        if (!READ.includes(q.collection)) return send(res, 400, { error: 'unknown collection' });
        return send(res, 200, { doc: await getDoc(q.collection, q.id) });
      }
      if (q.op === 'pfm') {
        const path = String(q.path || '');
        if (!/^\/(social-accounts|social-account-feeds|social-posts|social-post-results)/.test(path)) return send(res, 400, { error: 'path not allowed' });
        return send(res, 200, await pfm('GET', path));
      }
      return send(res, 400, { error: 'unknown op' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });
    const b = await readJson(req);
    if (b.op === 'set' || b.op === 'merge') {
      if (!WRITE.includes(b.collection)) return send(res, 400, { error: 'collection not writable' });
      const id = b.id || randomUUID().replace(/-/g, '').slice(0, 20);
      const existing = await getDoc(b.collection, id);
      const data = clean(b.collection, b.data || {}, existing);
      const goLive = b.op === 'merge' && b.collection === 'queue' && existing && existing.status === 'drafting'
        && existing.post_now && existing.approved_at && data.status === 'awaiting';
      if (goLive) data.status = 'approved';
      if (b.op === 'set') {
        if (existing && b.collection === 'queue') return send(res, 409, { error: 'queue doc exists; use merge' });
        await setDoc(b.collection, id, data);
      } else await mergeDoc(b.collection, id, data);
      if (goLive) {
        await appendHistory(id, { by: 'server', by_name: 'System', event: 'Claude finished it · publishing now' });
        // Publish after answering Claude; the 10-minute loop retries if this is cut short.
        waitUntil(publishDoc(id).catch(() => {}));
      }
      return send(res, 200, { ok: true, id, ...(goLive ? { note: 'The team pressed Publish now, so the server is publishing it.' } : {}) });
    }
    if (b.op === 'upload') {
      const ext = String(b.ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5);
      const path = 'claude/' + new Date().toISOString().slice(0, 10) + '/' + randomUUID() + '.' + ext;
      const { data, error } = await sb().storage.from('media').createSignedUploadUrl(path);
      if (error) throw error;
      const publicUrl = sb().storage.from('media').getPublicUrl(path).data.publicUrl;
      return send(res, 200, { uploadUrl: data.signedUrl, publicUrl, path });
    }
    if (b.op === 'log') { await logRun(String(b.summary || '').slice(0, 2000), { by: 'claude' }); return send(res, 200, { ok: true }); }
    return send(res, 400, { error: 'unknown op' });
  } catch (e) {
    send(res, 400, { error: String(e.message || e) });
  }
}
