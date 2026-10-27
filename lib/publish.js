// Step 5 and 6 of the old Claude loop, now running on the server.
import { pfm, uploadFromUrl, postResults, excluded } from './pfm.js';
import { getDoc, listDocs, appendHistory, claimPost, mergeDoc } from './store.js';

const MIN_LEAD_MS = 10 * 60 * 1000;

function absUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//.test(u)) return u;
  throw new Error('Media is not on the new storage yet: ' + u);
}

async function accountInfo(ids) {
  const out = {};
  for (const id of ids) { const a = await getDoc('accounts', id); out[id] = a || {}; }
  return out;
}

// YouTube's daily upload allowance (Post for Me's Google project, shared by its customers) resets at midnight
// Pacific time. A post refused only for that is tried again, on the failed accounts only, just after the reset.
const YT_QUOTA = /quota exceeded[\s\S]*video uploads|uploadLimitExceeded/i;
const errText = r => String((r.error && (r.error.message || JSON.stringify(r.error))) || r.error || '');
export function nextQuotaReset(now = new Date()) {
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const next = new Date(pt); next.setHours(24, 5, 0, 0);
  return new Date(next.getTime() + (now.getTime() - pt.getTime()));
}
const istTime = d => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const mergeUrls = (a, b) => [...new Set([...(a || []), ...(b || [])])];

// A post that already went to Post for Me and failed somewhere is sent again as a new Post for Me post,
// to the failed accounts only, so the accounts where it worked don't get it twice.
async function prepareRetry(doc) {
  const res = await postResults(doc.pfm_post_id).catch(() => null);
  const bad = (res || []).filter(r => !r.success);
  const ids = [...new Set(bad.map(r => r.social_account_id).filter(Boolean))];
  if (!ids.length) return null;
  return mergeDoc('queue', doc.id, { pfm_post_id: { __delete__: true }, earlier_pfm_post_ids: [...(doc.earlier_pfm_post_ids || []), doc.pfm_post_id], send_targets: ids });
}

