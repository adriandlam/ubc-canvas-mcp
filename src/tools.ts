import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { createCanvas, Params } from './canvas';
import { compact, fileContent, text } from './format';
import type { Tool } from './mcp';

export function canvasTools(canvas: ReturnType<typeof createCanvas>, filesDir: string): Tool[] {
  return [
    {
      name: 'canvas_get',
      description: `Read-only GET against the Canvas REST API (/api/v1), signed in as the user. Paginated lists are merged, up to 10 pages. Null and empty fields are dropped and HTML is returned as text with links kept.
Useful paths: users/self/todo, users/self/upcoming_events, planner/items, courses (params {enrollment_state:"active"}),
courses/:id/assignments (params {bucket:"upcoming"|"past"|"overdue", "include[]":"submission"}), courses/:id/modules (params {"include[]":"items"}),
courses/:id/pages/:page_url, courses/:id/files, courses/:id/discussion_topics, announcements (params {"context_codes[]":"course_:id"}),
courses/:id/assignments/:aid/submissions/self, courses/:id/enrollments (params {user_id:"self"}) for grades,
courses/:id (params {"include[]":"syllabus_body"}) for the syllabus page. Many courses hide courses/:id/files (403);
find files through modules or pages instead and read them with canvas_download.`,
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
      name: 'canvas_download',
      description: `Download a Canvas file and return it: PDFs and images as the file itself, text files as text.
If your client hands you a saved file path instead of the PDF, open that path to read it. Other types (Word, PowerPoint) are saved locally and the path is returned. Works for files linked from modules, pages and assignments even when a course hides its Files tab.`,
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File id, or a path/URL containing files/:id, e.g. "courses/123/files/456" or a module item\'s url' },
        },
        required: ['file'],
      },
      async run({ file }: { file: string }) {
        const f = await canvas.download(String(file));
        mkdirSync(filesDir, { recursive: true, mode: 0o700 });
        const path = join(filesDir, `${f.id}-${f.name.replace(/[^\w.\- ]+/g, '_')}`);
        writeFileSync(path, f.bytes, { mode: 0o600 });
        return fileContent(f, path);
      },
    },
  ];
}
