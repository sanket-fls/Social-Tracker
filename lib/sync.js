// Port of claude/social-tools/sync.py and insights.py: pulls every account feed from Post for Me.
import { pfm, excluded } from './pfm.js';
import { getDoc, setDoc, mergeDoc, istDate } from './store.js';

const NORM = { likeCount: 'likes', commentCount: 'comments', shareCount: 'shares', impressionCount: 'impressions', clickCount: 'clicks', viewCount: 'views', reactionCount: 'reactions', retweet_count: 'retweets', reply_count: 'replies', like_count: 'likes', impression_count: 'impressions', quote_count: 'quotes', bookmark_count: 'bookmarks' };
const KEEP = ['engagement', 'views', 'likes', 'comments', 'shares', 'impressions', 'reach', 'estimatedMinutesWatched', 'subscribersGained', 'subscribersLost', 'retweets', 'replies', 'quotes', 'bookmarks', 'reactions', 'clicks'];
const DAY = 864e5;

function postTime(d) {
  if (d.posted_at) return d.posted_at;
  if (d.platform === 'x' && /^\d+$/.test(String(d.platform_post_id || ''))) {
    const ms = Number((BigInt(d.platform_post_id) >> 22n) + 1288834974657n);
    return new Date(ms).toISOString();
  }
  return null;
}
const parse = s => new Date(String(s).replace('+0000', '+00:00'));
function metricsOf(d) { const m = d.metrics || {}; return m.public_metrics && typeof m.public_metrics === 'object' ? { ...m.public_metrics } : m; }
function flat(m) {
  const f = {};
  const add = (k, v) => { const n = NORM[k] || k; f[n] = (f[n] || 0) + v; };
  for (const [k, v] of Object.entries(m || {})) {
    if (typeof v === 'number') add(k, v);
    else if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) if (typeof v2 === 'number') add(k2, v2);
  }
  return f;
}

async function feed(accId, pages) {
  const items = []; let cur = null;
  for (let i = 0; i < pages; i++) {
    let r, last;
    for (let attempt = 0; attempt < 4 && !r; attempt++) {
      try { r = await pfm('GET', `/social-account-feeds/${accId}?limit=50&expand=metrics` + (cur ? '&cursor=' + encodeURIComponent(cur) : '')); }
      catch (e) { last = e; if (e.status && e.status < 500 && e.status !== 429) break; await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); }
    }
    if (!r) { if (last) console.warn('feed', accId, last.message); break; }
    items.push(...(r.data || []));
    const m = r.meta || {}; cur = m.has_more ? m.cursor : null;
    if (!cur) break;
  }
  return items;
}

export async function fetchAll(pages = 8) {
  const ex = excluded();
  const accs = (await pfm('GET', '/social-accounts?limit=50')).data.filter(a => !ex.includes(a.id));
  // Two at a time: Post for Me rate-limits bursts of feed requests.
  const feeds = []; const queue = accs.slice();
  const worker = async () => { while (queue.length) { const a = queue.shift(); feeds.push({ a, items: await feed(a.id, pages) }); } };
  await Promise.all([worker(), worker()]);
  return accs.map(a => feeds.find(f => f.a.id === a.id));
}

export function buildSync(feeds, now = new Date()) {
  const dow = (now.getUTCDay() + 6) % 7;
  const wk0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow);
  const weeks = Array.from({ length: 12 }, (_, i) => new Date(wk0 - (11 - i) * 7 * DAY));
  const out = { synced_at: now.toISOString().slice(0, 19) + 'Z', weeks: weeks.map(w => w.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })), accounts: {} };
  for (const { a, items } of feeds) {
    const rows = [];
    for (const d of items) {
      const t = postTime(d); if (!t) continue; const at = parse(t); if (isNaN(at)) continue;
      const fm = flat(metricsOf(d));
      const title = (((d.platform_data || {}).title) || (d.caption || '').split('\n')[0]).slice(0, 110);
      rows.push({ id: d.platform_post_id, title, at: at.toISOString().slice(0, 19) + 'Z', url: d.platform_url, m: Object.fromEntries(Object.entries(fm).filter(([k]) => KEEP.includes(k))), keys: Object.keys(fm) });
    }
    rows.sort((x, y) => y.at.localeCompare(x.at));
    const weekly = weeks.map(w => rows.filter(r => { const t = parse(r.at); return t >= w && t < new Date(w.getTime() + 7 * DAY); }).length);
    const l30 = rows.filter(r => parse(r.at) > new Date(now - 30 * DAY));
    const tot = {}; l30.forEach(r => Object.entries(r.m).forEach(([k, v]) => tot[k] = (tot[k] || 0) + v));
    const keys = [...new Set(rows.flatMap(r => r.keys).filter(k => KEEP.includes(k)))].sort();
    const kind = (a.metadata || {}).connection_type || null;
    const personal = a.platform === 'youtube' || (a.platform === 'linkedin' && kind === 'personal');
    const info = { platform: a.platform, username: a.username, kind, status: a.status, total_posts: rows.length, posts_30d: l30.length, weekly, last_post: rows[0] ? rows[0].at : null, metrics_30d: tot, metrics_available: keys, personal };
    if (a.platform !== 'youtube') info.recent = rows.slice(0, 15).map(({ id, title, at, url, m }) => ({ id, title, at, url, m }));
    out.accounts[a.id] = info;
  }
  return out;
}

