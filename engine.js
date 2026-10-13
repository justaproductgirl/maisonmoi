/* Maison Moi recommendation engine.
   Scores clean closet pieces against the day (moments, weather, comfort) and the style profile
   (Pinterest boards, pins, vibes, light editorial influence), then composes outfit options.
   Loaded before the app script; it reads shared app state (S) and helpers (byId, isDirty, ...) at call time. */

// Editorial sites are a light nudge (a quarter of a Pinterest board). Only their timeless side counts, never trend reports.
const EDITORIAL = [
  {name:'Who What Wear', url:'https://www.whowhatwear.com/', tags:['chic','classic','minimalist','casual']},
  {name:'Coveteur', url:'https://coveteur.com/', tags:['chic','classic','minimalist','vintage']}
];
const TRENDY_TAGS = ['y2k'];

const MOMENTS = {
  wfh:{label:'Work from home',f:2.5,c:4,tags:['casual','classic','cozy']},
  office:{label:'In the office',f:3.5,c:3,tags:['workwear','classic','business']},
  present:{label:'Presenting / client',f:4.5,c:2,tags:['business','chic','classic']},
  errands:{label:'Errands',f:2,c:4,tags:['casual']},
  lounge:{label:'Relaxing',f:1,c:5,tags:['cozy','athleisure']},
  dinner:{label:'Dinner',f:3,c:3,tags:['chic','casual']},
  date:{label:'Date night',f:4,c:2,tags:['chic','romantic']},
  workout:{label:'Active',f:1,c:5,tags:['sporty','athleisure']},
  travel:{label:'Travel / commute',f:2,c:5,tags:['casual','cozy']}
};
const MOMENT_ORDER = ['travel','workout','wfh','office','present','errands','lounge','dinner','date'];

/* ============ Style profile (from Pinterest boards, pins, vibes) ============ */
function styleProfile(){
  const w = {};
  S.boards.forEach(b => b.tags.forEach(t => w[t] = (w[t] || 0) + 2));
  S.pins.forEach(p => p.tags.forEach(t => w[t] = (w[t] || 0) + 1));
  S.vibes.forEach(t => w[t] = (w[t] || 0) + 2);
  EDITORIAL.forEach(e => e.tags.forEach(t => w[t] = (w[t] || 0) + .5));
  const max = Math.max(1, ...Object.values(w));
  Object.keys(w).forEach(k => w[k] = w[k] / max);
  if (S.noTrends !== false) TRENDY_TAGS.forEach(t => w[t] = -.5);
  return w;
}
function styleMatch(item, prof){
  if (!item.tags.length) return 0;
  return Math.min(1, item.tags.reduce((s, t) => s + (prof[t] || 0), 0) / 2);
}

