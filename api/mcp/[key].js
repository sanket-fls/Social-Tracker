// /api/mcp/<key>: the "Social Command" connector for Claude (MCP, Streamable HTTP, stateless).
// A teammate pastes this link once in Claude's connector settings; the key in the link is the only credential.
// Claude can see the accounts and posts, upload media and add a post. When the person asked Claude to post it,
// the post goes straight to Post for Me (now, or at the time they gave), with no separate approval. A post asked for only as a draft waits under "Needs your OK" for someone to approve on the dashboard.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { waitUntil } from '@vercel/functions';
import { randomUUID } from 'node:crypto';
import { send } from '../../lib/auth.js';
import { isConnectorKey, appOrigin } from '../../lib/connector.js';
import { getDoc, setDoc, listDocs, mergeDoc, sb, maxUploadMb, BIG_UPLOAD_MB } from '../../lib/store.js';
import { excluded, pfm } from '../../lib/pfm.js';
import { publishDoc, deleteDoc } from '../../lib/publish.js';

export const config = { maxDuration: 300 };

// Team specifics come from the environment: TEAM_NAME (e.g. "Acme Studio") and POSTING_RULES, plain sentences such as
// '"Everywhere" means the Acme accounts. Kids content goes to Acme Kids only.'
const TEAM = process.env.TEAM_NAME || '';
const APP = TEAM ? TEAM + ' Social Command' : 'Social Command';
const RULES = (process.env.POSTING_RULES || '').trim();
const STORAGE_HOST = (() => { try { return new URL(process.env.SUPABASE_URL).host; } catch { return 'your Supabase project host'; } })();

const INSTRUCTIONS = `${APP} is ${TEAM ? TEAM + "'s" : "the team's"} posting dashboard. It publishes to YouTube, Instagram, Facebook, LinkedIn and X through Post for Me.
Use these tools when someone on the team wants a video or image posted, scheduled or queued.

How to post a video:
1. Check the file with ffprobe: MP4 (H.264 video, AAC audio), up to 200 MB; when it is bigger than 50 MB, pass its size as size_mb to get_upload_link, which then gives a link into Post for Me's storage. If not, re-encode: ffmpeg -i in.mp4 -c:v libx264 -preset slow -crf 23 -c:a aac -b:a 128k -movflags +faststart out.mp4 (raise -crf until it fits). Note its width and height.
2. Use the accounts and time the person named. Ask which accounts only if they didn't say (call list_accounts for the ids). ${RULES ? RULES + ' ' : ''}No time given means it goes out now.
3. Write the title and all captions yourself (don't ask the user for them), from what the video actually says or shows, never inventing numbers, quotes, clients or results: a title (up to 100 characters, YouTube's title); a main caption (Instagram, Facebook, and YouTube's description; hook first, 2 to 4 short paragraphs, a call to action, 3 to 6 hashtags, under 1,000 characters); an X caption under 280 characters; a LinkedIn caption up to 1,300 characters, professional, at most 3 hashtags. Clear, warm, confident voice; follow the team's brand skill if you have one.
4. Make a thumbnail the same shape as the video (1280x720 JPG for 16:9, 1080x1920 for 9:16, under 2 MB): grab a strong frame with ffmpeg, add a short 3 to 6 word headline large enough to read on a phone and a small ${TEAM ? '"' + TEAM.toUpperCase() + '" ' : 'brand '}label; clean, monochrome style. Look at it before uploading.
5. For the video and the thumbnail, call get_upload_link, then in your code environment PUT the file to upload_url (curl -X PUT -H "Content-Type: video/mp4" --data-binary @video.mp4 "<upload_url>"). Your code environment must be able to reach the storage host in the link. If the upload fails with a DNS, network or proxy error, still write the captions and make the thumbnail, then tell the user: "My workspace can't reach the internet. In Claude, open Settings → Capabilities, find code execution's network access, and allow ${STORAGE_HOST} (or all domains); on a Team plan an owner sets this in Admin settings. Then ask me again." Also give them the video, thumbnail and captions so they can add it by hand on the dashboard (New post) if they're in a hurry.
6. Call add_post with the public links, the captions and the accounts. post = "now" when they asked you to post it and gave no time; "at_time" with publish_at when they gave a time; "no" only when they asked for a draft, or to check it before it goes out. If you made the video yourself and can render a second shape (9:16 and 16:9), upload both and pass the second as other_video_url, so each platform gets the right shape. Pass the person's name as requested_by if you know it.
7. Tell the person what add_post said: the live link, or the time it is booked for, plus the dashboard link. A booked post can still be deleted on the dashboard until it goes live; a live post can only be removed on the platform itself. A draft (post "no") waits under "Needs your OK"; if they later say to post it, call publish_post.
YouTube: for children's videos pass made_for_kids true. YouTube has a daily upload limit shared through Post for Me; when asked to post several YouTube videos, spread them over days rather than posting them all at once. If YouTube refuses a post for that limit, the dashboard tries again by itself just after the limit resets (12:30 pm IST, 1:30 pm IST from November) and only on the accounts that failed; tell the person so. A post that failed for another reason: list_posts and get_post show why; if the person asks to try again, call publish_post (it resends only to the accounts that failed).
Stories (Instagram and Facebook): posts there are also shared as a story by default (also_story true). Pass also_story false if the person doesn't want a story, or as_story true to post only as a story with no feed post. Stories work best vertical (9:16) and under a minute. To remove a post, call delete_post when the person asks: it works for drafts and booked posts until they go live; a live post can only be removed on the platform itself.
Carousels: several images or videos in one post. Upload each file with get_upload_link, pass the first as video_url and the rest, in order, as more_media_urls (up to 20 in all). For a PDF (LinkedIn has no PDF posts here), render each page to a JPG (pdftoppm -jpeg -r 150, or PyMuPDF), upload the pages and post them as a carousel. YouTube can't take carousels; LinkedIn takes images only; Instagram shows the first 10, X the first 4.

Post only to the accounts the person asked for, and only what they asked you to post. Only change posts that still need an OK, and only when asked.`;

