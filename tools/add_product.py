#!/usr/bin/env python3
"""Add a retailer product page (PDP) to the Maison Moi catalog.

    python3 tools/add_product.py URL --color "Medium Heather Grey" --size Small [--price 98] [--notes "..."]
                                     [--name ...] [--category top] [--sentimental] [--not-in-closet] [--list]

Shopify stores are read from /products/<handle>.js (all colors, sizes, per-color photos).
Other retailers fall back to the page's JSON-LD Product data or og: tags.
The chosen photo is downloaded into images/, the entry is written to catalog.js
(which the app merges on load) and products.csv is regenerated.
Exit code 2 means a color/size choice is needed; the options are printed.
"""
import argparse, csv, hashlib, html as html_lib, io, json, re, secrets, subprocess, sys, tempfile, urllib.parse, urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG, IMAGES, CSV_PATH = ROOT / 'catalog.js', ROOT / 'images', ROOT / 'products.csv'
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'}
CATS = {'top': 2, 'bottom': 4, 'dress': 2, 'outerwear': 8, 'shoes': 0, 'accessory': 0}
COLOR_WORDS = [('black', 'black|onyx|jet|noir'), ('white', 'white|optic|snow'), ('cream', 'cream|ivory|oat|oatmeal|ecru|bone|vanilla|egret'),
  ('gray', 'grey|gray|heather|charcoal|ash|slate|odyssey|feather'), ('silver', 'silver'), ('navy', 'navy|midnight'),
  ('brown', 'brown|chocolate|mocha|espresso|coffee|cocoa|martini'), ('camel', 'camel|cognac|caramel|toffee'),
  ('beige', 'beige|sand|tan|taupe|khaki|stone|latte'), ('olive', 'olive|canteen|army|moss|sage'), ('green', 'green|emerald|forest|mint'),
  ('denim', 'denim|indigo|wash'), ('blue', 'blue|cobalt|sky|azure'), ('red', 'red|burgundy|wine|cherry|crimson|merlot'),
  ('pink', 'pink|blush|rose|mauve'), ('purple', 'purple|lilac|lavender|plum'), ('yellow', 'yellow|butter|lemon|mustard'),
  ('orange', 'orange|rust|terracotta|coral'), ('gold', 'gold'), ('print', 'print|floral|stripe|plaid|leopard|check')]
FIT_RULES = [  # same rules the web app uses (guessFit)
  (r'hoodie|sweatshirt|jogger|legging|sweatpant|lounge|terry|fleece', 1, 5, ['cozy', 'casual', 'athleisure']),
  (r'\btee\b|t-shirt|tshirt|tank', 2, 5, ['casual', 'minimalist']),
  (r'sweater|knit|cardigan|cashmere', 2, 4, ['cozy', 'classic']),
  (r'jean|denim', 2, 4, ['casual', 'classic']),
  (r'blazer|trouser|tailored|suiting', 4, 3, ['workwear', 'classic']),
  (r'blouse|silk|satin', 4, 3, ['chic']),
  (r'heel|stiletto|pump', 5, 1, ['chic']),
  (r'sneaker|trainer', 2, 5, ['casual', 'sporty']),
  (r'loafer|ballet', 3, 4, ['classic']),
  (r'boot', 3, 3, ['edgy']),
  (r'slip dress|midi|maxi', 3.5, 3, ['chic', 'romantic'])]
BASE = {'top': (2.5, 4), 'bottom': (2.5, 4), 'dress': (3, 3), 'outerwear': (3, 3), 'shoes': (3, 3), 'accessory': (3, 5)}


def fetch(url, binary=False):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
        data = r.read()
    return data if binary else data.decode('utf-8', 'replace')


def title_case(t):
    return re.sub(r'\b[a-z]', lambda m: m.group().upper(), (t or '').lower()).strip()


def guess_color(name):
    n = (name or '').lower()
    return next((fam for fam, w in COLOR_WORDS if re.search(r'\b(' + w + ')', n)), None)


