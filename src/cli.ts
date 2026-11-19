#!/usr/bin/env bun
// UBC doesn't let students create Canvas API tokens, so this signs in with CWL in a real browser
// and calls the Canvas API with that browser session's cookie.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from './auth';
import { createCanvas, type Params } from './canvas';
import { compact, fileContent, text } from './format';
import { serve, type Tool } from './mcp';

const env = process.env;
const base = new URL(env.CANVAS_URL || 'https://canvas.ubc.ca');
const dir = env.UBC_CANVAS_MCP_DIR || join(homedir(), '.ubc-canvas-mcp');

const auth = createAuth(base, dir);
const canvas = createCanvas(base, auth.cookie);

switch (process.argv[2] ?? 'serve') {
  case 'serve':
    await serve(canvasTools(canvas));
    break;
  case 'login': {
    await auth.login(process.argv.includes('--remember'));
    const me = await canvas.get<{ name: string }>('users/self');
    console.error(`Signed in as ${me.name}.`);
    break;
  }
  case 'logout':
    await auth.logout();
    console.error('Signed out: removed the browser profile, session and any saved CWL login.');
    break;
  default:
    console.error('usage: ubc-canvas-mcp [serve | login [--remember] | logout]');
    process.exit(1);
}

function canvasTools(canvas: ReturnType<typeof createCanvas>): Tool[] {
  return [
    {
      name: 'canvas_get',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: `Read-only GET against the Canvas REST API (/api/v1), signed in as the user. Paginated lists are merged, up to 10 pages. Null, false and empty fields are dropped (a missing flag means false) and HTML is returned as text with links kept.
Useful paths: users/self/todo, users/self/upcoming_events, planner/items (params {start_date:"YYYY-MM-DD"}, or it returns the whole term), courses (params {enrollment_state:"active"}),
courses/:id/assignments (params {bucket:"upcoming"|"past"|"overdue", "include[]":"submission"}), courses/:id/modules (params {"include[]":"items"}),
courses/:id/pages/:page_url, courses/:id/files, courses/:id/discussion_topics, announcements (params {"context_codes[]":"course_:id"}),
courses/:id/assignments/:aid/submissions/self, courses/:id/enrollments (params {user_id:"self"}) for grades,
courses/:id (params {"include[]":"syllabus_body"}) for the syllabus page. Many courses hide courses/:id/files (403);
find files through modules or pages instead and read them with canvas_read_file.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Endpoint path after /api/v1/, e.g. "courses/123/assignments"' },
          params: { type: 'object', description: 'Query params; array values repeat the key (use "include[]" style keys)' },
        },
        required: ['path'],
      },
      async run({ path, params }: { path: string; params?: Params }) {
        return [text(JSON.stringify(compact(await canvas.get(String(path), params))))];
      },
    },
    {
      name: 'canvas_read_file',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: `Read a Canvas file: PDFs and images come back as the file itself, text and code files as text, Jupyter notebooks as their cells and text outputs.
Some clients save a PDF to a file and give you its path instead; read that file (PDFs over 10 pages need a page range).
Word and PowerPoint files can't be read; you get their Canvas link instead. Works for files linked from modules, pages and assignments even when a course hides its Files tab.`,
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File id, or a path/URL containing files/:id, e.g. "courses/123/files/456" or a module item\'s url' },
        },
        required: ['file'],
      },
      async run({ file }: { file: string }) {
        return fileContent(await canvas.download(String(file)));
      },
    },
  ];
}