// Themes the Ideas page groups posts by (AI-focused accounts). Edit these regexes to match your own content.
const THEMES = [['AI tools for work', /ai tools for work|\btool:|free plan|free credits|notebooklm|gamma|chatgpt|claude|gemini|perplexity|cursor/m],
  ['Leaders on AI', /\bceo\b|founder of|\bsays\b|dario|amodei|elon|musk|altman|sundar|pichai|nadella|jensen|huang|hassabis|zuckerberg/m],
  ['AI news & launches', /launch|released|update|this week|announced|new model|open model|\bnews\b/m],
  ['Questions & debate', /\?\s*$|what do you think|will ai|should|do you/m],
  ['Our work', /workshop|cohort|bootcamp|session|client|academy|accelerator|we built|our team/m],
  ['Future of work', /jobs|career|skills?|future of work|engineer|hiring|workforce/m]];
const IST = 330 * 6e4;

export function buildInsights(feeds, now = new Date()) {
  const posts = [];
  for (const { a, items } of feeds) for (const d of items) {
    const t = postTime(d); if (!t) continue; const cap = d.caption || '';
    posts.push({ acc: a.id, platform: a.platform, personal: a.platform === 'youtube' || ((a.metadata || {}).connection_type === 'personal'), at: parse(t), cap, title: (((d.platform_data || {}).title) || cap.split('\n')[0]).slice(0, 110), url: d.platform_url, m: flat(metricsOf(d)) });
  }
  const brand = posts.filter(p => !p.personal);
  const win = brand.filter(p => p.at > new Date(now - 90 * DAY));
  const theme = c => { const s = c.toLowerCase(); for (const [n, rx] of THEMES) if (rx.test(s)) return n; return 'Other'; };
  const th = {};
  for (const p of win) {
    const n = theme(p.cap); const T = th[n] = th[n] || { posts: 0, comments: 0, shares: 0, views: 0, likes: 0, impressions: 0, platforms: {}, ex: null };
    T.posts++; T.platforms[p.platform] = (T.platforms[p.platform] || 0) + 1;
    for (const k of ['comments', 'shares', 'views', 'likes', 'impressions']) T[k] += p.m[k] || 0;
    if (!T.ex || p.at > T.ex.at) T.ex = p;
  }
  const tot = Object.values(th).reduce((s, v) => s + v.posts, 0) || 1;
  const themes = Object.entries(th).map(([k, v]) => ({ name: k, posts: v.posts, share: Math.round(v.posts / tot * 100), comments: v.comments, shares: v.shares, views: v.views, eng_per_post: v.posts ? Math.round((v.comments + v.shares + v.likes) / v.posts * 100) / 100 : 0, impressions: v.impressions, platforms: v.platforms, example: v.ex.title, example_url: v.ex.url })).sort((a, b) => b.posts - a.posts);
  const tags = {}; win.forEach(p => (p.cap.match(/#(\w+)/g) || []).forEach(t => { t = t.slice(1).toLowerCase(); tags[t] = (tags[t] || 0) + 1; }));
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0)), eng = Array.from({ length: 7 }, () => Array(24).fill(0));
  win.forEach(p => { const l = new Date(p.at.getTime() + IST); const d = (l.getUTCDay() + 6) % 7, h = l.getUTCHours(); heat[d][h]++; eng[d][h] += (p.m.comments || 0) + (p.m.shares || 0); });
  const fb = win.filter(p => p.platform === 'facebook'), ig = win.filter(p => p.platform === 'instagram');
  const igs = new Set(ig.map(p => p.title.slice(0, 40).toLowerCase()));
  const cross = fb.filter(p => igs.has(p.title.slice(0, 40).toLowerCase())).length;
  const score = p => (p.m.comments || 0) * 3 + (p.m.shares || 0) * 5 + (p.m.views || 0) * .1 + (p.m.likes || 0);
  const top = win.filter(p => Object.keys(p.m).length).sort((a, b) => score(b) - score(a)).slice(0, 8);
  const days = new Set(brand.map(p => new Date(p.at.getTime() + IST).toISOString().slice(0, 10)));
  let streak = 0; let d = new Date(now.getTime() + IST); const today = d.toISOString().slice(0, 10);
  const prev = x => new Date(x.getTime() - DAY);
  while (days.has(d.toISOString().slice(0, 10)) || (d.toISOString().slice(0, 10) === today && days.has(prev(d).toISOString().slice(0, 10)))) { if (days.has(d.toISOString().slice(0, 10))) streak++; d = prev(d); }
  const MK = ['views', 'likes', 'comments', 'shares', 'impressions', 'clicks', 'engagement', 'reach', 'estimatedMinutesWatched', 'subscribersGained'];
  const coverage = {}; for (const { a } of feeds) { const ps = posts.filter(p => p.acc === a.id); coverage[a.id] = { platform: a.platform, posts: ps.length, metric_keys: [...new Set(ps.flatMap(p => Object.keys(p.m)).filter(k => MK.includes(k)))].sort() }; }
  const yt = posts.filter(p => p.platform === 'youtube' && p.at > new Date(now - 90 * DAY));
  const sum = (arr, k) => arr.reduce((s, p) => s + (p.m[k] || 0), 0);
  return {
    generated_at: now.toISOString().slice(0, 19) + 'Z', window_days: 90, brand_posts_90d: win.length, per_week: Math.round(win.length / 13 * 10) / 10, streak_days: streak,
    caption_len_avg: Math.round(win.reduce((s, p) => s + p.cap.length, 0) / Math.max(1, win.length)), crosspost_fb_ig: { fb: fb.length, matched: cross },
    themes, hashtags: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, count]) => ({ tag, count })), heat, heat_eng: eng,
    top_posts: top.map(p => ({ acc: p.acc, platform: p.platform, title: p.title, url: p.url, at: p.at.toISOString().slice(0, 19) + 'Z', m: Object.fromEntries(['views', 'likes', 'comments', 'shares'].filter(k => k in p.m).map(k => [k, p.m[k]])) })),
    youtube_90d: { uploads: yt.length, views: sum(yt, 'views'), minutes: sum(yt, 'estimatedMinutesWatched') },
    coverage, totals_90d: Object.fromEntries(['comments', 'shares', 'views', 'likes', 'impressions', 'clicks'].map(k => [k, sum(win, k)])),
  };
}

// Full sync: numbers, accounts, today's snapshot and the computed half of insights (Claude's recos and trends are kept).
export async function runSync() {
  const feeds = await fetchAll(8);
  const s = buildSync(feeds);
  await setDoc('sync', 'latest', s);
  for (const [id, a] of Object.entries(s.accounts)) await mergeDoc('accounts', id, { platform: a.platform, username: a.username, kind: a.kind, status: a.status });
  await setDoc('snapshots', istDate(), { at: s.synced_at, accounts: Object.fromEntries(Object.entries(s.accounts).map(([id, a]) => [id, { posts_30d: a.posts_30d, metrics_30d: a.metrics_30d }])) });
  const prev = (await getDoc('insights', 'latest')) || {};
  const ins = buildInsights(feeds);
  await setDoc('insights', 'latest', { ...ins, recos: prev.recos || [], trends: prev.trends || [], recos_at: prev.recos_at || null });
  const ref = await getDoc('requests', 'refresh');
  if (ref) await mergeDoc('requests', 'refresh', { done_at: new Date().toISOString() });
  return { accounts: Object.keys(s.accounts).length, posts: Object.values(s.accounts).reduce((n, a) => n + a.total_posts, 0) };
}