/* ============ Outfit engine ============ */
function dayMoments(day){
  const m = [];
  if (day.location === 'wfh') m.push('wfh');
  if (day.location === 'office') m.push('office');
  if (day.location === 'hybrid') m.push('wfh', 'office');
  day.moments.forEach(x => { if (!m.includes(x)) m.push(x); });
  if (!m.length) m.push('lounge');
  return MOMENT_ORDER.filter(x => m.includes(x));
}
function ctxFor(moments, day){
  const fs = moments.map(m => MOMENTS[m].f);
  const avg = fs.reduce((a, b) => a + b, 0) / fs.length;
  const f = moments.length === 1 ? fs[0] : 0.6 * Math.max(...fs) + 0.4 * avg;
  const c = Math.max(day.comfort, Math.min(...moments.map(m => MOMENTS[m].c)) - 1, day.onFeet ? 4 : 0);
  const tags = [...new Set(moments.flatMap(m => MOMENTS[m].tags))];
  const fc = forecastFor(day.date);
  return {moments, f, c, tags, onFeet:day.onFeet, weather:day.weather, rain:fc ? fc.rain : 0};
}
function scoreItem(it, ctx, prof, opts = {}){
  if (it.status === 'sold' || isDirty(it)) return -Infinity;
  let s = 0;
  s -= Math.abs(it.formality - ctx.f) * 1.6;
  s -= Math.max(0, ctx.c - it.comfort) * 1.3;
  if (it.category === 'shoes' && ctx.onFeet) s += (it.comfort - 3) * 1.5;
  s += styleMatch(it, prof) * 1.5;
  s += it.pref || 0;
  ctx.moments.forEach(m => s += ((S.prefs[m] || {})[it.id] || 0) / ctx.moments.length);
  s += it.tags.filter(t => ctx.tags.includes(t)).length * 0.4;
  const warm = ['warm','hot'].includes(ctx.weather), cold = ['cold','cool'].includes(ctx.weather);
  const se = it.seasons && it.seasons.length ? it.seasons : ['all'];
  if (!se.includes('all')){
    if (warm && !se.some(x => x === 'summer' || x === 'spring')) s -= 1.5;
    if (cold && !se.some(x => x === 'fall' || x === 'winter')) s -= 1.5;
    if (warm && se.includes('summer')) s += .4;
    if (cold && se.includes('winter')) s += .4;
  }
  if (hasGoal('existing') && daysSince(it.lastWorn || it.addedAt) > 30) s += .6;
  if (opts.used) s -= (opts.used[it.id] || 0) * 2.2;
  if (opts.keep && opts.keep.includes(it.id)) s += 1.4;
  s += Math.random() * 0.35;
  return s;
}
function colorPenalty(a, b, prof){
  if (!a || !b || isNeutral(a) || isNeutral(b)) return 0;
  if (a.color === b.color) return .2;
  return (prof.colorful || 0) > .5 ? .4 : 1.5;
}
// Hats only make sense when the day has you outside for a while.
const OUTDOOR_MOMENTS = ['errands','workout','travel'];
const isHat = i => /\b(hat|cap|beanie|beret|visor|bucket)\b/i.test(i.name);
function best(cat, ctx, prof, opts, against = []){
  let b = null, bs = -Infinity;
  const outdoors = ctx.moments.some(m => OUTDOOR_MOMENTS.includes(m));
  S.items.filter(i => i.category === cat && (outdoors || !isHat(i))).forEach(i => {
    let s = scoreItem(i, ctx, prof, opts);
    against.forEach(a => s -= colorPenalty(a, i, prof));
    if (s > bs){ bs = s; b = i; }
  });
  return b ? {item:b, score:bs} : null;
}
function compose(ctx, prof, opts = {}){
  const top = best('top', ctx, prof, opts);
  const bottom = best('bottom', ctx, prof, opts, top ? [top.item] : []);
  const dress = best('dress', ctx, prof, opts);
  const sepScore = top && bottom ? (top.score + bottom.score) / 2 : -Infinity;
  const parts = {};
  if (dress && dress.score > sepScore){ parts.dress = dress; }
  else if (top && bottom){ parts.top = top; parts.bottom = bottom; }
  else return null;
  const main = Object.values(parts).map(p => p.item);
  const shoes = best('shoes', ctx, prof, opts, main); if (shoes) parts.shoes = shoes;
  const cold = ['cold','cool'].includes(ctx.weather), warm = ['warm','hot'].includes(ctx.weather);
  if (!warm){
    const outer = best('outerwear', ctx, prof, opts, main);
    if (outer && (cold || ctx.rain >= 50 || (ctx.f >= 3.5 && outer.score > -2))) parts.outer = outer;
  }
  const acc = best('accessory', ctx, prof, opts);
  if (acc && acc.score > -1.5) parts.acc = acc;
  const scores = Object.values(parts).map(p => p.score);
  return {parts:Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.item.id])), score:scores.reduce((a, b) => a + b, 0) / scores.length};
}
function generatePlan(){
  const prof = styleProfile();
  const moments = dayMoments(S.day);
  const ctx = ctxFor(moments, S.day);
  const used = {}, options = [], seen = new Set();
  for (let i = 0; i < 6 && options.length < 3; i++){
    const o = compose(ctx, prof, {used});
    if (!o) break;
    const sig = Object.values(o.parts).sort().join('|');
    Object.values(o.parts).forEach(id => used[id] = (used[id] || 0) + 1);
    if (seen.has(sig)) continue;
    seen.add(sig); options.push(o);
  }
  let perMoment = [];
  if (options.length && moments.length > 1){
    const keep = Object.values(options[0].parts);
    perMoment = moments.map(m => {
      const o = compose(ctxFor([m], S.day), prof, {keep});
      return o ? {m, parts:o.parts} : null;
    }).filter(Boolean);
  }
  S.plan = {date:S.day.date, moments, ctx, options, perMoment, at:Date.now()};
  save();
}
function reasonsFor(o, ctx){
  const prof = styleProfile();
  const items = Object.entries(o.parts).map(([k, id]) => [k, byId(id)]).filter(([, i]) => i);
  const r = [];
  const vibe = {};
  items.forEach(([, i]) => i.tags.forEach(t => { if (prof[t] > 0) vibe[t] = (vibe[t] || 0) + prof[t]; }));
  const topVibes = Object.entries(vibe).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]);
  if (topVibes.length) r.push({t:`Matches your Pinterest vibe: ${topVibes.join(' + ')}`});
  const fAvg = items.filter(([k]) => k !== 'acc').reduce((s, [, i]) => s + i.formality, 0) / Math.max(1, items.filter(([k]) => k !== 'acc').length);
  const labels = ctx.moments.map(m => MOMENTS[m].label.toLowerCase());
  if (Math.abs(fAvg - ctx.f) <= 0.9) r.push({t:`Right level of polish for ${labels.slice(0, 3).join(', ')}`});
  else if (fAvg < ctx.f) r.push({t:`A little casual for ${labels.join(', ')}; dress it up with the accessory`, warn:true});
  else r.push({t:`On the dressier side; swap shoes to dress it down`, warn:true});
  const shoes = o.parts.shoes && byId(o.parts.shoes);
  if (shoes && ctx.onFeet) r.push(shoes.comfort >= 4 ? {t:`${shoes.name} are comfort ${shoes.comfort}/5 for being on your feet`} : {t:`Shoes are only comfort ${shoes.comfort}/5; pack a backup pair`, warn:true});
  const cAvg = items.reduce((s, [, i]) => s + i.comfort, 0) / items.length;
  if (cAvg >= ctx.c - .3) r.push({t:`Comfort averages ${cAvg.toFixed(1)}/5 (you asked for ${ctx.c})`});
  if (ctx.rain >= 50) r.push(o.parts.outer ? {t:`${ctx.rain}% chance of rain: the ${byId(o.parts.outer).name.toLowerCase()} has you covered`} : {t:`${ctx.rain}% chance of rain: bring an umbrella`, warn:true});
  else if (o.parts.outer) r.push({t:`Layer: ${byId(o.parts.outer).name} for ${ctx.weather} weather`});
  const fav = items.map(([, i]) => i).find(i => (i.pref || 0) > .6);
  if (fav) r.push({t:`You keep reaching for the ${fav.name.toLowerCase()}`});
  const forgotten = items.map(([, i]) => i).find(i => daysSince(i.lastWorn || i.addedAt) > 60);
  if (forgotten) r.push({t:`Rediscover: ${forgotten.name} (not worn in ${daysSince(forgotten.lastWorn || forgotten.addedAt)} days)`});
  return r.slice(0, 5);
}
function lookTitle(o){
  const count = {};
  Object.values(o.parts).forEach(id => { const i = byId(id); if (i) i.tags.forEach(t => count[t] = (count[t] || 0) + 1); });
  const t = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => cap(x[0]));
  return t.join(' & ') || 'Everyday';
}