// Build the Post for Me request body for one queue doc.
export async function buildPost(doc, deps = {}) {
  const upload = deps.upload || uploadFromUrl;
  const ex = excluded();
  const targets = (doc.send_targets || doc.targets || doc.account_ids || []).filter(id => !ex.includes(id));
  if (!targets.length) throw new Error('No accounts to post to.');
  if (!doc.caption || !doc.caption.trim()) throw new Error('Caption is empty. Add a caption (YouTube uses it as the description) and approve again.');
  const info = deps.platforms ? Object.fromEntries(targets.map(id => [id, { platform: deps.platforms[id] }])) : await accountInfo(targets);
  const plat = Object.fromEntries(targets.map(id => [id, info[id].platform || null]));
  // Made for kids: as set on the post, else yes when every YouTube account it goes to is a kids channel.
  const ytIds = targets.filter(id => plat[id] === 'youtube');
  const kids = typeof doc.made_for_kids === 'boolean' ? doc.made_for_kids : ytIds.length > 0 && ytIds.every(id => /kids/i.test(info[id].username || info[id].name || ''));
  const platforms = [...new Set(targets.map(id => plat[id]).filter(Boolean))];
  if (platforms.includes('youtube') && !doc.title) throw new Error('YouTube needs a title.');
  const cache = {};
  const up = async (u, type) => { if (!u) return undefined; const a = absUrl(u); if (!cache[a]) cache[a] = upload(a, type); return cache[a]; };

  // A carousel: several images or videos in one post (a PDF arrives here as its page images).
  const items = Array.isArray(doc.media_items) && doc.media_items.length > 1 ? doc.media_items : null;
  if (items) {
    if (platforms.includes('youtube')) throw new Error('YouTube can’t post a carousel. Untick the YouTube accounts and approve again.');
    const anyVideo = items.some(it => it.type === 'video');
    if (platforms.includes('linkedin') && anyVideo) throw new Error('LinkedIn carousels can only be images. Untick LinkedIn, or remove the videos, and approve again.');
    const media = [];
    for (const it of items) media.push({ url: await up(it.url, it.mime) });
    // How many items each platform takes: Instagram 10, X 4 images (or 1 video), Facebook 1 when there are videos.
    const cap = p => p === 'instagram' ? 10 : p === 'x' ? (anyVideo ? 1 : 4) : p === 'facebook' && anyVideo ? 1 : 20;
    const account_configurations = targets.filter(id => media.length > cap(plat[id])).map(id => ({ social_account_id: id, configuration: { media: media.slice(0, cap(plat[id])) } }));
    const pc = {};
    if (platforms.includes('instagram')) pc.instagram = { placement: doc.as_story ? 'stories' : 'timeline' };
    if (platforms.includes('facebook')) pc.facebook = { placement: doc.as_story ? 'stories' : 'timeline' };
    if (platforms.includes('x') && doc.captions && doc.captions.x) pc.x = { caption: doc.captions.x };
    if (platforms.includes('linkedin') && doc.captions && doc.captions.linkedin) pc.linkedin = { caption: doc.captions.linkedin };
    const body = { caption: doc.caption, social_accounts: targets, external_id: doc.id, media, platform_configurations: pc };
    if (account_configurations.length) body.account_configurations = account_configurations;
    if (!doc.post_now) body.scheduled_at = doc.slot_at;
    return body;
  }

  // Media per account.
  const per = {};
  for (const id of targets) {
    const am = doc.account_media && doc.account_media[id];
    per[id] = am ? { video: am.video, poster: am.poster || doc.poster_url } : { video: doc.media_url, poster: doc.poster_url };
    if (!per[id].video) throw new Error('This post has no media.');
  }
  const isVideo = (doc.media_type || 'video') === 'video';
  const counts = {};
  for (const id of targets) { const k = per[id].video + '|' + (per[id].poster || ''); counts[k] = (counts[k] || 0) + 1; }
  const mainKey = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const [mv, mp] = mainKey.split('|');
  const mainMedia = { url: await up(mv, doc.media_mime), ...(isVideo && mp ? { thumbnail_url: await up(mp) } : {}) };

  const account_configurations = [];
  for (const id of targets) {
    const k = per[id].video + '|' + (per[id].poster || '');
    if (k === mainKey) continue;
    account_configurations.push({ social_account_id: id, configuration: { media: [{ url: await up(per[id].video, doc.media_mime), ...(isVideo && per[id].poster ? { thumbnail_url: await up(per[id].poster) } : {}) }] } });
  }

  const pc = {};
  if (platforms.includes('youtube')) pc.youtube = { title: doc.title, description: doc.caption, ...(doc.yt_tags ? { tags: doc.yt_tags } : {}), category_id: '28', privacy_status: 'public', made_for_kids: kids };
  // "Post only as a story" puts it in Instagram and Facebook stories instead of the feed.
  if (platforms.includes('instagram')) pc.instagram = doc.as_story ? { placement: 'stories' } : isVideo ? { placement: 'reels', share_to_feed: true } : { placement: 'timeline' };
  if (platforms.includes('facebook')) pc.facebook = doc.as_story ? { placement: 'stories' } : isVideo ? { placement: 'reels' } : { placement: 'timeline' };
  if (platforms.includes('x') && doc.captions && doc.captions.x) pc.x = { caption: doc.captions.x };
  if (platforms.includes('linkedin') && doc.captions && doc.captions.linkedin) pc.linkedin = { caption: doc.captions.linkedin };

  const body = { caption: doc.caption, social_accounts: targets, external_id: doc.id, media: [mainMedia], platform_configurations: pc };
  if (account_configurations.length) body.account_configurations = account_configurations;
  if (!doc.post_now) body.scheduled_at = doc.slot_at;
  return body;
}

