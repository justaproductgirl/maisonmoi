/* Maison Moi cloud: sign-in (Supabase Auth) and syncing your closet to your account.
   The app always runs from this browser's copy, so it's instant and works offline; each change is pushed
   to Supabase a moment later. Photos go to a private storage bucket, one folder per person. */
// Two environments. Production is maisonmoi.app; everywhere else (sandbox.maisonmoi.app, localhost, this Mac's file copy)
// is the sandbox, with its own Supabase project and Stripe test mode, so testing never touches real people.
// Publishable keys are safe in public code: row level security guards the data.
const ENVS = {
  production: {url:'https://mkfiiqkbtqbjksdzzykv.supabase.co', key:'sb_publishable_kcy8Iqb5nZk7s1Gb13ZsWA_CCqKgFdM'},
  sandbox:    {url:'https://tbzlysqumxvqljjxmegu.supabase.co', key:'sb_publishable_zu6P3-rwrp-pXjE11jMVow_rV9hHg-h'},
};
const ENV = /^(www\.)?maisonmoi\.app$/.test(location.hostname) ? 'production' : 'sandbox';
const CLOUD_URL = ENVS[ENV].url, CLOUD_KEY = ENVS[ENV].key;
if (ENV === 'sandbox') addEventListener('DOMContentLoaded', () => document.body.insertAdjacentHTML('beforeend',
  '<div style="position:fixed;left:10px;bottom:10px;z-index:9999;background:#ffd400;color:#000;font:700 11px/1 monospace;letter-spacing:1px;padding:7px 9px;border:1.5px solid #000;pointer-events:none">SANDBOX · TEST DATA</div>'));
const PHOTO_BUCKET = 'closet-photos';
const DEVICE_ONLY = ['items', 'tab', 'weather', 'cloudUser', 'cloudRev', '_unsynced', 'localOnly', 'sub']; // never copied into closet_state
const CLOUD = {db:null, user:null, checked:false, busy:false, again:false, t:0, retry:0, status:'', at:0, msg:'',
  sent:{items:{}, state:'', profile:''}, signed:{}};

const cloudOn = () => !!CLOUD.db;
const cloudGate = () => cloudOn() && !CLOUD.user && !S.localOnly;          // show the sign-in screen
const cloudImg = v => typeof v === 'string' && v.startsWith('sb:') ? (CLOUD.signed[v.slice(3)] || '') : v;
const cloudWrite = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch(e){} };
const chunks = (a, n) => Array.from({length:Math.ceil(a.length / n)}, (_, i) => a.slice(i * n, i * n + n));
// Plus is on while Stripe says trialing or active ('comped' is a free pass set by hand). The webhook is the only writer of this table.
const isPlus = () => !!(CLOUD.user || (!CLOUD.checked && S.cloudUser)) && ['trialing', 'active', 'comped'].includes((S.sub || {}).status);
const newRev = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function cloudStart(){
  if (!window.supabase || !supabase.createClient) return; // offline or CDN blocked: keep running from this browser
  CLOUD.db = supabase.createClient(CLOUD_URL, CLOUD_KEY);
  const {data} = await CLOUD.db.auth.getSession();
  CLOUD.user = data.session ? data.session.user : null;
  CLOUD.checked = true;
  CLOUD.db.auth.onAuthStateChange((ev, session) => {
    const was = CLOUD.user && CLOUD.user.id;
    CLOUD.user = session ? session.user : null;
    if (ev === 'SIGNED_IN' && CLOUD.user && CLOUD.user.id !== was) cloudPull();
  });
  if (CLOUD.user) await cloudPull(); else render();
  addEventListener('online', () => CLOUD.user && cloudQueue());
}