const LABEL = { awaiting: 'Needs your OK', drafting: 'Claude is finishing', approved: 'Approved', changes: 'Back with Claude', rejected: 'Discarded', scheduled: 'Scheduled', published: 'Live', failed: 'Didn’t go out' };
const RATIOS = [['9x16', 9 / 16], ['4x5', 4 / 5], ['1x1', 1], ['16x9', 16 / 9]];
const BEST = { youtube: ['9x16', '16x9'], instagram: ['9x16', '4x5', '1x1'], facebook: ['9x16', '4x5', '1x1', '16x9'], linkedin: ['1x1', '4x5', '16x9', '9x16'], x: ['16x9', '1x1', '4x5', '9x16'] };

const text = t => ({ content: [{ type: 'text', text: t }] });
const fail = t => ({ content: [{ type: 'text', text: t }], isError: true });
const nearRatio = (w, h) => RATIOS.reduce((b, r) => Math.abs(Math.log(w / h / r[1])) < Math.abs(Math.log(w / h / b[1])) ? r : b)[0];
const ist = d => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) + ' IST';

// "2026-10-24 13:00" (India time) or any ISO time with a zone.
function parseWhen(s) {
  const v = String(s || '').trim();
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 330 * 6e4);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

// Media must be a file uploaded through get_upload_link, and it must be there.
async function mediaCheck(url, what) {
  const base = (process.env.SUPABASE_URL || '') + '/storage/v1/object/public/media/';
  const big = 'https://data.postforme.dev/storage/v1/object/public/post-media/';
  if (!url || !(String(url).startsWith(base) || String(url).startsWith(big))) return what + ' must be a public_url from get_upload_link.';
  const r = await fetch(url, { method: 'HEAD' }).catch(() => null);
  return r && r.ok ? null : what + ' isn’t uploaded yet (the link answers ' + (r ? r.status : 'nothing') + '). PUT the file to its upload_url first.';
}