// "Also share it as a story": a second Post for Me post to the same Instagram/Facebook accounts, placement stories,
// at the same time and with the file those accounts get (the 9:16 cut when there is one). A story that fails is noted,
// never failing the post itself. Sent once; a later retry of the post doesn't send the story again.
async function sendStory(doc, body) {
  const info = await accountInfo(body.social_accounts);
  const ids = body.social_accounts.filter(id => ['instagram', 'facebook'].includes(info[id].platform));
  if (!ids.length) return;
  const own = ((body.account_configurations || []).find(a => a.social_account_id === ids[0]) || {}).configuration;
  const media = [{ url: ((own && own.media && own.media[0]) || body.media[0]).url }];
  const pc = {};
  for (const id of ids) pc[info[id].platform] = { placement: 'stories' };
  const story = { caption: body.caption, social_accounts: ids, external_id: doc.id + '-story', media, platform_configurations: pc };
  if (body.scheduled_at) story.scheduled_at = body.scheduled_at;
  const where = [...new Set(ids.map(id => info[id].platform === 'instagram' ? 'Instagram' : 'Facebook'))].join(' and ');
  try {
    const p = await pfm('POST', '/social-posts', story);
    await appendHistory(doc.id, { by: 'server', by_name: 'System', event: (body.scheduled_at ? 'also booked it as a story on ' : 'also sent it as a story to ') + where }, { story_pfm_post_id: p.id });
  } catch (e) {
    await appendHistory(doc.id, { by: 'server', by_name: 'System', event: 'the story on ' + where + ' didn’t go out', note: String(e.message || e).slice(0, 300) }, { story_done: true });
  }
}

// Has the story gone up? Noted in the post's history once Post for Me has finished with it.
export async function checkStory(doc) {
  const p = await pfm('GET', '/social-posts/' + encodeURIComponent(doc.story_pfm_post_id)).catch(() => null);
  if (!p || p.status !== 'processed') return null;
  const res = await postResults(doc.story_pfm_post_id).catch(() => []);
  const bad = res.filter(r => !r.success);
  await appendHistory(doc.id, bad.length
    ? { by: 'server', by_name: 'System', event: 'the story didn’t go out on ' + bad.length + ' of ' + res.length + ' accounts', note: bad.map(errText).join(' | ').slice(0, 300) }
    : { by: 'server', by_name: 'System', event: 'the story is live' }, { story_done: true });
  return bad.length ? 'failed' : 'published';
}