def guess_category(text):
    t = (text or '').lower()
    for cat, pat in [('dress', r'dress|jumpsuit|romper'), ('shoes', r'shoe|boot|sneaker|trainer|heel|loafer|sandal|mule|flat|pump|clog'),
                     ('outerwear', r'jacket|coat|blazer|trench|parka|puffer|vest|bomber|shacket'),
                     ('bottom', r'pant|jean|trouser|skirt|short|legging|jogger|skort'),
                     ('accessory', r'bag|tote|clutch|necklace|earring|ring|bracelet|hat|cap|beanie|scarf|belt|sunglass|jewel')]:
        if re.search(pat, t):
            return cat
    return 'top'


def guess_fit(cat, text):
    t = (text or '').lower()
    hit = next((r for r in FIT_RULES if re.search(r[0], t)), None)
    tags = list(hit[3]) if hit else []
    for pat, tag in [(r'oversized|slouchy|relaxed', 'casual'), (r'basic|essential|staple', 'minimalist'), (r'vintage|retro', 'vintage'), (r'leather|moto', 'edgy')]:
        if re.search(pat, t) and tag not in tags:
            tags.append(tag)
    if re.search(r'fleece|wool|cashmere|puffer|sweater|knit|terry|hoodie|sweatshirt', t):
        seasons = ['fall', 'winter', 'spring']
    elif re.search(r'linen|tank|sandal|\bshorts?\b', t):
        seasons = ['spring', 'summer']
    else:
        seasons = ['all']
    f, c = (hit[1], hit[2]) if hit else BASE[cat]
    return {'formality': round(f), 'comfort': c, 'tags': tags, 'seasons': seasons}


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', (s or '').lower()).strip('-')[:80]


SIZE_ABBR = {'xxs': 'xx-small', 'xs': 'extra small', 's': 'small', 'm': 'medium', 'l': 'large', 'xl': 'extra large', 'xxl': 'xx-large'}


def match(want, values):
    """Find the store's option value for what the user typed: exact, then size abbreviation (S -> Small), then prefix, then substring."""
    if not want:
        return None
    w = want.lower().strip()
    norm = lambda v: re.sub(r'[^a-z0-9]', '', v.lower())
    exact = next((v for v in values if v.lower() == w), None)
    if exact:
        return exact
    full = SIZE_ABBR.get(w)
    if full:
        hit = next((v for v in values if norm(v) in (norm(full), w)), None)
        if hit:
            return hit
    if len(w) <= 2:
        return None
    return next((v for v in values if v.lower().startswith(w)), None) or next((v for v in values if w in v.lower()), None)


def from_shopify(u, args):
    m = re.search(r'/products/([^/?#]+)', u.path)
    if not m:
        return None
    try:
        p = json.loads(fetch(f'{u.scheme}://{u.netloc}/products/{m.group(1)}.js'))
    except Exception:
        return None
    fix = lambda s: ('https:' + s) if s and s.startswith('//') else s
    opts = [{'name': o['name'], 'values': o['values']} for o in p.get('options', [])]
    ci = next((i for i, o in enumerate(opts) if re.search(r'colou?r', o['name'], re.I)), -1)
    si = next((i for i, o in enumerate(opts) if re.search(r'size', o['name'], re.I)), -1)
    colors, sizes = (opts[ci]['values'] if ci >= 0 else []), (opts[si]['values'] if si >= 0 else [])
    color = match(args.color, colors) if colors else None
    size = match(args.size, sizes) if sizes else args.size
    variant = next((v for v in p['variants'] if str(v['id']) == urllib.parse.parse_qs(u.query).get('variant', [''])[0]), None)
    if variant and not color and ci >= 0:
        color = variant['options'][ci]
    missing = []
    if len(colors) > 1 and not color:
        missing.append(('color', colors))
    if len(sizes) > 1 and not size:
        missing.append(('size', sizes))
    if missing or args.list:
        for what, vals in missing or [('color', colors), ('size', sizes)]:
            print(f'NEED {what}: ' + ' | '.join(vals))
        sys.exit(2)
    color = color or (colors[0] if colors else None)
    v = next((v for v in p['variants'] if (ci < 0 or v['options'][ci] == color) and (si < 0 or v['options'][si] == size)), None) \
        or next((v for v in p['variants'] if ci < 0 or v['options'][ci] == color), p['variants'][0])
    imgs = [fix(i) for i in p.get('images', [])]
    key = re.sub(r'[^a-z0-9]+', '_', (color or '').lower())
    own = [fix(v['featured_image']['src'])] if v.get('featured_image') else []
    own += [i for i in imgs if key and key in re.sub(r'[^a-z0-9]+', '_', i.lower()) and i not in own]
    img = (own or imgs or [''])[0]
    text = ' '.join([p['title'], p.get('type') or '', re.sub(r'<[^>]+>', ' ', p.get('description') or '')])
    return {'name': title_case(p['title']), 'brand': p.get('vendor') or '', 'type': p.get('type') or '', 'text': text,
            'colorName': title_case(color) if color else '', 'size': size or '', 'price': v['price'] / 100,
            'storeImg': img + ('&' if '?' in img else '?') + 'width=700' if img else '',
            'storeColors': [title_case(c) for c in colors], 'storeSizes': sizes,
            'url': f'{u.scheme}://{u.netloc}{u.path}'}

CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


def render_page(url):
    """Some stores (Nordstrom, Nordstrom Rack) block plain requests with a bot check, so load the page in headless Chrome.
    Pages are cached in /tmp for an hour so a NEED color/size re-run doesn't load the page again."""
    cache = Path(tempfile.gettempdir()) / f"cs_page_{hashlib.md5(url.encode()).hexdigest()}.html"
    import time
    if cache.exists() and time.time() - cache.stat().st_mtime < 3600 and '__INITIAL_CONFIG__' in cache.read_text(errors='replace'):
        return cache.read_text(errors='replace')
    for _ in range(3):
        with tempfile.TemporaryDirectory() as prof:
            out = subprocess.run([CHROME, '--headless=new', f'--user-data-dir={prof}', '--user-agent=' + UA['User-Agent'],
                                  '--virtual-time-budget=20000', '--dump-dom', url], capture_output=True, text=True, timeout=120).stdout
        if '__INITIAL_CONFIG__' in out:
            cache.write_text(out)
            return out
        time.sleep(4)
    return ''


def find_key(o, key, acc):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key:
                acc.append(v)
            find_key(v, key, acc)
    elif isinstance(o, list):
        for x in o:
            find_key(x, key, acc)
    return acc


def from_nordstrom(u, args):
    if 'nordstrom' not in u.netloc:
        return None
    url = urllib.parse.urlunparse(u._replace(query='', fragment=''))
    html = render_page(url)
    if not html:
        return None
    i = html.index('=', html.index('window.__INITIAL_CONFIG__')) + 1
    cfg, _ = json.JSONDecoder().raw_decode(html[i:].lstrip())
    m = re.search(r'<script[^>]+ld\+json[^>]*>(.*?)</script>', html, re.S)
    ld = json.loads(m.group(1)) if m else {}
    title = re.search(r'<title>([^<|]*)', html)
    title = re.sub(r'\s*\((Women|Men|Girls|Boys|Kids)\)\s*$', '', title.group(1).strip()).replace('&amp;', '&') if title else ''
    brand = (ld.get('brand') or {}).get('name') or ''
    name = ld.get('name') or title
    if brand and name.lower().startswith(brand.lower() + ' '):
        name = name[len(brand) + 1:]
    if not brand and title:
        bm = re.search(r'"brandName":"([^"]+)"', html) or re.search(r'"brandLink":"[^"]*?(?:/|u002F)brands(?:/|\\u002F)([a-z0-9-]+)"', html)
        brand = bm.group(1).replace('-', ' ').title() if bm else ''
        name = title[len(brand) + 1:] if brand and title.lower().startswith(brand.lower() + ' ') else title
    choices = []
    for cc in find_key(cfg, 'coreChoices', []):
        for c in cc:
            shots = c.get('orderedShots') or []
            img = next((x['imageUrl'] for x in shots if x.get('shotName') != 'swatch'), None)
            if c.get('displayColorDescription') and c['displayColorDescription'] not in [x[0] for x in choices]:
                choices.append((c['displayColorDescription'], img))
    choices = [(re.sub(r'\s*-\s+', '/', n), im) for n, im in choices]
    colors = [c[0] for c in choices]
    sizes = []
    for ss in find_key(cfg, 'sizeSelections', []):
        for x in ss:
            if x.get('sizeDisplayName') and x['sizeDisplayName'] not in sizes:
                sizes.append(x['sizeDisplayName'])
    sizes = [z for z in sizes if not (z == 'One Size' and len(sizes) > 1)] if len(sizes) > 1 else sizes
    color = match(args.color, colors) if colors else None
    size = match(args.size, sizes) if sizes else args.size
    missing = []
    if len(colors) > 1 and not color:
        missing.append(('color', colors))
    if len(sizes) > 1 and not size:
        missing.append(('size', sizes))
    if missing or args.list:
        for what, vals in missing or [('color', colors), ('size', sizes)]:
            print(f'NEED {what}: ' + ' | '.join(vals))
        sys.exit(2)
    color = color or (colors[0] if colors else '')
    size = size or (sizes[0] if len(sizes) == 1 else '')
    img = dict(choices).get(color) or ((ld.get('image') or [''])[0])
    price = (ld.get('offers') or {}).get('price')
    if not price:
        pm = re.search(r'"(?:price|currentPrice)":"?\$?([0-9]+(?:\.[0-9]+)?)', html)
        price = pm.group(1) if pm else 0
    return {'name': title_case(name), 'brand': brand.title() if brand.isupper() else brand, 'type': '', 'text': name + ' ' + (ld.get('description') or ''),
            'colorName': title_case(color), 'size': size or '', 'price': float(price or 0),
            'storeImg': img + '?w=900' if img else '', 'storeColors': [title_case(c) for c in colors], 'storeSizes': sizes, 'url': url}


