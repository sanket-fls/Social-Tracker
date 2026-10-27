// /api/docs: the dashboard's document store through the server. The page uses it when OPEN_ACCESS=1
// (no sign-in), so visitors never need database rules of their own. Writes get the same limits as
// supabase/schema.sql: only queue and request docs, and never Post for Me ids or a sent/live status.
import { teamUser, send, readJson } from '../lib/auth.js';
import { sb } from '../lib/store.js';
import { randomUUID } from 'node:crypto';

export const config = { maxDuration: 30 };

const WRITABLE = ['queue', 'requests'];
const SERVER_ONLY = ['pfm_post_id', 'live_url', 'live_urls', 'scheduled_in_pfm_at', 'publishing_at'];
const SENT = ['scheduled', 'published'];

function guard(collection, next, old) {
  if (collection !== 'queue') return next;
  const d = { ...next };
  for (const k of SERVER_ONLY) { if (old && old[k] !== undefined) d[k] = old[k]; else delete d[k]; }
  if (old && SENT.includes(old.status)) d.status = old.status;
  else if (SENT.includes(d.status)) d.status = old ? old.status : 'awaiting';
  return d;
}

export default async function handler(req, res) {
  const user = await teamUser(req);
  if (!user) return send(res, 401, { error: 'Sign in with a team account.' });
  try {
    if (req.method === 'GET') {
      // ?since=<cursor> returns only docs changed after it (with 5 s of overlap, so nothing slips between polls).
      const since = (req.query || {}).since;
      const docs = [];
      for (let from = 0; ; from += 1000) {
        let q = sb().from('docs').select('collection,id,data,updated_at').order('updated_at').range(from, from + 999);
        if (since) q = q.gt('updated_at', new Date(new Date(since).getTime() - 5000).toISOString());
        const { data, error } = await q;
        if (error) throw error;
        docs.push(...data);
        if (data.length < 1000) break;
      }
      const cursor = docs.length ? docs[docs.length - 1].updated_at : (since || null);
      return send(res, 200, { docs: docs.map(({ collection, id, data }) => ({ collection, id, data })), cursor });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });
    const b = await readJson(req);
    if (b.op === 'upload') {
      const ext = String(b.ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
      const path = 'team/' + new Date().toISOString().slice(0, 10) + '/' + randomUUID() + '.' + ext;
      const { data, error } = await sb().storage.from('media').createSignedUploadUrl(path);
      if (error) throw error;
      return send(res, 200, { path, token: data.token, publicUrl: sb().storage.from('media').getPublicUrl(path).data.publicUrl });
    }
    const { op, collection, id, data } = b;
    if (!['insert', 'set', 'update'].includes(op) || !WRITABLE.includes(collection) || !id || !data || typeof data !== 'object') return send(res, 400, { error: 'Not allowed.' });
    const { data: row, error: e1 } = await sb().from('docs').select('data').eq('collection', collection).eq('id', String(id)).maybeSingle();
    if (e1) throw e1;
    const old = row ? row.data : null;
    if (op === 'insert' && old) return send(res, 409, { error: 'Already exists: ' + collection + '/' + id });
    if (op === 'update' && !old) return send(res, 404, { error: 'Not found: ' + collection + '/' + id });
    const next = guard(collection, op === 'update' ? { ...old, ...data } : data, old);
    const { error: e2 } = await sb().from('docs').upsert({ collection, id: String(id), data: next });
    if (e2) throw e2;
    send(res, 200, { ok: true, data: next });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
}
