#!/usr/bin/env node
// ubc-canvas-mcp: read-only MCP server for UBC Canvas, authenticated with your own CWL login.
// Canvas API tokens are disabled for UBC students, so this signs in through a real browser
// once, keeps that browser profile, and reuses its Canvas session cookie for plain HTTPS calls.
import { Entry } from '@napi-rs/keyring';
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const BASE = new URL(process.env.CANVAS_URL || 'https://canvas.ubc.ca');
const DIR =
  process.env.UBC_CANVAS_MCP_DIR ||
  (platform() === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'ubc-canvas-mcp')
    : platform() === 'win32'
      ? join(process.env.APPDATA || homedir(), 'ubc-canvas-mcp')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ubc-canvas-mcp'));
const PROFILE = join(DIR, 'profile');
const SESSION = join(DIR, 'session.json');

// ---------- browser ----------

function findBrowser() {
  if (process.env.UBC_CANVAS_BROWSER) return process.env.UBC_CANVAS_BROWSER;
  const candidates = {
    darwin: ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Helium'].map(
      (n) => `/Applications/${n}.app/Contents/MacOS/${n}`,
    ),
    win32: [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ].flatMap((p) => [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].map((d) => d && join(d, p))),
    linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].flatMap(
      (n) => ['/usr/bin/', '/usr/local/bin/', '/snap/bin/'].map((d) => d + n),
    ),
  }[platform()] ?? [];
  const found = [...candidates, chromium.executablePath()].find((p) => p && existsSync(p));
  if (!found)
    throw new Error('No Chrome, Edge, Brave or Chromium found. Install one, run `npx playwright install chromium`, or set UBC_CANVAS_BROWSER.');
  return found;
}

// Optional saved CWL login (`login --remember`), kept in the OS keychain, never on disk.
const keychain = new Entry('ubc-canvas-mcp', 'cwl');
const loadCreds = () => {
  try {
    return JSON.parse(keychain.getPassword() ?? 'null');
  } catch {
    return null;
  }
};

const onCanvas = (url) => {
  const u = new URL(url);
  return u.origin === BASE.origin && !u.pathname.startsWith('/login');
};

// Opens the saved profile, lets CWL single sign-on run, and returns the Canvas cookie header.
// headless: only succeeds if the profile is still signed in to CWL. headed: waits for you to log in.
// remember: save the CWL username/password you type (only once it has actually reached Canvas).
async function browserLogin({ headless, remember = false }) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, { executablePath: findBrowser(), headless, viewport: null });
  } catch (e) {
    // ponytail: profile lock means another instance is mid-login; it will write session.json, so reuse that.
    if (/ProcessSingleton|in use|lock/i.test(e.message)) return readSession();
    throw e;
  }
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const creds = loadCreds();
    let typed = null;
    if (remember || creds)
      page.on('request', (r) => {
        if (r.method() !== 'POST' || new URL(r.url()).hostname !== 'authentication.ubc.ca') return;
        const f = new URLSearchParams(r.postData() ?? '');
        if (f.get('j_username') && f.get('j_password')) typed = { username: f.get('j_username'), password: f.get('j_password') };
      });
    if (remember) await ctx.clearCookies({ domain: BASE.hostname }); // force the CWL form so there is something to remember
    await page.goto(BASE.href, { waitUntil: 'domcontentloaded' });
    const user = page.locator('input[name=j_username]');
    // Only ever type the saved password into UBC's real sign-in page (also rules out a custom CANVAS_URL).
    const atCwl = page.url().startsWith('https://authentication.ubc.ca/');
    if (atCwl && creds && (await user.count())) {
      await user.fill(creds.username);
      await page.locator('input[name=j_password]').fill(creds.password);
      await page.locator('button[name=_eventId_proceed]').click();
      // Duo is skipped while the browser is trusted (30 days); otherwise this waits for a push approval.
      await page.waitForURL((u) => onCanvas(u.href), { timeout: 60_000 }).catch(() => {});
    }
    if (!onCanvas(page.url())) {
      if (headless) return null;
      console.error('Log in with your CWL in the browser window. It closes by itself when you are done.');
      await page.waitForURL((u) => onCanvas(u.href), { timeout: 5 * 60_000 });
    }
    if (typed && (remember || typed.password !== creds?.password)) keychain.setPassword(JSON.stringify(typed));
    const cookies = await ctx.cookies(BASE.href);
    if (!cookies.some((c) => c.name === 'canvas_session')) return null;
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    writeFileSync(SESSION, JSON.stringify({ cookie, saved_at: new Date().toISOString() }), { mode: 0o600 });
    return cookie;
  } finally {
    await ctx.close();
  }
}