def from_gap(u, args):
    """Old Navy, Gap, Banana Republic, Athleta: the pid in the link already picks the color."""
    if not re.search(r'(^|\.)(gap|oldnavy|bananarepublic|athleta)\.|gap\.com$|gapfactory', u.netloc):
        return None
    pid = urllib.parse.parse_qs(u.query).get('pid', [''])[0]
    url = f'{u.scheme}://{u.netloc}/browse/product.do?pid={pid}' if pid else urllib.parse.urlunparse(u._replace(fragment=''))
    html = fetch(url)
    prod = None
    for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S):
        try:
            d = json.loads(block)
        except Exception:
            continue
        if d.get('@type') == 'Product':
            prod = d
    if not prod:
        return None
    unq = lambda t: t.replace('&amp;', '&').replace('&#x27;', "'").replace('&quot;', '"')
    colors = [unq(c).split(',')[0].strip() for c in re.findall(r'aria-label="([^"]+)"[^>]*name="buybox-color-swatch"', html)]
    selected = unq(prod.get('color') or '')
    dims = {}
    for dim, v in re.findall(r'id="pdp_buybox_dimension_([^"]+)"[^>]*name="buybox-sizeDimension(\d)"', html):
        dims.setdefault(v, [])
        if dim not in dims[v]:
            dims[v].append(dim)
    sizes = dims.get('1', [])
    lengths = dims.get('2', [])
    if args.color and colors:
        want = match(args.color, colors)
        if want and want != selected:
            print(f'NOTE: link shows {selected}; you said {want}. Using {want} for the name but the photo is from the link.')
        selected = want or selected
    size = match(args.size, sizes) if sizes else args.size
    if args.size and lengths:
        size = args.size
    missing = []
    if len(sizes) > 1 and not size:
        missing.append(('size', sizes + ([f'(lengths: {" | ".join(lengths)})'] if lengths else [])))
    if missing or args.list:
        for what, vals in missing or [('color', colors), ('size', sizes)]:
            print(f'NEED {what}: ' + ' | '.join(vals))
        sys.exit(2)
    imgs = prod.get('image') or []
    imgs = imgs if isinstance(imgs, list) else [imgs]
    offers = prod.get('offers') or [{}]
    offers = offers if isinstance(offers, list) else [offers]
    img = imgs[0] if imgs else offers[0].get('image', '')
    return {'name': unq(prod.get('name', '')), 'brand': (prod.get('brand') or {}).get('name', ''), 'type': '',
            'text': prod.get('name', '') + ' ' + prod.get('description', ''), 'colorName': title_case(selected), 'size': size or '',
            'price': float(offers[0].get('price') or 0), 'storeImg': img, 'storeColors': [title_case(c) for c in colors], 'storeSizes': sizes, 'url': url}


