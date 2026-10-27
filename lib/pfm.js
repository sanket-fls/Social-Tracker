// Thin client for the Post for Me API. The key lives only in the server's environment.
const BASE = 'https://api.postforme.dev/v1';

export function excluded() {
  return (process.env.PFM_EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean);
}

export async function pfm(method, path, body) {
  const key = process.env.PFM_KEY;
  if (!key) throw new Error('PFM_KEY is not set on the server');
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || (json.errors && JSON.stringify(json.errors)))) || text || res.statusText;
    const err = new Error('Post for Me ' + res.status + ': ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 400));
    err.status = res.status; err.body = json; throw err;
  }
  return json;
}

// Copy a file we host (Supabase public URL) into Post for Me's storage and return the URL it gives back.
export async function uploadFromUrl(srcUrl, contentType) {
  // Already in Post for Me's storage (big files go there directly): use it as it is.
  if (/^https:\/\/data\.postforme\.dev\//.test(srcUrl)) return srcUrl;
  // Files over 50 MB (possible once the storage limit is raised) go to Post for Me as their public link, which it
  // fetches itself, so the server never holds 200 MB in memory. Smaller files keep the copy below.
  const head = await fetch(srcUrl, { method: 'HEAD' }).catch(() => null);
  if (head && Number(head.headers.get('content-length')) > 50 * 1048576) return srcUrl;
  const src = await fetch(srcUrl);
  if (!src.ok) throw new Error('Could not download media ' + srcUrl + ' (' + src.status + ')');
  const buf = Buffer.from(await src.arrayBuffer());
  const type = contentType || src.headers.get('content-type') || 'application/octet-stream';
  const { upload_url, media_url } = await pfm('POST', '/media/create-upload-url', {});
  const put = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': type }, body: buf });
  if (!put.ok) throw new Error('Upload to Post for Me failed (' + put.status + ')');
  return media_url;
}

export async function postResults(postId) {
  const r = await pfm('GET', '/social-post-results?post_id=' + encodeURIComponent(postId));
  return r.data || [];
}
