// Read-only smoke test: pulls the feeds from Post for Me and prints what the sync would write.
// Usage: PFM_KEY=... PFM_EXCLUDE=... node scripts/check.mjs [out.json]
import { fetchAll, buildSync, buildInsights } from '../lib/sync.js';
import { writeFileSync } from 'node:fs';

const feeds = await fetchAll(8);
const s = buildSync(feeds);
const i = buildInsights(feeds);
for (const [id, a] of Object.entries(s.accounts)) console.log(a.platform.padEnd(10), String(a.username).padEnd(22), 'posts', a.total_posts, '30d', a.posts_30d, a.metrics_available.join(','));
console.log('insights: brand 90d', i.brand_posts_90d, 'per week', i.per_week, 'themes', i.themes.map(t => t.name + ' ' + t.share + '%').join(' · '));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ sync: s, insights: i }));