/* ---- Pull: load your closet from your account (or move this browser's closet into a brand-new account) ---- */
async function cloudPull(){
  const db = CLOUD.db, uid = CLOUD.user.id;
  CLOUD.status = 'loading'; render();
  try {
    const [st, it, pr] = await Promise.all([
      db.from('closet_state').select('state').eq('user_id', uid).maybeSingle(),
      db.from('items').select('id,data').eq('user_id', uid),
      db.from('profiles').select('*').eq('user_id', uid).maybeSingle()]);
    const err = st.error || it.error || pr.error; if (err) throw err;
    const rows = it.data || [];
    CLOUD.sent = {items:Object.fromEntries(rows.map(r => [r.id, JSON.stringify(r.data)])), state:st.data ? JSON.stringify(st.data.state) : '', profile:''};
    if (!st.data && !rows.length){
      // New account. If this browser has a closet that isn't anyone else's, offer to move it in.
      if (S.cloudUser && S.cloudUser !== uid) S = seed();
      const mine = S.items.filter(i => !i.demo).length;
      if (mine && !S.cloudUser && !confirm(`This browser has ${mine} closet pieces. Move them into your Maison Moi account?\n\nChoose Cancel to start a fresh closet (this browser's copy is kept as a backup).`)){
        localStorage.setItem(LS_KEY + '.device-backup', JSON.stringify(S)); S = seed();
      }
      S.cloudUser = uid; S.localOnly = false;
      cloudWrite(); await cloudPush(true);
    } else if (S.cloudUser === uid && S._unsynced && S.cloudRev && pr.data && pr.data.rev === S.cloudRev){
      // Nothing changed in your account since this browser last saved, so this browser's newer edits win.
      await cloudPush(true);
    } else {
      const keep = {tab:S.tab, weather:S.weather};
      if (S.items.some(i => !i.demo) && S.cloudUser !== uid) localStorage.setItem(LS_KEY + '.device-backup', JSON.stringify(S));
      S = Object.assign(seed(), st.data ? st.data.state : {}, {items:rows.map(r => r.data)}, keep, {cloudUser:uid, cloudRev:pr.data && pr.data.rev, _unsynced:false, localOnly:false});
      S.drafts = S.drafts || []; S.products = S.products || [];
      if (S.day.date !== todayISO()) S.day.date = todayISO();
      cloudWrite();
      if (window.CLOSET_CATALOG && S.profile && S.profile.done && mergeCatalog()) save(); // pieces Claude added to catalog.js on this Mac
    }
    await Promise.all([signPhotos(), loadPlan(), loadAdmin()]);
    CLOUD.status = 'saved'; CLOUD.at = Date.now();
    if (!S.plan || S.plan.date !== S.day.date) generatePlan();
  } catch(e){
    CLOUD.status = 'error'; CLOUD.msg = cloudErr(e);
    toast(CLOUD.msg);
  }
  render();
}

/* ---- Plan: read your subscription, open Stripe Checkout or the billing portal ---- */
async function loadPlan(){
  const {data, error} = await CLOUD.db.from('subscriptions').select('status,trial_end,current_period_end,cancel_at_period_end').eq('user_id', CLOUD.user.id).maybeSingle();
  if (!error){ S.sub = data || {status:'free'}; cloudWrite(); } // on a network hiccup, keep the last known plan
}
async function loadAdmin(){
  const {data, error} = await CLOUD.db.rpc('admin_overview'); // the database says no unless you're in the admins table
  CLOUD.admin = error ? null : data; CLOUD.adminAt = Date.now();
}
function planInfo(){
  const s = S.sub || {}, day = d => d ? new Date(d).toLocaleDateString([], {month:'long', day:'numeric'}) : '';
  if (s.status === 'comped') return {label:"You have a founder's pass: Plus, on the house, for good.", manage:false};
  if (s.status === 'trialing') return {label:`You're on your free trial of Plus${s.trial_end ? ` until ${day(s.trial_end)}` : ''}${s.cancel_at_period_end ? ', and it won\'t renew' : `, then $${PLUS.price} a month`}.`, manage:true};
  if (s.status === 'active') return {label:s.cancel_at_period_end ? `You're on Plus until ${day(s.current_period_end)}. It won't renew.` : `You're on Plus. Next bill ${day(s.current_period_end)}.`, manage:true};
  return {label:"You're on Free.", manage:false};
}
async function billing(action){
  if (!CLOUD.user){ toast('Sign in first'); return; }
  try {
    const {data, error} = await CLOUD.db.functions.invoke('stripe', {body:{action, return_url:location.href.split('#')[0]}});
    if (error || !data || !data.url) throw error || new Error('no url');
    location.href = data.url;
  } catch(e){ toast("Checkout isn't connected yet. Stripe is the next step."); }
}
const cloudCheckout = () => billing('checkout');
const cloudPortal = () => billing('portal');
if (/[?&]plus=welcome/.test(location.search)){ // back from Stripe Checkout
  history.replaceState(null, '', location.pathname);
  setTimeout(async () => { toast('Welcome to Plus ✦'); if (CLOUD.user){ await loadPlan(); render(); } }, 2500);
}