// Send one approved doc to Post for Me. Safe to call more than once: the claim stops double posting.
export async function publishDoc(id, by = 'server') {
  let doc = await getDoc('queue', id);
  if (!doc) return { ok: false, reason: 'not_found' };
  if (doc.status !== 'approved') return { ok: false, reason: 'not_approved' };
  if (doc.hold) return { ok: false, reason: 'on_hold' };
  if (doc.retry_at && new Date(doc.retry_at).getTime() > Date.now()) return { ok: false, reason: 'waiting_for_youtube' };
  if (doc.pfm_post_id) { const d = await prepareRetry(doc); if (!d) return { ok: false, reason: 'already_sent' }; doc = d; }
  if (!doc.post_now && new Date(doc.slot_at).getTime() < Date.now() + MIN_LEAD_MS) {
    await appendHistory(id, { by: 'server', by_name: 'System', event: 'slot passed before scheduling', note: 'Slot passed before scheduling. Pick a new time and approve again.' }, { status: 'changes' });
    return { ok: false, reason: 'slot_passed' };
  }
  if (!(await claimPost(id))) return { ok: false, reason: 'busy' };

  try {
    const body = await buildPost(doc);
    const post = await pfm('POST', '/social-posts', body);
    // Someone may have deleted it while the media was uploading: take it straight back out of Post for Me.
    const cur = await getDoc('queue', id);
    const now = new Date().toISOString();
    if (cur && cur.status === 'rejected') {
      try {
        await pfm('DELETE', '/social-posts/' + encodeURIComponent(post.id));
        await mergeDoc('queue', id, { publishing_at: { __delete__: true } });
        return { ok: false, reason: 'deleted' };
      } catch (e) {
        await appendHistory(id, { by: 'server', by_name: 'System', event: 'too late to delete · Post for Me was already posting it' }, { status: 'scheduled', pfm_post_id: post.id, scheduled_in_pfm_at: now, publishing_at: { __delete__: true } });
        return { ok: true, pfm_post_id: post.id };
      }
    }
    await appendHistory(id, { by: 'server', by_name: 'System', event: (doc.send_targets ? 'sent again to the accounts that failed' : doc.post_now ? 'sent to Post for Me to publish now' : 'scheduled in Post for Me') }, { status: 'scheduled', pfm_post_id: post.id, scheduled_in_pfm_at: now, publishing_at: { __delete__: true }, retry_at: { __delete__: true } });
    if (doc.also_story && !doc.as_story && !doc.story_pfm_post_id && !doc.story_done) { try { await sendStory(doc, body); } catch (e) {} }
    if (doc.post_now) {
      // Give the platforms a moment, then try to mark it live straight away.
      for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 5000)); const r = await checkPublished(id); if (r && r !== 'pending') break; }
    }
    return { ok: true, pfm_post_id: post.id };
  } catch (e) {
    const cur = await getDoc('queue', id);
    if (cur && cur.status === 'rejected') return { ok: false, reason: 'deleted' };
    // Post for Me asked us to slow down (too many posts sent at once): not a failure, the loop sends it again shortly.
    if (e && e.status === 429) {
      await appendHistory(id, { by: 'server', by_name: 'System', event: 'Post for Me was busy; it tries again by itself in about 10 minutes' }, { publishing_at: { __delete__: true }, retry_at: new Date(Date.now() + 9 * 6e4).toISOString() });
      return { ok: false, reason: 'busy_retry' };
    }
    await appendHistory(id, { by: 'server', by_name: 'System', event: 'failed to send to Post for Me', note: String(e.message || e).slice(0, 500) }, { status: 'failed', publishing_at: { __delete__: true } });
    return { ok: false, reason: 'error', error: String(e.message || e) };
  }
}

// Delete a post before it goes live. Post for Me only lets a post go while it is still waiting (draft or scheduled);
// once it is processing or live it stays, and the team removes it on the platform itself.
export async function deleteDoc(id, user = {}) {
  const doc = await getDoc('queue', id);
  if (!doc) return { ok: false, reason: 'not_found', error: 'This post no longer exists.' };
  if (doc.status === 'rejected') return { ok: true };
  if (doc.status === 'published') return { ok: false, reason: 'live', error: 'It is already live, so it can’t be deleted from here. Remove it on the platform itself.' };
  if (doc.status === 'approved' && doc.publishing_at && Date.now() - new Date(doc.publishing_at).getTime() < 10 * 60 * 1000) {
    // publishDoc is uploading it right now; marking it deleted makes publishDoc take it back out as soon as it lands.
    await appendHistory(id, { by: user.id || 'team', by_name: user.name, event: 'deleted it before it went out' }, { status: 'rejected', hold: false });
    return { ok: true };
  }
  if (doc.story_pfm_post_id && !doc.story_done) { try { await pfm('DELETE', '/social-posts/' + encodeURIComponent(doc.story_pfm_post_id)); } catch (e) {} }
  if (doc.status === 'failed') {
    await appendHistory(id, { by: user.id || 'team', by_name: user.name, event: 'deleted it' }, { status: 'rejected', hold: false });
    return { ok: true };
  }
  if (doc.pfm_post_id) {
    try { await pfm('DELETE', '/social-posts/' + encodeURIComponent(doc.pfm_post_id)); }
    catch (e) {
      const results = await postResults(doc.pfm_post_id).catch(() => []);
      return results.length
        ? { ok: false, reason: 'live', error: 'It has already gone out, so it can’t be deleted from here. Remove it on the platform itself.' }
        : { ok: false, reason: 'too_late', error: 'Post for Me has started posting it, so it can’t be stopped now. Once it’s live, remove it on the platform itself.' };
    }
  }
  await appendHistory(id, { by: user.id || 'team', by_name: user.name, event: 'deleted it before it went out' }, { status: 'rejected', hold: false });
  return { ok: true };
}

