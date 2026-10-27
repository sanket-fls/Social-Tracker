// Gives the dashboard the same small API it had as a claude.ai artifact (claude.use('db' | 'user' | 'assets')),
// backed by Supabase: team sign-in, one live table of documents, and file storage.
(function () {
  // The page's router rewrites location.hash to a view name as soon as it loads, which would wipe the
  // tokens a sign-in link arrives with. Read them (or the link's error) now, before anything else runs.
  const link = new URLSearchParams(location.hash.slice(1));
  const linkSession = link.get('access_token') && link.get('refresh_token') ? { access_token: link.get('access_token'), refresh_token: link.get('refresh_token') } : null;
  const linkError = link.get('error_description');

  const ready = (async () => {
    const cfg = await fetch('/api/config').then(r => r.json());
    window.flMaxMb = cfg.maxUploadMb || 50;
    window.flBigMb = cfg.bigUploadMb || window.flMaxMb;
    if (cfg.teamName) { window.flTeam = cfg.teamName; brand(); }
    if (!cfg.supabaseUrl) throw new Error('Server is missing SUPABASE_URL / SUPABASE_ANON_KEY');
    const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: false } });
    if (cfg.openAccess) {
      // No sign-in: everyone works as the shared "Team" user, so there is nothing to sign out of.
      const out = document.querySelector('[onclick="flSignOut()"]'); if (out) out.remove();
      return { sb, session: null, user: null, name: 'Team', open: true };
    }
    if (linkSession) { const { error } = await sb.auth.setSession(linkSession); if (error) console.error('Sign-in link rejected:', error.message); }
    let { data: { session } } = await sb.auth.getSession();
    if (!session) session = await login(sb, linkError || (linkSession ? 'That sign-in link did not work. Request a new one.' : ''));
    const { data: ok } = await sb.rpc('is_team');
    if (!ok) { gate('This account (' + session.user.email + ') is not on the team list. Ask an admin to add it, or sign in with your work email.', sb); throw new Error('not team'); }
    sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') location.reload(); });
    const u = session.user;
    const name = (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || u.email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    await sb.from('docs').upsert({ collection: 'people', id: u.id, data: { name, email: u.email, seen_at: new Date().toISOString() } });
    return { sb, session, user: u, name };
  })();

  // TEAM_NAME (from /api/config) replaces the default "Social Command" in the sidebar, the crumbs and the tab title.
  function initials(t) { return String(t).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toLowerCase() || 'sc'; }
  function esc(t) { return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  function brand() {
    const t = window.flTeam;
    document.querySelectorAll('[data-team]').forEach(e => { e.textContent = t; });
    document.querySelectorAll('[data-team-sub]').forEach(e => { e.textContent = 'Social command'; });
    document.querySelectorAll('[data-team-mark]').forEach(e => { e.textContent = initials(t); });
    const c = document.getElementById('crumbs'); if (c) c.textContent = c.textContent.replace(/^[^/]*\//, t + ' /');
    document.title = document.title.replace(/^Social Command/, t + ' Social Command');
  }

  function gate(msg, sb) {
    let el = document.getElementById('fl-gate');
    if (!el) { el = document.createElement('div'); el.id = 'fl-gate'; document.body.appendChild(el); }
    el.style.cssText = 'position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:var(--bg);padding:16px';
    el.innerHTML = '<div class="panel" style="max-width:380px;width:100%;padding:28px"><div class="brand" style="padding:0;margin-bottom:18px"><div class="mark">' + initials(window.flTeam || 'Social Command') + '</div><div><b>' + esc(window.flTeam || 'Social Command') + '</b><small>' + (window.flTeam ? 'Social command' : 'Posting dashboard') + '</small></div></div><p style="margin:0 0 16px;color:var(--ink2)">' + msg + '</p>' + (sb ? '<button class="btn" id="fl-out">Sign out</button>' : '') + '</div>';
    const b = document.getElementById('fl-out'); if (b) b.onclick = () => sb.auth.signOut().then(() => location.reload());
  }

  function login(sb, note) {
    return new Promise(resolve => {
      gate('', null);
      const el = document.getElementById('fl-gate');
      el.querySelector('p').outerHTML = '<p style="margin:0 0 14px;color:var(--ink2)">Sign in with your work email. We’ll email you a link.</p><div class="field"><input id="fl-email" type="email" placeholder="you@company.com" autocomplete="email"></div><button class="btn pri" id="fl-send" style="margin-top:12px;width:100%;justify-content:center">Email me a sign-in link</button><p id="fl-msg" class="muted" style="margin:12px 0 0"></p>';
      if (note) document.getElementById('fl-msg').textContent = note;
      const send = async () => {
        const email = document.getElementById('fl-email').value.trim();
        if (!email) return;
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        document.getElementById('fl-msg').textContent = error ? 'Could not send: ' + error.message : 'Check ' + email + ' for the link. You can close this tab.';
      };
      document.getElementById('fl-send').onclick = send;
      document.getElementById('fl-email').onkeydown = e => { if (e.key === 'Enter') send(); };
      sb.auth.onAuthStateChange((ev, s) => { if (s) { el.remove(); resolve(s); } });
    });
  }

  // Open access (no sign-in): documents go through the server's /api/docs instead of straight to Supabase.
  async function docsApi(method, query, body) {
    const r = await fetch('/api/docs' + (query || ''), method === 'GET' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(j.error || 'Server error ' + r.status);
    return j;
  }
  function liveStatus(ok, text) { const t = document.getElementById('livetxt'), d = document.getElementById('pulse'); if (t) t.textContent = text; if (d) d.classList.toggle('off', !ok); }

  // ---- live document store ----
  function makeDb(ctx) {
    const { sb } = ctx;
    const viaServer = !!ctx.open;
    const cache = {};            // collection -> Map(id -> data)
    const listeners = new Set(); // {kind:'col'|'doc', col, id, cb}
    const col = c => cache[c] || (cache[c] = new Map());
    const snapCol = c => ({ docs: [...col(c).entries()].map(([id, d]) => ({ id, data: () => d, exists: true })), size: col(c).size });
    const snapDoc = (c, id) => { const d = col(c).get(id); return { id, exists: !!d, data: () => d }; };
    const notify = c => listeners.forEach(l => { if (l.col === c) l.cb(l.kind === 'col' ? snapCol(c) : snapDoc(c, l.id)); });
    const put = (c, id, d) => { const cur = col(c).get(id); if (d && cur && JSON.stringify(cur) === JSON.stringify(d)) return; if (d) col(c).set(id, d); else col(c).delete(id); notify(c); };
    // Writes return the stored document, since the server may drop fields visitors cannot set.
    async function write(op, c, id, data) {
      if (viaServer) return (await docsApi('POST', '', { op, collection: c, id, data })).data;
      const q = op === 'insert' ? sb.from('docs').insert({ collection: c, id, data }) : op === 'set' ? sb.from('docs').upsert({ collection: c, id, data }) : sb.from('docs').update({ data }).eq('collection', c).eq('id', id);
      const { error } = await q; if (error) throw error;
      return data;
    }

    const loaded = (async () => {
      if (viaServer) {
        const first = await docsApi('GET');
        first.docs.forEach(r => col(r.collection).set(r.id, r.data));
        let cursor = first.cursor;
        const poll = async () => {
          try {
            const j = await docsApi('GET', cursor ? '?since=' + encodeURIComponent(cursor) : '');
            j.docs.forEach(r => put(r.collection, r.id, r.data));
            if (j.cursor) cursor = j.cursor;
            liveStatus(true, 'Live');
          } catch (e) { liveStatus(false, 'Reconnecting…'); }
          setTimeout(poll, document.hidden ? 15000 : 4000);
        };
        liveStatus(true, 'Live'); setTimeout(poll, 4000);
        Object.keys(cache).forEach(notify);
        return;
      }
      let from = 0; const page = 1000;
      for (;;) {
        const { data, error } = await sb.from('docs').select('collection,id,data').range(from, from + page - 1);
        if (error) throw error;
        data.forEach(r => col(r.collection).set(r.id, r.data));
        if (data.length < page) break; from += page;
      }
      sb.channel('docs-live').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, p => {
        const r = p.new && p.new.collection ? p.new : p.old;
        if (!r || !r.collection) return;
        put(r.collection, r.id, p.eventType === 'DELETE' ? null : p.new.data);
      }).subscribe(status => liveStatus(status === 'SUBSCRIBED', status === 'SUBSCRIBED' ? 'Live' : 'Reconnecting…'));
      Object.keys(cache).forEach(notify);
    })();

    const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
    function docRef(c, id) {
      return {
        id,
        async get() { await loaded; return snapDoc(c, id); },
        async set(data) { put(c, id, await write('set', c, id, data)); },
        async update(patch) {
          await loaded;
          const cur = col(c).get(id);
          if (!cur) throw new Error('Not found: ' + c + '/' + id);
          // The server merges the patch itself, so a teammate's newer fields are not overwritten from a stale copy.
          put(c, id, await write('update', c, id, viaServer ? patch : { ...cur, ...patch }));
        },
        onSnapshot(cb) { const l = { kind: 'doc', col: c, id, cb }; listeners.add(l); loaded.then(() => cb(snapDoc(c, id))); return () => listeners.delete(l); },
      };
    }
    return {
      collection(c) {
        return {
          doc: id => docRef(c, id),
          async add(data) { const id = rid(); put(c, id, await write('insert', c, id, data)); return { id }; },
          onSnapshot(cb) { const l = { kind: 'col', col: c, cb }; listeners.add(l); loaded.then(() => cb(snapCol(c))); return () => listeners.delete(l); },
        };
      },
      doc(path) { const [c, id] = path.split('/'); return docRef(c, id); },
      _cache: cache,
    };
  }

  let dbInst;
  const api = {
    async db() { const c = await ready; return dbInst || (dbInst = makeDb(c)); },
    async user() {
      const c = await ready; const db = await api.db();
      return {
        id: async () => c.user ? c.user.id : null,
        me: async () => ({ id: c.user ? c.user.id : null, name: c.name }),
        isOwner: () => false, canEdit: () => true,
        profiles: async ids => Object.fromEntries(ids.map(i => [i, { name: ((db._cache.people && db._cache.people.get(i)) || {}).name || '' }])),
      };
    },
    async assets() {
      const c = await ready;
      return {
        async upload(blob, opts = {}) {
          const max = window.flMaxMb || 50, big = window.flBigMb || max;
          if (blob.size > big * 1048576) throw new Error('Files must be under ' + big + ' MB. Export a smaller version and try again.');
          if (blob.size > max * 1048576) {
            // Over our storage limit: straight into Post for Me's storage, which the post then uses as it is.
            const s = await window.flApi('/api/publish', { bigupload: true });
            if (!s.upload_url) throw new Error(s.error || 'Could not get an upload link for a big file.');
            const put = await fetch(s.upload_url, { method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
            if (!put.ok) throw new Error('The big file didn’t upload (' + put.status + '). Try again.');
            return { id: s.url, url: s.url, sizeBytes: blob.size, contentType: blob.type };
          }
          const type = opts.type || blob.type || 'application/octet-stream';
          const ext = ((blob.name || '').split('.').pop() || type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5);
          if (c.open) {
            // No sign-in: the server hands out a one-time upload slot instead.
            const s = await docsApi('POST', '', { op: 'upload', ext });
            const { error } = await c.sb.storage.from('media').uploadToSignedUrl(s.path, s.token, blob, { contentType: type });
            if (error) throw error;
            return { id: s.path, url: s.publicUrl, sizeBytes: blob.size, contentType: type };
          }
          const path = 'team/' + new Date().toISOString().slice(0, 10) + '/' + crypto.randomUUID() + '.' + ext;
          const { error } = await c.sb.storage.from('media').upload(path, blob, { contentType: type, upsert: false });
          if (error) throw error;
          const url = c.sb.storage.from('media').getPublicUrl(path).data.publicUrl;
          return { id: path, url, sizeBytes: blob.size, contentType: type };
        },
      };
    },
  };

  // Calls a server route as the signed-in team member (or as the shared "Team" user in open access).
  window.flApi = async (path, body) => {
    const c = await ready;
    const { data: { session } } = await c.sb.auth.getSession();
    const headers = { 'Content-Type': 'application/json' };
    if (session) headers.Authorization = 'Bearer ' + session.access_token;
    const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    let j = {}; try { j = await r.json(); } catch (e) {}
    return { status: r.status, ...j };
  };
  window.flSignOut = async () => { const c = await ready; await c.sb.auth.signOut(); location.reload(); };

  window.claude = { use: async name => { try { return api[name] ? await api[name]() : null; } catch (e) { console.error(e); return null; } } };
})();