/* ---- Push: save changes to your account. Only items that changed are sent. ---- */
function cloudQueue(){
  if (!CLOUD.user) return;
  clearTimeout(CLOUD.t); CLOUD.t = setTimeout(cloudPush, 1500);
}
async function cloudPush(loud){
  if (!CLOUD.user) return;
  if (CLOUD.busy){ CLOUD.again = true; return; }
  CLOUD.busy = true; CLOUD.status = 'saving'; cloudBadge();
  const db = CLOUD.db, uid = CLOUD.user.id, now = new Date().toISOString();
  try {
    await uploadPhotos(loud);
    const seen = new Set(), rows = [];
    S.items.forEach(i => {
      seen.add(i.id);
      const j = JSON.stringify(i);
      if (CLOUD.sent.items[i.id] !== j) rows.push({user_id:uid, id:i.id, data:i, image_path:String(i.img || '').startsWith('sb:') ? i.img.slice(3) : null, updated_at:now});
    });
    for (const part of chunks(rows, 100)){
      const {error} = await db.from('items').upsert(part); if (error) throw error;
      part.forEach(r => CLOUD.sent.items[r.id] = JSON.stringify(r.data));
    }
    const gone = Object.keys(CLOUD.sent.items).filter(id => !seen.has(id));
    for (const part of chunks(gone, 100)){
      const {error} = await db.from('items').delete().eq('user_id', uid).in('id', part); if (error) throw error;
      part.forEach(id => delete CLOUD.sent.items[id]);
    }
    const state = Object.fromEntries(Object.entries(S).filter(([k]) => !DEVICE_ONLY.includes(k)));
    const sj = JSON.stringify(state);
    if (sj !== CLOUD.sent.state){
      const {error} = await db.from('closet_state').upsert({user_id:uid, state, updated_at:now}); if (error) throw error;
      CLOUD.sent.state = sj;
    }
    const p = S.profile || {}, rev = newRev();
    const {error} = await db.from('profiles').upsert({user_id:uid, name:p.name || null, zip:p.zip || null, theme:S.theme || 'lbd', settings:p, rev, updated_at:now});
    if (error) throw error;
    S.cloudRev = rev; S._unsynced = false; cloudWrite();
    CLOUD.status = 'saved'; CLOUD.at = Date.now(); CLOUD.retry = 0;
    if (loud && rows.length) toast(`Saved ${rows.length} piece${rows.length > 1 ? 's' : ''} to your account`);
  } catch(e){
    CLOUD.status = 'error'; CLOUD.msg = cloudErr(e);
    CLOUD.retry = Math.min((CLOUD.retry || 15) * 2, 600);   // try again later; this browser's copy is safe meanwhile
    clearTimeout(CLOUD.t); CLOUD.t = setTimeout(cloudPush, CLOUD.retry * 1000);
    if (loud) toast(CLOUD.msg);
  } finally {
    CLOUD.busy = false; cloudBadge();
    if (CLOUD.again){ CLOUD.again = false; cloudQueue(); }
  }
}
const cloudErr = e => /fetch|network/i.test(e.message || '') ? "You're offline. Changes are saved in this browser and will sync when you're back."
  : /schema cache|does not exist/i.test(e.message || '') ? 'Your Supabase tables are not set up yet (run supabase/schema.sql).'
  : `Couldn't sync: ${e.message || e}`;