def from_html(u, args):
    html = fetch(urllib.parse.urlunparse(u))
    prod = None
    for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I):
        try:
            data = json.loads(block.strip())
        except Exception:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            d = stack.pop()
            if isinstance(d, dict):
                t = d.get('@type')
                if t == 'Product' or (isinstance(t, list) and 'Product' in t) or t == 'ProductGroup':
                    prod = prod or d
                stack.extend(d.get('@graph', []) if isinstance(d.get('@graph'), list) else [])
            elif isinstance(d, list):
                stack.extend(d)
    meta = lambda prop: (re.search(r'<meta[^>]+(?:property|name)=["\']' + prop + r'["\'][^>]+content=["\']([^"\']+)', html, re.I) or [None, ''])[1]
    name = html_lib.unescape((prod or {}).get('name') or meta('og:title') or '')
    brand = (prod or {}).get('brand')
    brand = brand.get('name') if isinstance(brand, dict) else brand or meta('og:site_name') or u.netloc.replace('www.', '').split('.')[0].title()
    img = (prod or {}).get('image') or meta('og:image')
    img = img[0] if isinstance(img, list) else img.get('url') if isinstance(img, dict) else img
    offers = (prod or {}).get('offers') or {}
    offers = offers[0] if isinstance(offers, list) and offers else offers
    price = offers.get('price') or offers.get('lowPrice') or meta('product:price:amount') or 0
    if not name:
        return None
    return {'name': title_case(name), 'brand': brand, 'type': '', 'text': name + ' ' + ((prod or {}).get('description') or ''),
            'colorName': title_case(args.color) if args.color else '', 'size': args.size or '', 'price': float(str(price).replace(',', '') or 0),
            'storeImg': img or '', 'storeColors': [], 'storeSizes': [], 'url': urllib.parse.urlunparse(u._replace(query='', fragment=''))}


def load_catalog():
    if not CATALOG.exists():
        return []
    txt = CATALOG.read_text()
    m = re.search(r'window\.CLOSET_CATALOG\s*=\s*(\[.*\])\s*;?\s*$', txt, re.S)
    return json.loads(m.group(1)) if m else []


def save_catalog(items):
    # Every entry gets a permanent id so the app can push later edits (size, color, photo) onto the piece it already merged.
    taken = {c.get('id') for c in items}
    for i, c in enumerate(items):
        if not c.get('id'):
            while True:
                cid = 'c_' + secrets.token_hex(4)
                if cid not in taken:
                    break
            taken.add(cid)
            items[i] = {'id': cid, **c}
    CATALOG.write_text('/* Maison Moi product catalog (managed by tools/add_product.py; safe to hand-edit as JSON).\n'
                       '   The app reads this file on every load and adds pieces it has not seen before to your closet + library.\n'
                       '   Photos live in images/ next to this file so they work offline. */\n'
                       'window.CLOSET_CATALOG = ' + json.dumps(items, indent=2, ensure_ascii=False) + ';\n')


