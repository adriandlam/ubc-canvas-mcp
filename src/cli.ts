#!/usr/bin/env bun
// UBC doesn't let students create Canvas API tokens, so this signs in with CWL in a real browser
// and calls the Canvas API with that browser session's cookie.
import { homedir, platform } from 'node:os';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAuth } from './auth';
import { createCanvas } from './canvas';
import { serve } from './mcp';
import { canvasTools } from './tools';

const env = process.env;
const base = new URL(env.CANVAS_URL || 'https://canvas.ubc.ca');
const dir =
  env.UBC_CANVAS_MCP_DIR ||
  {
    darwin: join(homedir(), 'Library', 'Application Support', 'ubc-canvas-mcp'),
    win32: join(env.APPDATA || homedir(), 'ubc-canvas-mcp'),
  }[platform() as string] ||
  join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ubc-canvas-mcp');

const filesDir = join(dir, 'files');
const auth = createAuth(base, dir);
const canvas = createCanvas(base, auth.cookie);

switch (process.argv[2] ?? 'serve') {
  case 'serve':
    await serve(canvasTools(canvas, filesDir));
    break;
  case 'login': {
    await auth.login(process.argv.includes('--remember'));
    const me = await canvas.get<{ name: string }>('users/self');
    console.error(`Signed in as ${me.name}.`);
    break;
  }
  case 'logout':
    await auth.logout();
    rmSync(filesDir, { recursive: true, force: true });
    console.error('Signed out: removed the browser profile, session, downloads and any saved CWL login.');
    break;
  default:
    console.error('usage: ubc-canvas-mcp [serve | login [--remember] | logout]');
    process.exit(1);
}