/* ============ Style fit ============ */
// How well a piece matches the style profile: its strongest positive tag, pulled down by any tag the profile dislikes (like y2k when trends are off).
const OFF_STYLE = .3;
// A saturated color counts as colorful even when the piece isn't tagged that way.
const vibesOf = it => [...new Set([...it.tags, ...(!isNeutral(it) && it.color !== 'print' ? ['colorful'] : []), ...(/vintage/i.test(it.condition || '') ? ['vintage'] : [])])];
function styleFit(it, prof){
  if (!it.tags.length) return null;
  const w = vibesOf(it).map(t => prof[t] || 0);
  return Math.max(0, ...w) + Math.min(0, ...w);
}
const topVibes = (prof, n = 3) => Object.entries(prof).filter(([, v]) => v >= .5).sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
function offStyleWhy(it, prof){
  const neg = it.tags.filter(t => (prof[t] || 0) < 0), weak = it.tags.filter(t => (prof[t] || 0) >= 0);
  const vibes = topVibes(prof).join(', ');
  if (neg.length) return `Reads ${neg.join(', ')}, which you've asked to keep out of your style. Your boards lean ${vibes}.`;
  return `Reads ${weak.join(', ') || 'neutral'}; your boards lean ${vibes}.`;
}

/* ============ Resell ============ */
function brandTier(b){
  b = (b || '').toLowerCase();
  const has = l => l.some(x => b.includes(x));
  if (has(LUX)) return 'luxury';
  if (has(HOT)) return 'trending';
  if (has(PREM)) return 'premium';
  if (has(FAST)) return 'fast fashion';
  return 'unknown';
}
function resaleEval(it){
  if (it.sentimental) return {locked:true};
  const idle = daysSince(it.lastWorn || it.addedAt) ?? 0;
  const age = Math.max(30, daysSince(it.addedAt) || 30);
  const perMonth = (it.wearCount || 0) / (age / 30);
  const tier = brandTier(it.brand);
  const rate = {luxury:[.45,.6], premium:[.3,.45], trending:[.28,.42], unknown:[.15,.3], 'fast fashion':[.1,.2]}[tier];
  const cm = {'New with tags':1.25, 'Like new':1, 'Good':.8, 'Fair':.55, 'pre-owned':.8, 'vintage':.9}[it.condition] ?? .8;
  const base = it.price || {luxury:400, premium:90, trending:60, unknown:40, 'fast fashion':25}[tier];
  const lo = Math.max(3, Math.round(base * rate[0] * cm)), hi = Math.max(5, Math.round(base * rate[1] * cm));
  const vintagey = it.tags.some(t => ['vintage','y2k','streetwear','boho','edgy'].includes(t)) || /vintage/i.test(it.condition || '');
  let platform, why;
  if (hi < 10){ platform = 'Donate'; why = 'Resale value is under $10; bundle it with other pieces or donate'; }
  else if (tier === 'luxury' || hi >= 120){ platform = 'eBay'; why = 'Higher price point: eBay Authenticity Guarantee and a wider pool of brand searchers'; }
  else if (tier === 'trending' || vintagey){ platform = 'Depop'; why = 'Trend and vintage driven audience; styled on-body photos sell best'; }
  else if (it.category === 'shoes'){ platform = 'eBay'; why = 'Shoes get searched by brand + size on eBay'; }
  else { platform = 'Poshmark'; why = 'Mall and premium womenswear sells steadily there; share your closet daily'; }
  const reasons = [it.lastWorn ? `Last worn ${idle}d ago` : 'Not worn yet', `${cap(tier)} brand demand`, it.condition].filter(Boolean);
  return {lo, hi, platform, why, reasons, tier, perMonth};
}
// Pieces that don't fit the style profile. Listed pieces stay until sold; "Keep it" hides a piece for good.
function resellList(prof = styleProfile()){
  return S.items.filter(i => i.status !== 'sold' && !i.sentimental && !i.styleKeep && i.tags.length)
    .map(i => ({i, fit:styleFit(i, prof), r:resaleEval(i)}))
    .filter(x => x.fit < OFF_STYLE || x.i.status === 'listed')
    .sort((a, b) => a.fit - b.fit || b.r.hi - a.r.hi);
}
const LISTING_CAT = {top:'Tops', bottom:'Bottoms', dress:'Dresses', outerwear:'Coats & Jackets', shoes:'Shoes', accessory:'Accessories'};
const SHIP = {top:['Small poly mailer', '0.5 lb'], bottom:['Medium poly mailer', '1 lb'], dress:['Medium poly mailer', '1 lb'], outerwear:['Large poly mailer or box', '2 to 3 lb'], shoes:['Shoe box in a mailer box', '2 to 3 lb'], accessory:['Padded envelope', 'under 0.5 lb']};
const PHOTO_TIPS = {top:'Front, back, tag, fabric close-up, any flaws. On-body shot if you can.', bottom:'Front, back, tag, waist and inseam laid flat with a tape measure.', dress:'Front, back, tag, on-body or hanger shot, any flaws.', outerwear:'Front, back, tag, lining, zips/buttons, on-body shot.', shoes:'Both sides, soles, heel, inside label with size, box if you have it.', accessory:'Front, back, clasp or hardware, scale shot next to your hand.'};
const MEASURE = {top:'Pit to pit, length shoulder to hem', bottom:'Waist flat, rise, inseam, leg opening', dress:'Pit to pit, waist flat, length', outerwear:'Pit to pit, sleeve, length', shoes:'Insole length if you can', accessory:'Length / dimensions'};
function listingKit(it){
  const r = resaleEval(it);
  const colorTxt = it.colorName || cap(it.color);
  const size = it.size ? 'Size ' + it.size : '';
  const title = `${it.brand || ''} ${it.name} ${colorTxt} ${size}`.replace(/\s+/g, ' ').trim().slice(0, 80);
  const tags = [...new Set([(it.brand || '').toLowerCase().replace(/[^a-z0-9]/g, ''), ...it.tags.map(t => t.replace(/\s+/g, ''))].filter(Boolean))].slice(0, 5);
  const worn = it.wearCount ? `Worn ${it.wearCount} time${it.wearCount === 1 ? '' : 's'}` : 'Barely worn';
  const desc = `${it.brand ? it.brand + ' ' : ''}${it.name} in ${colorTxt}${it.size ? ', size ' + it.size : ''}.\n` +
    `Condition: ${it.condition || 'Good'}. ${worn}, freshly laundered, from a smoke-free home.\n` +
    `${it.price ? 'Retail ' + money(it.price) + '. ' : ''}Measurements on request (${MEASURE[it.category].toLowerCase()}).\n` +
    `Style: ${it.tags.slice(0, 3).join(' / ')}.\n\n${tags.map(t => '#' + t).join(' ')}`;
  return {...r, title, desc, price:r.hi, floor:r.lo, catPath:`Women > ${LISTING_CAT[it.category]}`, hashtags:tags,
    ship:SHIP[it.category], photos:PHOTO_TIPS[it.category], measure:MEASURE[it.category], retail:it.price || 0};
}
function listingText(it){ const k = listingKit(it); return `${k.title}\n\n${k.desc}\n\nAsking ${money(k.price)} (floor ${money(k.floor)})`; }

