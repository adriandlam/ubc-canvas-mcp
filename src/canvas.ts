export type Cookie = (stale?: string) => Promise<string>;
export type Params = Record<string, string | number | boolean | (string | number)[]>;
export type CanvasFile = { url: string; name: string; type: string; bytes: Uint8Array };

const MAX_PAGES = 10;
const MAX_BYTES = 50e6;

// Read-only Canvas client. Requests start only at API or file-download URLs on `base`, and the
// cookie never leaves `base`'s origin: redirects elsewhere (signed file-storage URLs) go without it.
export function createCanvas(base: URL, cookie: Cookie) {
  const allowed = (url: URL) =>
    url.origin === base.origin &&
    (url.pathname.startsWith('/api/v1/') || /^\/(courses\/\d+\/)?files\/\d+\/download$/.test(url.pathname));

  async function request(href: string): Promise<Response> {
    let url = new URL(href, base); // resolves "..", so the check below sees the real path
    if (!allowed(url)) throw new Error(`refusing to request ${url.href}`);
    let c = await cookie();
    let renewed = false;
    for (let hop = 0; hop < 6; hop++) {
      if (url.origin !== base.origin) return fetch(url);
      const r = await fetch(url, { headers: { Cookie: c, Accept: 'application/json' }, redirect: 'manual' });
      const location = r.headers.get('location');
      const next = location ? new URL(location, url) : null;
      // Canvas answers 401 both for a dead session ("unauthenticated") and for missing permission.
      const expired =
        (r.status === 401 && (await r.clone().text()).includes('"unauthenticated"')) ||
        (next?.origin === base.origin && next.pathname.startsWith('/login'));
      if (expired) {
        if (renewed) throw new Error('Canvas rejected the session right after signing in again.');
        c = await cookie(c);
        renewed = true;
        continue;
      }
      if (!next) return r;
      url = next;
    }
    throw new Error(`too many redirects from ${href}`);
  }

  async function get<T = unknown>(path: string, params: Params = {}): Promise<T> {
    const url = new URL(`/api/v1/${path.replace(/^\/*(api\/v1\/)?/, '')}`, base);
    for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) url.searchParams.append(k, String(x));
    if (!url.searchParams.has('per_page')) url.searchParams.set('per_page', '100');
    const items: unknown[] = [];
    let next: string | undefined = url.href;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const r = await request(next);
      const text = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${text.slice(0, 500)}`);
      // Canvas prefixes JSON with while(1); for cookie-authenticated requests.
      const body = JSON.parse(text.replace(/^while\(1\);/, ''));
      if (!Array.isArray(body)) return body;
      items.push(...body);
      next = r.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    if (next) items.push({ truncated: `stopped after ${MAX_PAGES} pages; narrow the request with params` });
    return items as T;
  }

  // `ref` is a file id or anything containing files/:id, such as a module item's url.
  async function download(ref: string): Promise<CanvasFile> {
    const m = ref.match(/((?:courses\/\d+\/)?files\/\d+)|^\s*(\d+)\s*$/);
    if (!m) throw new Error('Pass a file id, or a path/URL containing files/:id (e.g. from a module item).');
    const meta = await get<{
      id: number;
      display_name: string;
      size: number;
      url?: string;
      'content-type'?: string;
      lock_explanation?: string;
    }>(m[1] ?? `files/${m[2]}`);
    if (!meta.url) throw new Error(`${meta.display_name} is locked. ${meta.lock_explanation ?? ''}`.trim());
    if (meta.size > MAX_BYTES)
      throw new Error(`${meta.display_name} is ${Math.round(meta.size / 1e6)} MB; the limit is ${MAX_BYTES / 1e6} MB.`);
    const r = await request(meta.url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} downloading ${meta.display_name}`);
    return {
      url: new URL(`/files/${meta.id}`, base).href,
      name: meta.display_name,
      type: meta['content-type'] || r.headers.get('content-type') || 'application/octet-stream',
      bytes: new Uint8Array(await r.arrayBuffer()),
    };
  }

  return { get, download };
}