def write_csv(items):
    cols = ['product_id', 'in_closet', 'status', 'name', 'brand', 'category', 'color_family', 'color_name', 'size', 'price', 'condition',
            'formality_1_5', 'comfort_1_5', 'style_tags', 'seasons', 'wash_every_n_wears', 'sentimental', 'wear_count', 'last_worn',
            'product_url', 'image_url', 'local_image', 'store_colors', 'store_sizes', 'notes', 'added', 'updated']
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\r\n')
    w.writerow(cols)
    for c in items:
        w.writerow(['', 'yes' if c.get('inCloset', True) else 'no', 'keep', c['name'], c['brand'], c['category'], c['color'], c['colorName'], c['size'],
                    c['price'] or '', c['condition'], c['formality'], c['comfort'], '; '.join(c['tags']), '; '.join(c['seasons']), c['washEvery'],
                    'yes' if c['sentimental'] else 'no', 0, '', c['url'], c['storeImg'], c['img'], '; '.join(c['storeColors']), '; '.join(c['storeSizes']),
                    c['notes'], c.get('added', ''), c.get('added', '')])
    CSV_PATH.write_text('﻿' + buf.getvalue(), encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('url'); ap.add_argument('--color'); ap.add_argument('--size'); ap.add_argument('--price', type=float)
    ap.add_argument('--name'); ap.add_argument('--category', choices=list(CATS)); ap.add_argument('--notes', default='')
    ap.add_argument('--condition', default='Like new'); ap.add_argument('--sentimental', action='store_true')
    ap.add_argument('--not-in-closet', action='store_true'); ap.add_argument('--list', action='store_true')
    args = ap.parse_args()
    u = urllib.parse.urlparse(args.url.strip())
    info = from_shopify(u, args) or from_nordstrom(u, args) or from_gap(u, args) or from_html(u, args)
    if not info:
        print('FAILED: could not read product details from that page'); sys.exit(1)
    # Titles often look like "Name | Color" or "Name | Brand": split that off instead of keeping it in the name.
    parts = [x.strip() for x in re.split(r'\s+[|–—]\s+', info['name']) if x.strip()] or [info['name']]
    tail = [t for t in parts[1:] if t.lower() != (info['brand'] or '').lower()]
    info['name'] = parts[0]
    if tail and not info['colorName'] and guess_color(tail[0]):
        info['colorName'] = title_case(tail[0])
    cat = args.category or guess_category(info['name'] + ' ' + info['type'])
    entry = {'name': args.name or info['name'], 'brand': info['brand'], 'category': cat,
             'color': guess_color(info['colorName']) or guess_color(info['name']) or 'gray', 'colorName': info['colorName'],
             'size': info['size'], 'price': args.price if args.price is not None else info['price'], 'condition': args.condition,
             **guess_fit(cat, info['text']), 'washEvery': CATS[cat], 'sentimental': args.sentimental, 'inCloset': not args.not_in_closet,
             'url': info['url'], 'img': '', 'storeImg': info['storeImg'], 'storeColors': info['storeColors'], 'storeSizes': info['storeSizes'],
             'notes': args.notes, 'added': date.today().isoformat()}
    items = load_catalog()
    key = lambda c: (c['url'].lower().rstrip('/'), c['size'].lower(), c['colorName'].lower())
    if any(key(c) == key(entry) for c in items):
        print(f"ALREADY IN CATALOG: {entry['name']} ({entry['colorName'] or 'no color'}, {entry['size'] or 'no size'})"); return
    if entry['storeImg']:
        IMAGES.mkdir(exist_ok=True)
        fname = slug(f"{entry['brand']} {entry['name']} {entry['colorName']}") + '.jpg'
        try:
            (IMAGES / fname).write_bytes(fetch(entry['storeImg'], binary=True))
            entry['img'] = f'images/{fname}'
        except Exception as e:
            print(f'WARN: photo download failed ({e}); the app will use the live store photo')
    items.append(entry)
    save_catalog(items)
    write_csv(items)
    print('ADDED ' + json.dumps({k: entry[k] for k in ('name', 'brand', 'category', 'color', 'colorName', 'size', 'price', 'formality', 'comfort', 'tags', 'img')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
