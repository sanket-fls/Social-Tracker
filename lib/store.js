// Server-side access to the docs table, using the service role key (bypasses row-level security).
import { createClient } from '@supabase/supabase-js';

let client;
export function sb() {
  if (!client) {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

export async function getDoc(collection, id) {
  const { data, error } = await sb().from('docs').select('data,updated_at').eq('collection', collection).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? { id, ...data.data, _updated_at: data.updated_at } : null;
}

export async function setDoc(collection, id, value) {
  const { _updated_at, id: _drop, ...clean } = value || {};
  const { error } = await sb().from('docs').upsert({ collection, id, data: clean });
  if (error) throw error;
}

// Shallow merge of top-level fields, like Firestore's update().
export async function mergeDoc(collection, id, patch) {
  const cur = await getDoc(collection, id);
  const { _updated_at, id: _i, ...base } = cur || {};
  const next = { ...base, ...patch };
  for (const k of Object.keys(next)) if (next[k] && next[k].__delete__) delete next[k];
  await setDoc(collection, id, next);
  return { id, ...next };
}

export async function listDocs(collection, { status, limit = 1000 } = {}) {
  let q = sb().from('docs').select('id,data,updated_at').eq('collection', collection).limit(limit);
  if (status) q = Array.isArray(status) ? q.in('data->>status', status) : q.eq('data->>status', status);
  const { data, error } = await q;
  if (error) throw error;
  return data.map(r => ({ id: r.id, ...r.data, _updated_at: r.updated_at }));
}

export async function appendHistory(id, entry, patch = {}) {
  const cur = await getDoc('queue', id);
  if (!cur) throw new Error('queue/' + id + ' not found');
  const history = (cur.history || []).concat([{ at: new Date().toISOString(), ...entry }]);
  return mergeDoc('queue', id, { ...patch, history, updated_at: new Date().toISOString() });
}

export async function claimPost(id) {
  const { data, error } = await sb().rpc('claim_post', { p_id: id });
  if (error) throw error;
  return data === true;
}

export async function logRun(summary, extra = {}) {
  const now = new Date();
  const ist = new Date(now.getTime() + 330 * 6e4).toISOString();
  const id = ist.slice(0, 10) + '-' + ist.slice(11, 13) + ist.slice(14, 16) + '-' + Math.random().toString(36).slice(2, 6);
  await setDoc('runs', id, { at: now.toISOString(), by: extra.by || 'server', summary, ...extra });
}

export function istDate(d = new Date()) {
  return new Date(d.getTime() + 330 * 6e4).toISOString().slice(0, 10);
}

// The upload limit, in MB, is the media bucket's own file size limit (Supabase Storage). 50 MB on the free plan;
// after upgrading, raise the project's and the bucket's limit and everything follows. Cached for 10 minutes.
let limitMb = null, limitAt = 0;
// Bigger files (up to BIG_UPLOAD_MB) skip our storage and go straight into Post for Me's own storage.
export const BIG_UPLOAD_MB = 200;
export async function maxUploadMb() {
  if (limitMb && Date.now() - limitAt < 10 * 6e4) return limitMb;
  try { const { data } = await sb().storage.getBucket('media'); const b = Number(data && (data.file_size_limit || data.fileSizeLimit)); limitMb = b > 0 ? Math.floor(b / 1048576) : 50; }
  catch (e) { limitMb = limitMb || 50; }
  limitAt = Date.now();
  return limitMb;
}
