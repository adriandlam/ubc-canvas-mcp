import { afterAll, expect, test } from 'bun:test';
import { createCanvas } from '../src/canvas';

// Two fake servers on different ports, so different origins: Canvas, and the file storage it
// redirects downloads to.
const storageCookies: (string | null)[] = [];
const storage = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    storageCookies.push(req.headers.get('cookie'));
    return new Response('%PDF-1.4 bytes');
  },
});
let valid = 'canvas_session=new';
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req): Response {
    const url = new URL(req.url);
    const cookie = req.headers.get('cookie');
    if (cookie !== valid) return new Response('{"status":"unauthenticated"}', { status: 401 });
    const json = (body: unknown, headers = {}) => new Response(`while(1);${JSON.stringify(body)}`, { headers });
    switch (url.pathname) {
      case '/api/v1/items':
        return url.searchParams.get('page') === '2'
          ? json([{ n: 3 }])
          : json([{ n: 1 }, { n: 2 }], { link: `<${base.origin}/api/v1/items?page=2>; rel="next"` });
      case '/api/v1/hidden':
        return new Response('{"status":"unauthorized","errors":[{"message":"user not authorized to perform that action"}]}', { status: 401 });
      case '/api/v1/offsite':
        return json([], { link: `<${storage.url.origin}/api/v1/items>; rel="next"` });
      case '/api/v1/courses/1/files/9':
        return json({ id: 9, display_name: 'notes.pdf', size: 14, url: `${base.origin}/files/9/download?verifier=x`, 'content-type': 'application/pdf' });
      case '/files/9/download':
        return Response.redirect(`${storage.url.origin}/signed/notes.pdf`, 302);
    }
    return new Response('not found', { status: 404 });
  },
});
const base: URL = new URL(`http://127.0.0.1:${server.port}`);
afterAll(() => {
  server.stop();
  storage.stop();
});

// Stands in for auth: hands out the current cookie, and a new one when told the current one is stale.
let current = 'canvas_session=new';
const renewals: string[] = [];
const canvas = createCanvas(base, async (stale) => {
  if (stale === current) {
    renewals.push(stale);
    current = 'canvas_session=new';
  }
  return current;
});

test('merges paginated lists', async () => {
  expect(await canvas.get('items')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('renews an expired session once and retries', async () => {
  current = 'canvas_session=old';
  renewals.length = 0;
  await canvas.get('items');
  expect(renewals).toEqual(['canvas_session=old']);
});

test('treats a missing permission as an error, not an expired session', async () => {
  renewals.length = 0;
  await expect(canvas.get('hidden')).rejects.toThrow(/401.*not authorized/);
  expect(renewals).toEqual([]);
});

test('gives up when Canvas rejects the renewed session too', async () => {
  valid = 'nothing works';
  await expect(canvas.get('items')).rejects.toThrow(/right after signing in again/);
  valid = 'canvas_session=new';
});

test('never sends the cookie outside the Canvas API and downloads', async () => {
  await expect(canvas.get('../../login')).rejects.toThrow(/refusing/);
  await expect(canvas.get('%2e%2e/%2e%2e/profile')).rejects.toThrow(/refusing/);
  await expect(canvas.get('offsite')).rejects.toThrow(/refusing/);
});

test('downloads through a redirect to file storage without the cookie', async () => {
  const f = await canvas.download('https://canvas.example/courses/1/files/9?wrap=1');
  expect(new TextDecoder().decode(f.bytes)).toBe('%PDF-1.4 bytes');
  expect(f.type).toBe('application/pdf');
  expect(storageCookies).toEqual([null]);
});