function readSession() {
  try {
    return JSON.parse(readFileSync(SESSION, 'utf8')).cookie;
  } catch {
    return null;
  }
}

// ---------- Canvas API ----------

let cookie = null;
let refreshing = null;

async function getCookie(stale) {
  if (cookie && cookie !== stale) return cookie;
  const saved = readSession(); // another process may have refreshed it already
  if (saved && saved !== stale) return (cookie = saved);
  refreshing ??= (async () => {
    // Quiet headless refresh first; pop a window only when CWL actually needs you.
    // ponytail: no stored CWL password, so an expired CWL/MFA session always means one manual login.
    return (await browserLogin({ headless: true })) ?? (await browserLogin({ headless: false }));
  })().finally(() => (refreshing = null));
  cookie = await refreshing;
  if (!cookie) throw new Error('Could not sign in to Canvas. Run `npx ubc-canvas-mcp login`.');
  return cookie;
}

async function fetchCanvas(url) {
  let c = await getCookie();
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { Cookie: c, Accept: 'application/json' }, redirect: 'manual' });
    if ((r.status === 401 || (r.status >= 300 && r.status < 400)) && attempt === 0) {
      c = await getCookie(c);
      continue;
    }
    return r;
  }
}

async function canvasGet(path, params = {}, maxPages = 10) {
  const url = new URL(`/api/v1/${String(path).replace(/^\/*(api\/v1\/)?/, '')}`, BASE);
  for (const [k, v] of Object.entries(params ?? {})) for (const x of [].concat(v)) url.searchParams.append(k, x);
  if (!url.searchParams.has('per_page')) url.searchParams.set('per_page', '100');
  const out = [];
  let next = url.href;
  for (let i = 0; next && i < maxPages; i++) {
    // URL() resolves "..", so this also stops paths escaping the API onto ordinary Canvas pages.
    const u = new URL(next);
    if (u.origin !== BASE.origin || !u.pathname.startsWith('/api/v1/')) throw new Error(`refusing to request ${next}`);
    const r = await fetchCanvas(next);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${(await r.text()).slice(0, 500)}`);
    const body = JSON.parse((await r.text()).replace(/^while\(1\);/, '')); // cookie-auth JSON has a CSRF guard prefix
    if (!Array.isArray(body)) return body;
    out.push(...body);
    next = r.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  return out;
}

// ---------- MCP (stdio JSON-RPC) ----------

const TOOL = {
  name: 'canvas_get',
  description: `Read-only GET against the Canvas REST API at ${BASE.origin}/api/v1, signed in as the user. Paginated lists are merged (up to 1000 items).
Useful paths: users/self/todo, users/self/upcoming_events, planner/items, courses (params {enrollment_state:"active"}),
courses/:id/assignments (params {bucket:"upcoming"|"past"|"overdue", "include[]":"submission"}), courses/:id/modules (params {"include[]":"items"}),
courses/:id/pages/:page_url, courses/:id/files, courses/:id/discussion_topics, announcements (params {"context_codes[]":"course_:id"}),
courses/:id/assignments/:aid/submissions/self, courses/:id/enrollments (params {user_id:"self"}) for grades.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Endpoint path after /api/v1/, e.g. "courses/123/assignments"' },
      params: { type: 'object', description: 'Query params; array values repeat the key (use "include[]" style keys)' },
    },
    required: ['path'],
  },
};

function serve() {
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined) return; // notification
    const reply = (result) => send({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'ubc-canvas', version: JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: [TOOL] });
      case 'tools/call':
        try {
          const data = await canvasGet(params.arguments?.path, params.arguments?.params);
          return reply({ content: [{ type: 'text', text: JSON.stringify(data) }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: String(e.message) }], isError: true });
        }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
    }
  });
}

// ---------- CLI ----------

const cmd = process.argv[2];
if (cmd === 'login') {
  const c = await browserLogin({ headless: false, remember: process.argv.includes('--remember') });
  if (!c) throw new Error('Login did not finish.');
  const me = await canvasGet('users/self');
  console.error(`Signed in as ${me.name}. Session saved to ${SESSION}`);
} else if (cmd === 'logout') {
  rmSync(DIR, { recursive: true, force: true });
  try {
    keychain.deletePassword();
  } catch {}
  console.error(`Removed ${DIR} and any saved CWL login`);
} else if (!cmd || cmd === 'serve') {
  serve();
} else {
  console.error('usage: ubc-canvas-mcp [serve | login [--remember] | logout]');
  process.exit(1);
}