/* ============ Shop: wardrobe gaps ============ */
// A piece suits a day type when it's within one step of its polish and comfort.
const suits = (i, m) => Math.abs(i.formality - MOMENTS[m].f) <= 1 && i.comfort >= MOMENTS[m].c - 1;
const GAP_QUERY = {
  'wfh:top':'women soft knit top', 'wfh:bottom':'women relaxed trousers', 'wfh:shoes':'women house slippers',
  'lounge:top':'women lounge sweatshirt', 'lounge:bottom':'women lounge pants', 'lounge:shoes':'women slippers',
  'errands:top':'women everyday tee', 'errands:bottom':'women straight leg jeans', 'errands:shoes':'women everyday sneakers',
  'dinner:top':'women going out top', 'dinner:bottom':'women satin midi skirt', 'dinner:shoes':'women block heel',
  'date:top':'women silk camisole', 'date:bottom':'women slip skirt', 'date:shoes':'women strappy heels', 'date:dress':'women slip dress',
  'workout:top':'women workout top', 'workout:bottom':'women leggings', 'workout:shoes':'women running shoes'
};
const VIBE_LOOK = {
  colorful:['a bold print or saturated color piece', 'women colorful print top'],
  chic:['a polished blouse, slip skirt or tailored trouser', 'women silk blouse'],
  vintage:['a secondhand find: knit, leather bag or worn-in denim', 'women vintage cardigan'],
  casual:['an easy elevated basic', 'women relaxed knit'],
  classic:['a timeless trench, loafer or crisp shirt', 'women trench coat'],
  boho:['a flowy skirt or embroidered blouse', 'women embroidered blouse'],
  edgy:['a leather jacket or chunky boot', 'women leather jacket'],
  romantic:['a lace or ruffled piece', 'women lace blouse'],
  sporty:['a sleek sneaker or track jacket', 'women track jacket'],
  streetwear:['a great graphic or cargo', 'women cargo pants'],
  minimalist:['a clean-lined neutral staple', 'women minimalist knit']
};
function gapExtras(cat, prof, items){
  const fits = items.filter(i => (styleFit(i, prof) || 0) >= .5);
  const pool = fits.filter(i => i.category === cat).length >= 2 ? fits.filter(i => i.category === cat) : fits;
  const count = {};
  pool.forEach(i => { if (i.brand && !/^(unbranded|walmart\.com)$/i.test(i.brand)) count[i.brand] = (count[i.brand] || 0) + 1; });
  const brands = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
  const paid = items.filter(i => i.category === cat && i.price > 0).map(i => i.price).sort((a, b) => a - b);
  return {brands, spend:paid.length ? paid[Math.floor(paid.length / 2)] : 0};
}
function shopGaps(){
  const prof = styleProfile();
  const items = S.items.filter(i => i.status !== 'sold');
  const vibe = topVibes(prof, 2);
  const flavor = vibe.length ? ` Lean ${vibe.join(' + ')} to match your boards.` : '';
  const gaps = [];
  const add = g => { if (!(S.shopHidden || []).includes(g.key)) gaps.push({...g, ...gapExtras(g.cat, prof, items)}); };
  // 1. Day types your closet can't dress well
  DAY_TYPES.forEach(m => {
    const ok = cat => items.filter(i => i.category === cat && suits(i, m));
    const label = MOMENTS[m].label;
    const tops = ok('top'), bottoms = ok('bottom'), dresses = ok('dress'), shoes = ok('shoes');
    const pairs = (n, cat) => `Would pair with ${n} piece${n === 1 ? '' : 's'} you already own for ${label.toLowerCase()}.`;
    if (dresses.length < 2 && tops.length < 3) add({key:`${m}:top`, cat:'top', ic:'👚', impact:3 + bottoms.length / 4, t:`Tops for ${label.toLowerCase()}`, d:`Only ${tops.length} top${tops.length === 1 ? '' : 's'} hit the right polish and comfort for ${label.toLowerCase()}.${flavor}`, unlock:pairs(bottoms.length), q:GAP_QUERY[`${m}:top`]});
    if (dresses.length < 2 && bottoms.length < 2) add({key:`${m}:bottom`, cat:'bottom', ic:'👖', impact:3 + tops.length / 4, t:`Bottoms for ${label.toLowerCase()}`, d:`Only ${bottoms.length} bottom${bottoms.length === 1 ? '' : 's'} work for ${label.toLowerCase()}.${flavor}`, unlock:pairs(tops.length), q:GAP_QUERY[`${m}:bottom`]});
    if (!shoes.length) add({key:`${m}:shoes`, cat:'shoes', ic:'👟', impact:3.5, t:`Shoes for ${label.toLowerCase()}`, d:`None of your shoes are the right mix of polish and comfort for ${label.toLowerCase()}.`, unlock:pairs(tops.length + bottoms.length + dresses.length), q:GAP_QUERY[`${m}:shoes`]});
  });
  // 2. Your strongest vibes, underrepresented in the closet
  topVibes(prof).forEach(tag => {
    const n = items.filter(i => vibesOf(i).includes(tag)).length, share = n / Math.max(1, items.length);
    if (share < .15 && VIBE_LOOK[tag]) add({key:`vibe:${tag}`, cat:'top', ic:'📌', impact:2 + prof[tag], t:`More ${tag} pieces`, d:`Your boards lean ${tag}, but only ${n} of ${items.length} pieces read that way. Look for ${VIBE_LOOK[tag][0]}.`, unlock:'Pulls your closet closer to your Pinterest style.', q:VIBE_LOOK[tag][1]});
  });
  // 3. Neutral bases that multiply outfits
  const nt = items.filter(i => i.category === 'top' && isNeutral(i)).length, nb = items.filter(i => i.category === 'bottom' && isNeutral(i)).length;
  if (nt < 4) add({key:'neutral:top', cat:'top', ic:'🤍', impact:2.5, t:'Neutral base tops', d:`Only ${nt} neutral tops. They make your colorful pieces easier to wear.`, unlock:`Would pair with most of your ${items.filter(i => i.category === 'bottom').length} bottoms.`, q:'women neutral fitted top'});
  if (nb < 3) add({key:'neutral:bottom', cat:'bottom', ic:'🤎', impact:2.5, t:'Neutral base bottoms', d:`Only ${nb} neutral bottoms to anchor bold tops.`, unlock:`Would pair with most of your ${items.filter(i => i.category === 'top').length} tops.`, q:'women black wide leg trousers'});
  // 4. Weather
  const outer = items.filter(i => i.category === 'outerwear');
  const rainy = S.weather && Object.values(S.weather.days || {}).some(d => d.rain >= 50);
  if (rainy && !items.some(i => ['outerwear','shoes'].includes(i.category) && /rain|trench|anorak|waterproof|gore-tex/i.test(i.name)))
    add({key:'rain', cat:'outerwear', ic:'☔', impact:3.2, t:'A rain-ready layer', d:'Rain is in your forecast and nothing in your closet is waterproof.', unlock:'Covers every day type on wet days.', q:'women waterproof trench coat'});
  if (!outer.some(i => /coat|puffer|parka|wool/i.test(i.name))) add({key:'coat', cat:'outerwear', ic:'🧥', impact:3, t:'A warm coat', d:'No proper cold-weather coat in your closet yet.', unlock:'Works over everything on cold days.', q:'women wool coat'});
  return gaps.sort((a, b) => b.impact - a.impact);
}

