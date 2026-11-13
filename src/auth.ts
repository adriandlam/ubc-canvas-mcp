import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

// UBC's sign-in page. The saved password is only ever typed here, which also keeps it away from
// any other Canvas instance set with CANVAS_URL.
const CWL = 'https://authentication.ubc.ca/';
const SECRET = { service: 'ubc-canvas-mcp', name: 'cwl' };

type Login = { username: string; password: string };

// The browser profile keeps Duo's 30-day device trust, but not the Canvas or CWL session cookies,
// so every renewal goes through the CWL form: filled from the keychain if a login was saved,
// otherwise by the user in a visible window.
export function createAuth(base: URL, dir: string) {
  const sessionFile = join(dir, 'cookie');
  let current: string | null = null;
  let renewing: Promise<string> | null = null;

  const onCanvas = (url: URL) => url.origin === base.origin && !url.pathname.startsWith('/login');

  async function savedSession(): Promise<string | null> {
    return Bun.file(sessionFile).text().then((s) => s || null, () => null);
  }

  async function savedLogin(): Promise<Login | null> {
    const s = await Bun.secrets.get(SECRET);
    return s ? JSON.parse(s) : null;
  }

  async function signIn(headless: boolean, remember: boolean): Promise<string | null> {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const before = await savedSession();
    const { chromium } = await import('playwright-core'); // only loaded when signing in
    const ctx = await chromium
      .launchPersistentContext(join(dir, 'profile'), { ...browser(), headless, viewport: null })
      .catch((e: Error) => {
        if (/ProcessSingleton|already running/i.test(e.message)) return null;
        throw e;
      });
    if (!ctx) return sessionSavedSince(before);
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      let typed: Login | null = null;
      page.on('request', (r) => {
        if (r.method() !== 'POST' || !r.url().startsWith(CWL)) return;
        const form = new URLSearchParams(r.postData() ?? '');
        const [username, password] = [form.get('j_username'), form.get('j_password')];
        if (username && password) typed = { username, password };
      });

      await page.goto(base.href, { waitUntil: 'domcontentloaded' });
      const login = await savedLogin();
      const autofill = !!login && page.url().startsWith(CWL);
      if (autofill) {
        await page.locator('input[name=j_username]').fill(login.username);
        await page.locator('input[name=j_password]').fill(login.password);
        await page.locator('button[name=_eventId_proceed]').click();
      }
      if (!onCanvas(new URL(page.url())) && (autofill || !headless)) {
        if (!headless) console.error('Log in with your CWL in the browser window. It closes by itself when you are done.');
        // Duo lets a trusted browser straight through; otherwise this waits for MFA in the window.
        await page.waitForURL(onCanvas, { timeout: headless ? 60_000 : 5 * 60_000 }).catch(() => {});
      }
      if (!onCanvas(new URL(page.url()))) return null;

      if (typed && (remember || login)) await Bun.secrets.set({ ...SECRET, value: JSON.stringify(typed) });
      const cookie = (await ctx.cookies(base.href)).map((c) => `${c.name}=${c.value}`).join('; ');
      writeFileSync(sessionFile, cookie, { mode: 0o600 });
      return cookie;
    } finally {
      await ctx.close();
    }
  }

  // Another server (Claude Code and Claude Desktop each run one) holds the profile and is signing in.
  async function sessionSavedSince(before: string | null): Promise<string | null> {
    for (let waited = 0; waited < 5 * 60_000; waited += 1000) {
      await Bun.sleep(1000);
      const now = await savedSession();
      if (now && now !== before) return now;
    }
    return null;
  }

  async function renew(stale?: string): Promise<string> {
    const saved = await savedSession();
    if (saved && saved !== stale) return saved;
    // Without a saved login only a person can get through CWL, so go straight to the window.
    const cookie = ((await savedLogin()) && (await signIn(true, false))) || (await signIn(false, false));
    if (!cookie) throw new Error('Could not sign in to Canvas. Run `ubc-canvas-mcp login`.');
    return cookie;
  }

  return {
    // A cookie header for Canvas. Pass the one Canvas just rejected to get a new one; concurrent
    // callers share a single renewal.
    async cookie(stale?: string): Promise<string> {
      if (current && current !== stale) return current;
      renewing ??= renew(stale).finally(() => (renewing = null));
      return (current = await renewing);
    },

    async login(remember: boolean): Promise<void> {
      current = await signIn(false, remember);
      if (!current) throw new Error('Login did not finish.');
    },

    async logout(): Promise<void> {
      rmSync(join(dir, 'profile'), { recursive: true, force: true });
      rmSync(sessionFile, { force: true });
      await Bun.secrets.delete(SECRET);
    },
  };
}

// Every Windows has Edge; elsewhere Playwright finds Chrome. Other Chromium browsers need the path.
function browser() {
  const path = process.env.UBC_CANVAS_BROWSER;
  return path ? { executablePath: path } : { channel: platform() === 'win32' ? 'msedge' : 'chrome' };
}