async function connectedAccounts() {
  const ex = excluded();
  return (await listDocs('accounts')).filter(a => !ex.includes(a.id));
}

// Which file each account gets when a post has more than one shape (same rule as the dashboard).
function accountMedia(doc, accs) {
  if (!doc.variants) return null;
  const m = {};
  for (const id of doc.targets || []) {
    const r = (doc.formats || {})[(accs[id] || {}).platform] || doc.ratio, v = doc.variants[r];
    if (v) m[id] = { ratio: r, video: v.video, poster: (v.thumbs || {})[doc.thumb_style || 'ink'] || '' };
  }
  return m;
}

// Send a post the person asked Claude to post: mark it approved (now, or at its time) and hand it to Post for Me,
// exactly as the dashboard's Approve / Publish now do. Waits up to 40 s to report the result; the loop finishes the rest.
async function sendOut(id, now, who, origin) {
  const q = await getDoc('queue', id);
  const accs = Object.fromEntries((await connectedAccounts()).map(x => [x.id, x]));
  const t = new Date().toISOString();
  const patch = { status: 'approved', approved_by: 'claude-chat', approved_at: t, post_now: now, account_media: accountMedia(q, accs), updated_at: t,
    history: (q.history || []).concat([{ at: t, by: 'claude', by_name: (who || 'Team') + ' (via Claude)', event: now ? 'asked Claude to post it now' : 'asked Claude to post it at its time' }]) };
  if (now) patch.slot_at = t;
  await mergeDoc('queue', id, patch);
  const job = publishDoc(id).catch(e => ({ ok: false, reason: 'error', error: String(e.message || e) }));
  waitUntil(job);
  const r = await Promise.race([job, new Promise(ok => setTimeout(() => ok(null), 40000))]);
  const link = origin + '/#studio/' + id;
  if (!r || r.reason === 'busy') return { ok: true, msg: 'It’s being handed to Post for Me right now. Check list_posts in a minute. Dashboard: ' + link };
  if (!r.ok) return { ok: false, msg: 'Post for Me didn’t take it: ' + (r.error || r.reason) + '. The dashboard shows it as “Didn’t go out” with the reason: ' + link };
  const d = await getDoc('queue', id);
  if (now) return { ok: true, msg: d.status === 'published' ? 'It’s live' + (d.live_url ? ': ' + d.live_url : '.') + ' Dashboard: ' + link : 'Sent to Post for Me to publish now. It turns Live on the dashboard once every account confirms: ' + link };
  return { ok: true, msg: 'Booked in Post for Me for ' + ist(q.slot_at) + '. It goes out by itself, and can still be deleted on the dashboard until then: ' + link };
}

// Why a post didn't go out, or when it tries again (the latest System note in its history).
function problem(q) {
  if (q.status === 'approved' && q.retry_at) return 'waiting for YouTube’s daily limit; tries again by itself ' + ist(q.retry_at);
  if (q.status !== 'failed') return '';
  const e = (q.history || []).slice().reverse().find(h => h.by === 'server' && h.note);
  return e ? String(e.note).replace(/\\n|\s+/g, ' ').slice(0, 300) : 'no reason recorded';
}