// Step 6: look up results for a scheduled post. Returns 'published' | 'failed' | 'pending'.
export async function checkPublished(id) {
  const doc = await getDoc('queue', id);
  if (!doc || doc.status !== 'scheduled' || !doc.pfm_post_id) return null;
  const results = await postResults(doc.pfm_post_id);
  const expected = (doc.send_targets || doc.targets || doc.account_ids || []).filter(x => !excluded().includes(x)).length || 1;
  if (!results.length) return 'pending';
  const bad = results.filter(r => !r.success);
  const urls = results.filter(r => r.success).map(r => (r.platform_data && r.platform_data.url) || r.platform_url).filter(Boolean);
  if (bad.length) {
    const note = bad.map(r => errText(r) || 'unknown error').join(' | ').slice(0, 500);
    const failedIds = [...new Set(bad.map(r => r.social_account_id).filter(Boolean))];
    const after = { live_url: doc.live_url || urls[0] || null, live_urls: mergeUrls(doc.live_urls, urls), pfm_post_id: { __delete__: true }, earlier_pfm_post_ids: [...(doc.earlier_pfm_post_ids || []), doc.pfm_post_id] };
    if (failedIds.length) after.send_targets = failedIds;
    const tries = doc.quota_retries || 0;
    if (failedIds.length && tries < 3 && bad.every(r => YT_QUOTA.test(errText(r)))) {
      const at = nextQuotaReset();
      await appendHistory(id, { by: 'server', by_name: 'System', event: 'YouTube’s daily upload limit was reached; it tries again by itself ' + istTime(at), note }, { ...after, status: 'approved', post_now: true, retry_at: at.toISOString(), quota_retries: tries + 1 });
      return 'retrying';
    }
    await appendHistory(id, { by: 'server', by_name: 'System', event: 'failed on ' + bad.length + ' of ' + results.length + ' accounts', note }, { ...after, status: 'failed' });
    return 'failed';
  }
  if (results.length < expected) return 'pending';
  const patch = { status: 'published', live_url: doc.live_url || urls[0] || null, live_urls: mergeUrls(doc.live_urls, urls), published_at: new Date().toISOString(), send_targets: { __delete__: true }, retry_at: { __delete__: true } };
  await appendHistory(id, { by: 'server', by_name: 'System', event: 'published' + (urls[0] ? ' · ' + urls[0] : '') }, patch);
  if (doc.yt_playlist) await appendHistory(id, { by: 'server', by_name: 'System', event: 'published · add to YouTube playlist “' + doc.yt_playlist + '” in YouTube Studio' }, { needs_playlist: true });
  return 'published';
}

// One pass of the background loop.
export async function tick() {
  const out = { sent: [], published: [], failed: [], skipped: [] };
  const approved = await listDocs('queue', { status: 'approved' });
  approved.sort((a, b) => (b.post_now ? 1 : 0) - (a.post_now ? 1 : 0));
  for (const d of approved) {
    if (d.hold || (d.retry_at && new Date(d.retry_at).getTime() > Date.now())) continue;
    const r = await publishDoc(d.id);
    (r.ok ? out.sent : out.skipped).push(d.id + (r.reason ? ':' + r.reason : ''));
  }
  const scheduled = await listDocs('queue', { status: 'scheduled' });
  for (const d of scheduled) {
    if (!d.post_now && new Date(d.slot_at).getTime() > Date.now()) continue;
    try { const r = await checkPublished(d.id); if (r === 'published') out.published.push(d.id); if (r === 'failed') out.failed.push(d.id); }
    catch (e) { out.skipped.push(d.id + ':check_error'); }
  }
  // Stories sent alongside posts: note when they go up (or don't).
  const stories = (await listDocs('queue', { status: ['scheduled', 'published', 'failed'] })).filter(d => d.story_pfm_post_id && !d.story_done && (d.post_now || new Date(d.slot_at).getTime() <= Date.now()));
  for (const d of stories) { try { await checkStory(d); } catch (e) {} }
  return out;
}
