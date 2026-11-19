import { type Canvas, filePath, MAX_PAGES, type Params } from './canvas';
import { decodeEntities } from './entities';
import { text, type Tool } from './mcp';

export function canvasGet(canvas: Canvas): Tool {
  return {
    name: 'canvas_get',
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: `Read-only GET against the Canvas REST API (/api/v1), signed in as the user. Paginated lists are merged, up to ${MAX_PAGES} pages. Null, false and empty fields are dropped (a missing flag means false) and HTML is returned as text with links kept.
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
      return [text(json(compact(await canvas.get(String(path), params))))];
    },
  };
}

/**
 * Serializes JSON with one array item per line.
 *
 * Clients that move big results to a file (Claude Code does past ~50k chars) leave the model with grep and line
 * ranges, which are useless on one long line.
 */
export function json(v: unknown): string {
  if (!Array.isArray(v)) return JSON.stringify(v);
  return `[${v.map((item) => JSON.stringify(item)).join(',\n')}]`;
}

/**
 * Shrinks a Canvas API response to what the model needs.
 *
 * Canvas JSON is mostly nulls, false flags, empty lists, opaque tokens and HTML bodies. This drops the first four
 * and turns HTML into text that keeps link targets, so the model can follow file links into `canvas_read_file`.
 */
export function compact(v: unknown): unknown {
  if (typeof v === 'string') return looksLikeHtml(v) ? htmlToText(v) : v;
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === 'object') {
    const kept = Object.entries(v)
      .map(([key, value]) => [key, compact(value)] as const)
      .filter(([key, value]) => !OPAQUE.has(key) && !isEmpty(value));
    return Object.fromEntries(kept);
  }
  return v;
}

/** Tokens and IDs for other systems; they cost characters and tell the model nothing. */
const OPAQUE = new Set(['secure_params', 'lti_context_id', 'uuid', 'context_image']);

const isEmpty = (v: unknown) => v == null || v === false || v === '' || (typeof v === 'object' && Object.keys(v).length === 0);
const looksLikeHtml = (s: string) => /^\s*<[a-z!][\s\S]*>\s*$/i.test(s);

/** ponytail: regex, not a parser; fine for Canvas's editor output, breaks on ">" inside attributes. */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, imageToText)
    .replace(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/ul|\/ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(stripped)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n+/g, '\n')
    .trim();
}

/** An image becomes its alt text, plus its URL when it's a file `canvas_read_file` can fetch. */
function imageToText(tag: string): string {
  const alt = tag.match(/\balt="([^"]*)"/i)?.[1] ?? '';
  const src = tag.match(/\bsrc="([^"]*)"/i)?.[1] ?? '';
  return filePath(src) ? ` ${alt} (${src}) ` : ` ${alt} `;
}
