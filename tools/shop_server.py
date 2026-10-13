#!/usr/bin/env python3
"""Shop helper for Maison Moi: live Poshmark search results for the Shop tab.

The app is opened as a local file, so the browser can't read other sites itself. This tiny server runs on
your Mac (http://127.0.0.1:8765), fetches Poshmark search pages, and hands the listings back to the Shop tab.

  python3 tools/shop_server.py            # start it (leave it running)
  curl 'http://127.0.0.1:8765/poshmark?q=silk+blouse&sizes=S&brands=FARM+Rio'
"""
import json, re, sys, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from add_product import fetch  # same browser-like request headers as the catalog tool

PORT = 8765
TTL = 6 * 3600  # Poshmark results are cached for 6 hours
CACHE_FILE = Path(__file__).parent / '.shop_cache.json'
IMAGES = (Path(__file__).parent.parent / 'images').resolve()
IMAGE_TYPES = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif'}
_lock = threading.Lock()
try:
    CACHE = json.loads(CACHE_FILE.read_text())
except Exception:
    CACHE = {}


def search_url(q, sizes=(), brand=None):
    params = [('query', q), ('department', 'Women')] + [('size[]', s) for s in sizes]
    if brand:
        params.append(('brand[]', brand))
    return 'https://poshmark.com/search?' + urllib.parse.urlencode(params)


def grid(url):
    with _lock:
        hit = CACHE.get(url)
    if hit and time.time() - hit['at'] < TTL:
        return hit['data']
    html = fetch(url)
    start = html.index('window.__INITIAL_STATE__=') + len('window.__INITIAL_STATE__=')
    state, _ = json.JSONDecoder().raw_decode(html[start:])
    data = [listing(x) for x in state.get('$_search', {}).get('gridData', {}).get('data', []) if x.get('cover_shot')]
    with _lock:
        CACHE[url] = {'at': time.time(), 'data': data}
        CACHE_FILE.write_text(json.dumps(CACHE))
    return data


def listing(x):
    slug = re.sub(r'[^A-Za-z0-9]+', '-', x.get('title', '')).strip('-')
    return {'id': x['id'], 'title': x.get('title', ''), 'brand': x.get('brand', ''),
            'price': float((x.get('price_amount') or {}).get('val') or 0),
            'size': (x.get('size_obj') or {}).get('display') or x.get('size') or '',
            'condition': x.get('condition', ''), 'img': x['cover_shot'].get('url', ''),
            'url': f'https://poshmark.com/listing/{slug}-{x["id"]}'}


def picks(q, sizes, brands, max_price, n):
    """Brands you already own come first, then the general search. Duplicates and pricey outliers are dropped."""
    out, seen = [], set()
    for brand in [*brands[:3], None]:
        try:
            rows = grid(search_url(q, sizes, brand))
        except Exception as e:
            print(f'poshmark failed for {q!r} {brand or ""}: {e}', file=sys.stderr)
            continue
        for r in rows[:6 if brand else 30]:
            if r['id'] in seen or (max_price and r['price'] > max_price):
                continue
            seen.add(r['id'])
            out.append({**r, 'yourBrand': bool(brand)})
    return out[:n]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _image(self, name):
        # Lets the app upload your closet photos to your account: a file:// page can't read images/ itself.
        f = (IMAGES / urllib.parse.unquote(name)).resolve()
        if f.parent != IMAGES or f.suffix.lower() not in IMAGE_TYPES or not f.is_file():
            return self._send(404, {'error': 'no such photo'})
        data = f.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', IMAGE_TYPES[f.suffix.lower()])
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in [('Access-Control-Allow-Origin', '*'), ('Access-Control-Allow-Methods', 'GET'),
                     ('Access-Control-Allow-Headers', '*'), ('Access-Control-Allow-Private-Network', 'true')]:
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        arg = lambda k: (qs.get(k) or [''])[0]
        split = lambda k: [s.strip() for s in arg(k).split(',') if s.strip()]
        if u.path.startswith('/images/'):
            return self._image(u.path[len('/images/'):])
        if u.path == '/health':
            return self._send(200, {'ok': True})
        if u.path == '/poshmark' and arg('q'):
            items = picks(arg('q'), split('sizes'), split('brands'), float(arg('max') or 0), int(arg('n') or 8))
            return self._send(200, {'items': items, 'search': search_url(arg('q'), split('sizes'))})
        self._send(404, {'error': 'unknown path'})

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    print(f'Maison Moi shop helper running on http://127.0.0.1:{PORT}')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
