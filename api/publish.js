// POST /api/publish {id}: a team member approved a post (or pressed Post now). Sends it to Post for Me right away.
// POST /api/publish {id, check: true}: asks Post for Me whether a sent post is live yet, without waiting for the loop.
// POST /api/publish {id, remove: true}: deletes a post before it goes live (also takes it out of Post for Me).
// POST /api/publish {id, claude: true}: Publish now on a post Claude still has to finish; starts Claude's routine now.
// POST /api/publish {bigupload: true}: a one-time link to put a file over our storage limit (up to 200 MB) straight into
// Post for Me's storage; the browser uploads to it directly and the post uses its public link.
import { teamUser, send, readJson } from '../lib/auth.js';
import { publishDoc, checkPublished, deleteDoc } from '../lib/publish.js';
import { getDoc } from '../lib/store.js';
import { wakeClaude } from '../lib/claude.js';
import { pfm } from '../lib/pfm.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const user = await teamUser(req);
  if (!user) return send(res, 401, { error: 'Sign in with a team account.' });
  const { id, check, remove, claude, bigupload } = await readJson(req);
  if (bigupload) { try { const r = await pfm('POST', '/media/create-upload-url', {}); return send(res, 200, { upload_url: r.upload_url, url: r.media_url }); } catch (e) { return send(res, 502, { error: String(e.message || e) }); } }
  if (!id) return send(res, 400, { error: 'id is required' });
  try {
    if (check) return send(res, 200, { ok: true, state: (await checkPublished(String(id))) || 'unchanged' });
    if (remove) { const r = await deleteDoc(String(id), user); return send(res, r.ok ? 200 : 409, r); }
    if (claude) {
      const doc = await getDoc('queue', String(id));
      if (!doc || doc.status !== 'drafting' || !doc.post_now) return send(res, 409, { ok: false, reason: 'not_waiting' });
      return send(res, 200, { ok: true, ...(await wakeClaude('Publish now was pressed for queue doc ' + doc.id + '. Finish it with Step 3, then log with Step 5.')) });
    }
    const r = await publishDoc(String(id), user.email);
    send(res, r.ok ? 200 : 409, r);
  } catch (e) {
    send(res, 500, { ok: false, error: String(e.message || e) });
  }
}