/* ============ Shop: default sizes ============ */
// Your usual sizes per category, read from what's already in your closet (most common first).
const ALPHA_SIZE = {'extra small':'XS', xs:'XS', small:'S', s:'S', medium:'M', m:'M', large:'L', l:'L', 'extra large':'XL', xl:'XL'};
function shopSizes(){
  const items = S.items.filter(i => i.status !== 'sold' && i.size);
  const common = (list, n) => { const c = {}; list.forEach(x => c[x] = (c[x] || 0) + 1); return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]); };
  const alpha = cats => common(items.filter(i => cats.includes(i.category)).map(i => ALPHA_SIZE[i.size.toLowerCase().trim()]).filter(Boolean), 2);
  const waist = common(items.filter(i => i.category === 'bottom' && /^\d{2}$/.test(i.size.trim()) && +i.size >= 22 && +i.size <= 34).map(i => i.size.trim()), 2);
  const shoe = common(items.filter(i => i.category === 'shoes').map(i => (i.size.match(/(\d{1,2}(?:\.5)?)/) || [])[1]).filter(Boolean), 1);
  const tops = alpha(['top','dress','outerwear']);
  return {top:tops, dress:tops, outerwear:tops, bottom:[...waist, ...alpha(['bottom']).slice(0, 1)], shoes:shoe, accessory:[]};
}