function buildServer(origin) {
  const server = new McpServer({ name: 'social-command', title: APP, version: '1.0.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('list_accounts', {
    title: 'List accounts',
    description: 'The social accounts the dashboard can post to, with the ids add_post needs. Only connected accounts can be used.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const accs = await connectedAccounts();
    return text(accs.map(a => `${a.username || a.name || 'Unnamed'} · ${a.platform} · id ${a.id} · ${a.status === 'connected' ? 'connected' : 'NOT connected (can’t be used)'}`).join('\n'));
  });

  server.registerTool('get_upload_link', {
    title: 'Get an upload link',
    description: 'A one-time link to upload one file (the video, or a thumbnail) to the dashboard’s storage. PUT the file bytes to upload_url with its Content-Type from your code environment, then use public_url in add_post. Files up to the limit it returns as max_mb.',
    inputSchema: {
      file_type: z.enum(['mp4', 'mov', 'jpg', 'png']).describe('mp4 or mov for a video, jpg or png for a thumbnail or image'),
      size_mb: z.number().positive().optional().describe('The file’s size in MB. Over max_mb (and up to big_max_mb) you get a link into Post for Me’s storage instead'),
    },
  }, async ({ file_type, size_mb }) => {
    const type = { mp4: 'video/mp4', mov: 'video/quicktime', jpg: 'image/jpeg', png: 'image/png' }[file_type];
    const max = await maxUploadMb();
    if (size_mb && size_mb > BIG_UPLOAD_MB) return fail('Files can be up to ' + BIG_UPLOAD_MB + ' MB. Re-encode it smaller (raise ffmpeg -crf) and try again.');
    if (size_mb && size_mb > max) {
      // Over our storage limit: a one-time link straight into Post for Me's storage (allowed up to the big limit).
      const r = await pfm('POST', '/media/create-upload-url', {});
      return text(JSON.stringify({ upload_url: r.upload_url, public_url: r.media_url, content_type: type, max_mb: max, big_max_mb: BIG_UPLOAD_MB, how: `curl -X PUT -H "Content-Type: ${type}" --data-binary @FILE "${r.upload_url}"` }, null, 2));
    }
    const path = 'connector/' + new Date().toISOString().slice(0, 10) + '/' + randomUUID() + '.' + file_type;
    const { data, error } = await sb().storage.from('media').createSignedUploadUrl(path);
    if (error) return fail('Could not make an upload link: ' + error.message);
    const publicUrl = sb().storage.from('media').getPublicUrl(path).data.publicUrl;
    return text(JSON.stringify({ upload_url: data.signedUrl, public_url: publicUrl, content_type: type, max_mb: max, big_max_mb: BIG_UPLOAD_MB, how: `curl -X PUT -H "Content-Type: ${type}" --data-binary @FILE "${data.signedUrl}"` }, null, 2));
  });

  server.registerTool('add_post', {
    title: 'Add a post (and post it)',
    description: 'Adds a post with everything filled in and, when the person asked you to post it, sends it out: post "now" goes out straight away, "at_time" goes out at publish_at, "no" leaves it under "Needs your OK" as a draft. Upload the media with get_upload_link first. Only the accounts the person asked for.',
    annotations: { destructiveHint: true, openWorldHint: true, idempotentHint: false },
    inputSchema: {
      title: z.string().min(1).max(100).describe('Post title; YouTube uses it as the video title'),
      caption: z.string().min(1).max(2200).describe('Main caption for Instagram, Facebook and YouTube (description)'),
      caption_x: z.string().max(280).optional().describe('X caption, under 280 characters. Needed for X when the main caption is longer'),
      caption_linkedin: z.string().max(3000).optional().describe('LinkedIn caption; the main caption is used if left out'),
      media_type: z.enum(['video', 'image']).default('video'),
      video_url: z.string().describe('public_url of the uploaded video (or image)'),
      thumbnail_url: z.string().optional().describe('public_url of the uploaded thumbnail; needed for videos'),
      width: z.number().int().positive().describe('Width of the video in pixels'),
      height: z.number().int().positive().describe('Height of the video in pixels'),
      account_ids: z.array(z.string()).min(1).describe('Account ids from list_accounts'),
      post: z.enum(['now', 'at_time', 'no']).default('now').describe('"now" = post straight away (they asked to post, no time given); "at_time" = at publish_at; "no" = only a draft for review'),
      publish_at: z.string().optional().describe('For at_time or a draft: "YYYY-MM-DD HH:MM" in India time, or an ISO time with a zone. At least 10 minutes from now'),
      requested_by: z.string().max(80).optional().describe('Name of the person who asked, if known'),
      more_media_urls: z.array(z.string()).max(19).optional().describe('For a carousel: the other files (public_urls from get_upload_link), in order, after video_url'),
      other_video_url: z.string().optional().describe('Optional second shape of the same video (9:16 if the main one is 16:9, or the other way round)'),
      other_thumbnail_url: z.string().optional(),
      other_width: z.number().int().positive().optional(),
      other_height: z.number().int().positive().optional(),
      youtube_playlist: z.string().optional().describe('YouTube playlist name, if any'),
      also_story: z.boolean().default(true).describe('Instagram/Facebook: also share it as a story (default yes)'),
      as_story: z.boolean().default(false).describe('Instagram/Facebook: post only as a story, no feed post'),
      made_for_kids: z.boolean().optional().describe('YouTube "made for kids". true for children\'s videos; left out = yes only when every YouTube account is a kids channel ("kids" in its name)'),
      note: z.string().max(500).optional().describe('Who asked for it and anything the approver should know'),
    },
  }, async (a) => {
    const mode = a.post || 'now';
    let when = new Date();
    if (mode !== 'now') {
      when = parseWhen(a.publish_at);
      if (!when) return fail('publish_at is missing or isn’t a time I can read. Use "YYYY-MM-DD HH:MM" in India time, or post "now".');
      if (when.getTime() < Date.now() + 10 * 6e4) return fail('publish_at must be at least 10 minutes from now (it is ' + ist(when) + '). For sooner, use post "now".');
    }
    const accs = await connectedAccounts();
    const byId = Object.fromEntries(accs.map(x => [x.id, x]));
    const bad = a.account_ids.filter(id => !byId[id] || byId[id].status !== 'connected');
    if (bad.length) return fail('These accounts can’t be used (unknown or not connected): ' + bad.join(', ') + '. Call list_accounts.');
    const platforms = [...new Set(a.account_ids.map(id => byId[id].platform))];
    if (platforms.includes('x') && !a.caption_x && a.caption.length > 280) return fail('X needs caption_x under 280 characters, because the main caption is longer.');
    const extra = a.more_media_urls || [];
    const kindOf = u => /\.(mp4|mov)(\?|$)/i.test(u) ? 'video' : 'image';
    const items = extra.length ? [a.video_url, ...extra].map(u => ({ url: u, type: kindOf(u), mime: kindOf(u) === 'video' ? (/\.mov/i.test(u) ? 'video/quicktime' : 'video/mp4') : (/\.png/i.test(u) ? 'image/png' : 'image/jpeg') })) : null;
    if (items && platforms.includes('youtube')) return fail('YouTube can’t post a carousel. Leave the YouTube accounts out.');
    if (items && platforms.includes('linkedin') && items.some(x => x.type === 'video')) return fail('LinkedIn carousels can only be images. Leave LinkedIn out, or use only images.');
    for (const u of extra) { const e = await mediaCheck(u, 'more_media_urls'); if (e) return fail(e); }
    if (a.media_type === 'video' && !a.thumbnail_url && !items) return fail('Videos need a thumbnail_url. Make one and upload it with get_upload_link.');
    for (const [u, w] of [[a.video_url, 'video_url'], [a.thumbnail_url, 'thumbnail_url'], [a.other_video_url, 'other_video_url'], [a.other_thumbnail_url, 'other_thumbnail_url']]) {
      if (u) { const e = await mediaCheck(u, w); if (e) return fail(e); }
    }
    const ratio = nearRatio(a.width, a.height);
    const now = new Date().toISOString();
    const doc = {
      title: a.title, caption: a.caption, captions: { x: a.caption_x || '', linkedin: a.caption_linkedin || '' },
      media_url: a.video_url, poster_url: a.thumbnail_url || (a.media_type === 'image' ? a.video_url : ''), media_type: a.media_type,
      media_mime: a.media_type === 'video' ? (a.video_url.endsWith('.mov') ? 'video/quicktime' : 'video/mp4') : undefined,
      dims: { w: a.width, h: a.height }, ratio, thumb_style: 'ink',
      targets: a.account_ids, account_ids: a.account_ids, platforms,
      slot_at: when.toISOString(), status: 'awaiting', source: 'claude', kind: a.media_type === 'image' ? 'Image post' : 'Video post',
      created_at: now, created_by: 'connector', yt_playlist: a.youtube_playlist || null, ...(typeof a.made_for_kids === 'boolean' ? { made_for_kids: a.made_for_kids } : {}), as_story: !!a.as_story, also_story: a.also_story !== false && !a.as_story, ...(items ? { media_items: items, media_type: items[0].type, poster_url: a.thumbnail_url || (items.find(x => x.type === 'image') || {}).url || '', kind: 'Carousel · ' + items.length } : {}),
      history: [{ at: now, by: 'claude', by_name: 'Claude', event: mode === 'no' ? 'added it through the Claude connector, ready for an OK' : 'added it through the Claude connector', note: a.note || null }],
    };
    if (doc.media_mime === undefined) delete doc.media_mime;
    if (a.other_video_url) {
      const ow = a.other_width || (ratio === '16x9' ? 1080 : 1920), oh = a.other_height || (ratio === '16x9' ? 1920 : 1080);
      const other = nearRatio(ow, oh);
      if (other === ratio) return fail('other_video_url is the same shape as video_url. It should be the other shape (9:16 vs 16:9).');
      doc.variants = { [ratio]: { video: a.video_url, thumbs: { ink: doc.poster_url } }, [other]: { video: a.other_video_url, thumbs: { ink: a.other_thumbnail_url || doc.poster_url } } };
      doc.formats = Object.fromEntries(Object.keys(BEST).map(p => [p, p === 'youtube' ? ratio : (BEST[p].find(r => doc.variants[r]) || ratio)]));
    }
    const id = randomUUID().replace(/-/g, '').slice(0, 20);
    await setDoc('queue', id, doc);
    if (mode !== 'no') { const r = await sendOut(id, mode === 'now', a.requested_by, origin); return (r.ok ? text : fail)(`"${a.title}" → ${a.account_ids.map(x => (byId[x].username || byId[x].name) + ' (' + byId[x].platform + ')').join(', ')}.\n` + r.msg + '\nPost id: ' + id); }
    return text(`Added "${a.title}" for ${ist(when)} to ${a.account_ids.map(x => (byId[x].username || byId[x].name) + ' (' + byId[x].platform + ')').join(', ')}.\nIt waits under "Needs your OK" until someone approves it: ${origin}/#studio/${id}\nPost id: ${id}`);
  });

  server.registerTool('list_posts', {
    title: 'List posts',
    description: 'Posts on the dashboard: what needs an OK, what is scheduled, what is live.',
    inputSchema: { which: z.enum(['needs_ok', 'scheduled', 'live', 'all']).default('needs_ok'), limit: z.number().int().min(1).max(50).default(15) },
    annotations: { readOnlyHint: true },
  }, async ({ which, limit }) => {
    const accs = Object.fromEntries((await listDocs('accounts')).map(x => [x.id, x]));
    const planned = q => ['approved', 'scheduled'].includes(q.status) || (q.status === 'drafting' && q.approved_at);
    const pick = { needs_ok: q => ['awaiting', 'changes', 'failed'].includes(q.status), scheduled: planned, live: q => q.status === 'published', all: q => q.status !== 'rejected' }[which];
    const list = (await listDocs('queue')).filter(pick).sort((x, y) => (which === 'live' ? -1 : 1) * String(x.slot_at || '').localeCompare(String(y.slot_at || ''))).slice(0, limit);
    if (!list.length) return text('No posts here.');
    return text(list.map(q => `${q.title || 'Untitled'} · ${LABEL[q.status] || q.status}${problem(q) ? ' (' + problem(q) + ')' : ''} · ${q.slot_at ? ist(q.slot_at) : 'no time'} · ${(q.targets || []).map(t => accs[t] ? (accs[t].username || accs[t].name) + ' ' + accs[t].platform : t).join(', ')} · id ${q.id}${q.live_url ? ' · ' + q.live_url : ''}`).join('\n'));
  });

  server.registerTool('update_post', {
    title: 'Fix a post that needs an OK',
    description: 'Changes the captions, title, thumbnail, time or accounts of a post that still needs an OK (or was sent back for changes). Only when the user asks. Approved, scheduled and live posts can’t be changed here.',
    inputSchema: {
      id: z.string(), title: z.string().min(1).max(100).optional(), caption: z.string().min(1).max(2200).optional(),
      caption_x: z.string().max(280).optional(), caption_linkedin: z.string().max(3000).optional(),
      thumbnail_url: z.string().optional(), publish_at: z.string().optional(), account_ids: z.array(z.string()).min(1).optional(),
      note: z.string().max(500).optional().describe('What was changed and why'),
    },
  }, async (a) => {
    const q = await getDoc('queue', a.id);
    if (!q) return fail('No post with id ' + a.id + '.');
    if (!['awaiting', 'changes'].includes(q.status)) return fail('This post is “' + (LABEL[q.status] || q.status) + '”, so it can’t be changed here. Only posts that need an OK can.');
    const patch = {};
    if (a.title) patch.title = a.title;
    if (a.caption) patch.caption = a.caption;
    if (a.caption_x !== undefined || a.caption_linkedin !== undefined) patch.captions = { ...(q.captions || {}), ...(a.caption_x !== undefined ? { x: a.caption_x } : {}), ...(a.caption_linkedin !== undefined ? { linkedin: a.caption_linkedin } : {}) };
    if (a.thumbnail_url) { const e = await mediaCheck(a.thumbnail_url, 'thumbnail_url'); if (e) return fail(e); patch.poster_url = a.thumbnail_url; if (q.variants && q.variants[q.ratio]) patch.variants = { ...q.variants, [q.ratio]: { ...q.variants[q.ratio], thumbs: { ink: a.thumbnail_url } } }; }
    if (a.publish_at) { const w = parseWhen(a.publish_at); if (!w || w.getTime() < Date.now() + 10 * 6e4) return fail('publish_at must be a readable time at least 10 minutes from now.'); patch.slot_at = w.toISOString(); }
    if (a.account_ids) {
      const accs = Object.fromEntries((await connectedAccounts()).map(x => [x.id, x]));
      const bad = a.account_ids.filter(id => !accs[id] || accs[id].status !== 'connected');
      if (bad.length) return fail('These accounts can’t be used: ' + bad.join(', ') + '.');
      patch.targets = a.account_ids; patch.account_ids = a.account_ids; patch.platforms = [...new Set(a.account_ids.map(id => accs[id].platform))];
    }
    if (!Object.keys(patch).length) return fail('Nothing to change.');
    const now = new Date().toISOString();
    if (q.status === 'changes') patch.status = 'awaiting';
    patch.updated_at = now;
    patch.history = (q.history || []).concat([{ at: now, by: 'claude', by_name: 'Claude', event: 'changed it through the Claude connector', note: a.note || null }]);
    await mergeDoc('queue', a.id, patch);
    return text(`Updated "${patch.title || q.title}". It waits under "Needs your OK": ${origin}/#studio/${a.id}`);
  });

  server.registerTool('get_post', {
    title: 'Show a post',
    description: 'Everything about one post: title, captions, video, thumbnail, accounts, time and status.',
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    const q = await getDoc('queue', id);
    if (!q) return fail('No post with id ' + id + '.');
    const accs = Object.fromEntries((await listDocs('accounts')).map(x => [x.id, x]));
    return text([
      'Title: ' + (q.title || '(none)'),
      'Status: ' + (LABEL[q.status] || q.status) + (q.hold ? ' (paused)' : ''),
      ...(problem(q) ? ['Problem: ' + problem(q)] : []),
      'Goes out: ' + (q.slot_at ? ist(q.slot_at) : 'no time set'),
      'Accounts: ' + (q.targets || []).map(t => accs[t] ? (accs[t].username || accs[t].name) + ' (' + accs[t].platform + ')' : t).join(', '),
      'Video: ' + (q.media_url || '(none)') + (q.variants ? ' · shapes: ' + Object.keys(q.variants).join(', ') : ''),
      'Thumbnail: ' + (q.poster_url || '(none)'),
      'Main caption:\n' + (q.caption || '(none)'),
      'X caption: ' + ((q.captions || {}).x || '(uses the main caption)'),
      'LinkedIn caption:\n' + ((q.captions || {}).linkedin || '(uses the main caption)'),
      'Dashboard: ' + origin + '/#studio/' + id,
    ].join('\n'));
  });

  server.registerTool('publish_post', {
    title: 'Post a post that needs an OK',
    description: 'Sends out a post that is waiting under "Needs your OK", or tries a failed one again (only on the accounts that failed), when the person asks: "now" straight away, "at_time" at the post’s time.',
    inputSchema: { id: z.string(), when: z.enum(['now', 'at_time']).default('now'), requested_by: z.string().max(80).optional() },
    annotations: { destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async ({ id, when, requested_by }) => {
    const q = await getDoc('queue', id);
    if (!q) return fail('No post with id ' + id + '.');
    if (!['awaiting', 'failed'].includes(q.status)) return fail('This post is “' + (LABEL[q.status] || q.status) + '”' + (problem(q) ? ' (' + problem(q) + ')' : '') + ', so it can’t be posted from here. Only posts that need an OK, or that didn’t go out, can.');
    if (q.hold) return fail('This post is paused on the dashboard. Someone has to resume it there first.');
    if (!q.caption || !q.caption.trim()) return fail('It has no caption yet. Add one with update_post first.');
    if (!q.media_url && !q.variants) return fail('It has no video or image yet.');
    const accs = Object.fromEntries((await connectedAccounts()).map(x => [x.id, x]));
    const off = (q.targets || []).filter(t => !accs[t] || accs[t].status !== 'connected');
    if (!(q.targets || []).length || off.length) return fail('Its accounts aren’t all connected (' + off.join(', ') + '). Change them with update_post.');
    const now = when === 'now';
    if (!now && (!q.slot_at || new Date(q.slot_at).getTime() < Date.now() + 10 * 6e4)) return fail('Its time (' + (q.slot_at ? ist(q.slot_at) : 'none') + ') is less than 10 minutes away. Set a new time with update_post, or post it "now".');
    const r = await sendOut(id, now, requested_by, origin);
    return (r.ok ? text : fail)(r.msg);
  });

  server.registerTool('delete_post', {
    title: 'Delete a post',
    description: 'Deletes a draft or a booked post so it doesn’t go out (it also comes out of Post for Me, with its story). Only when the person asks. A live post can’t be deleted here.',
    inputSchema: { id: z.string(), requested_by: z.string().max(80).optional() },
    annotations: { destructiveHint: true, openWorldHint: true, idempotentHint: true },
  }, async ({ id, requested_by }) => {
    const q = await getDoc('queue', id);
    if (!q) return fail('No post with id ' + id + '.');
    if (q.status === 'rejected') return text('“' + (q.title || 'Untitled') + '” was already deleted.');
    const r = await deleteDoc(id, { id: 'claude', name: (requested_by || 'Team') + ' (via Claude)' });
    return r.ok ? text('Deleted “' + (q.title || 'Untitled') + '”. It won’t go out. It stays on the dashboard under All, marked Discarded.') : fail(r.error || 'Couldn’t delete it.');
  });

  return server;
}

export default async function handler(req, res) {
  if (!isConnectorKey(req.query && req.query.key)) return send(res, 404, { error: 'not found' });
  const server = buildServer(appOrigin(req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Server error' }, id: null });
  }
}