/* ---- Photos: local files (images/ on this Mac, or photos you uploaded) move into storage, then display via signed links ---- */
async function readPhoto(src){
  const urls = src.startsWith('data:') ? [src] : [src, `${SHOP_API}/${src}`]; // file:// pages can't read images/, the shop helper can
  for (const u of urls){
    try { const r = await fetch(u); if (r.ok){ const b = await r.blob(); if (/^image\//.test(b.type)) return b; } } catch(e){}
  }
  return null;
}
async function uploadPhotos(loud){
  const uid = CLOUD.user.id, all = [...S.items, ...S.products], map = {};
  const todo = [...new Set(all.map(x => x.img).filter(v => typeof v === 'string' && (/^images\//.test(v) || /^data:image\/(?!svg)/.test(v))))];
  let n = 0, missed = 0;
  for (const src of todo){
    const blob = await readPhoto(src);
    if (!blob){ missed++; continue; }
    const name = src.startsWith('images/') ? src.slice(7) : `photo-${newRev()}.${blob.type.split('/')[1] || 'jpg'}`;
    const path = `${uid}/${name}`;
    const {error} = await CLOUD.db.storage.from(PHOTO_BUCKET).upload(path, blob, {upsert:true, contentType:blob.type});
    if (error) throw error;
    map[src] = 'sb:' + path;
    if (loud && ++n % 10 === 0) toast(`Uploading photos: ${n} of ${todo.length}`);
  }
  if (Object.keys(map).length){ all.forEach(x => { if (map[x.img]) x.img = map[x.img]; }); cloudWrite(); await signPhotos(); render(); }
  if (missed && loud) toast(`${missed} photo${missed > 1 ? 's' : ''} couldn't be read yet. Turn on the shop helper and they'll upload next time.`);
}
async function signPhotos(){
  const paths = [...new Set([...S.items, ...S.products].map(x => x.img).filter(v => typeof v === 'string' && v.startsWith('sb:')).map(v => v.slice(3)))].filter(p => !CLOUD.signed[p]);
  for (const part of chunks(paths, 100)){
    const {data, error} = await CLOUD.db.storage.from(PHOTO_BUCKET).createSignedUrls(part, 7 * 86400);
    if (error) throw error;
    (data || []).forEach(d => { if (d.signedUrl) CLOUD.signed[d.path] = d.signedUrl; });
  }
}

/* ---- Sign in / sign up / sign out ---- */
async function cloudAuth(kind){
  const email = ($('#au-email') || {}).value.trim(), pass = ($('#au-pass') || {}).value;
  const say = (m, ok) => { UI.authMsg = m; UI.authOk = !!ok; UI.authEmail = email; const e = $('#au-msg'); if (e){ e.textContent = m; e.className = 'au-msg ' + (ok ? 'ok' : 'bad'); } };
  if (!/^\S+@\S+\.\S+$/.test(email)) return say('Enter your email address.');
  const redirect = /^https?:/.test(location.href) ? location.href.split('#')[0] : undefined;
  if (kind === 'reset'){
    const {error} = await CLOUD.db.auth.resetPasswordForEmail(email, {redirectTo:redirect});
    return say(error ? error.message : 'Check your email for a link to reset your password.', !error);
  }
  if (pass.length < 8) return say('Passwords need at least 8 characters.');
  say(kind === 'up' ? 'Creating your account...' : 'Signing in...', true);
  const {data, error} = kind === 'up'
    ? await CLOUD.db.auth.signUp({email, password:pass, options:{emailRedirectTo:redirect}})
    : await CLOUD.db.auth.signInWithPassword({email, password:pass});
  if (error && kind === 'in' && /invalid/i.test(error.message)) return say("That email and password don't match. New here? Choose Create account above.");
  if (error) return say(/confirm/i.test(error.message) ? 'Confirm your email first (check your inbox), then sign in.' : error.message);
  if (kind === 'up' && !data.session){ UI.authMode = 'in'; say('Almost there! Check your email for a link to confirm your account, then sign in here.', true); return render(); }
}
async function cloudSignOut(){
  if (!confirm('Sign out of Maison Moi on this browser? Your closet stays safe in your account.')) return;
  if (S._unsynced) await cloudPush();
  if (S._unsynced && !confirm("Some changes haven't synced yet and will be lost. Sign out anyway?")) return;
  await CLOUD.db.auth.signOut();
  localStorage.removeItem(LS_KEY);
  location.reload();
}
function cloudBadge(){
  const b = $('#cloud-status'); if (b) b.innerHTML = cloudStatusText();
}
function cloudStatusText(){
  if (!CLOUD.user) return 'Only on this browser';
  return {loading:'Loading your closet...', saving:'Saving...', error:esc(CLOUD.msg), saved:`All changes saved${CLOUD.at ? ' · ' + new Date(CLOUD.at).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) : ''}`}[CLOUD.status] || 'Connected';
}

function planTeaser(){
  const plan = (cls, name, price, note, perks) => `<div class="pt ${cls}"><div class="pt-name">${name}</div><div class="pt-price">${price}</div><div class="pt-note">${note}</div>
    <ul>${perks.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
  return `<div class="plan-teaser">
    ${plan('', 'Free', '$0', 'Forever', [`Up to ${FREE.items} closet pieces`, `${FREE.restyles} outfit restyles a day`, 'Little Black Dress theme', 'Daily outfit with your forecast'])}
    ${plan('pt-plus', 'Plus', `$${PLUS.price}<span>/mo</span>`, `${PLUS.trialDays} days free, cancel anytime`, ['Unlimited closet pieces', 'Unlimited restyles', `All ${Object.keys(THEMES).length} themes`, 'Everything in Free'])}
  </div><p class="pt-foot">Start free, no card needed. Try Plus anytime from your Profile.</p>`;
}
const authMode = () => UI.authMode || (S.cloudUser ? 'in' : 'up'); // returning browsers start on Sign in
function viewAuth(){
  if (!CLOUD.checked) return '<div class="setup-wrap"><div class="setup-hero"><div class="logo"><div class="mark" aria-hidden="true"></div>Maison Moi</div></div><div class="setup-form"></div></div>';
  return `<div class="setup-wrap">
    <div class="setup-hero">
      <div class="logo"><div class="mark" aria-hidden="true"></div>Maison Moi</div>
      <h1>Your closet, styled for the day you're actually having.</h1>
      <p>Your account keeps your closet, photos and outfits safe, so they follow you to any device.</p>
      ${planTeaser()}
    </div>
    <div class="setup-form au">
      ${(m => `<div class="seg au-seg" role="tablist">
        <button role="tab" class="${m === 'up' ? 'on' : ''}" aria-selected="${m === 'up'}" data-action="auth-mode" data-mode="up">Create account</button>
        <button role="tab" class="${m === 'in' ? 'on' : ''}" aria-selected="${m === 'in'}" data-action="auth-mode" data-mode="in">Sign in</button>
      </div>
      <h2>${m === 'up' ? 'Create your account' : 'Welcome back'}</h2>
      <p class="muted small">${m === 'up' ? `New here? Start free with any email. We'll send a link to confirm it.` : 'Sign in to pick up where you left off.'}</p>
      <label class="lbl">Email</label><input class="input" id="au-email" type="email" autocomplete="email" value="${esc(UI.authEmail || '')}">
      <label class="lbl">Password</label><input class="input" id="au-pass" type="password" autocomplete="${m === 'up' ? 'new-password' : 'current-password'}" placeholder="${m === 'up' ? 'Choose at least 8 characters' : 'Your password'}">
      <div class="au-msg ${UI.authOk ? 'ok' : UI.authMsg ? 'bad' : ''}" id="au-msg">${esc(UI.authMsg || '')}</div>
      <button class="btn primary au-go" data-action="${m === 'up' ? 'auth-up' : 'auth-in'}">${m === 'up' ? 'Create free account' : 'Sign in'}</button>
      ${m === 'up'
        ? `<p class="small muted" style="margin-top:14px">By creating an account you agree to our <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</p>
      <p class="small" style="margin-top:14px">Already have an account? <a href="#" data-action="auth-mode" data-mode="in">Sign in</a></p>`
        : `<p class="small" style="margin-top:14px"><a href="#" data-action="auth-reset">Forgot your password?</a></p>
      <p class="small" style="margin-top:6px">New to Maison Moi? <a href="#" data-action="auth-mode" data-mode="up">Create an account</a></p>`}
      <p class="small muted" style="margin-top:22px">Rather not make an account? <a href="#" data-action="auth-local">Keep everything on this browser</a>. You can sign in later from Profile.</p>`)(authMode())}
    </div></div>`;
}
