import type { CanvasFile } from './canvas';
import type { Content } from './mcp';

const MAX_CHARS = 150_000;

export function text(s: string): Content {
  return { type: 'text', text: s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n[truncated at ${MAX_CHARS} characters]` : s };
}

// Canvas JSON is mostly nulls, empty lists, opaque tokens and HTML bodies. Drop the first three and
// turn HTML into plain text that keeps link targets, so the model can follow files/:id links into
// canvas_read_file.
export function compact(v: unknown): unknown {
  if (typeof v === 'string') return /^\s*<[a-z!][\s\S]*>\s*$/i.test(v) ? htmlToText(v) : v;
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .map(([k, x]) => [k, compact(x)])
        .filter(([k, x]) => !OPAQUE.has(k as string) && !isEmpty(x)),
    );
  return v;
}

const OPAQUE = new Set(['secure_params', 'lti_context_id', 'uuid', 'context_image']);
const isEmpty = (v: unknown) => v == null || v === '' || (typeof v === 'object' && Object.keys(v).length === 0);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// ponytail: regex, not a parser; fine for Canvas's editor output, breaks on ">" inside attributes.
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*?\balt="([^"]*)"[^>]*>/gi, ' $1 ')
    .replace(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/ul|\/ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(Number(e[1] === 'x' || e[1] === 'X' ? `0${e.slice(1)}` : e.slice(1))) : (ENTITIES[e] ?? m),
    )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n+/g, '\n')
    .trim();
}

// PDFs and images go to the model as themselves; it reads both. Nothing is written to disk.
export function fileContent(f: CanvasFile): Content[] {
  const header = text(`${f.name} (${f.type}, ${f.bytes.length} bytes)`);
  const base64 = () => Buffer.from(f.bytes).toString('base64');
  if (f.type === 'application/pdf')
    return [header, { type: 'resource', resource: { uri: f.url, mimeType: f.type, blob: base64() } }];
  if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return [header, { type: 'image', data: base64(), mimeType: f.type }];
  if (/^text\/|^application\/(json|xml)$|\+(json|xml)$/.test(f.type))
    return [header, text(new TextDecoder().decode(f.bytes))];
  return [header, text(`This type can't be passed to the model. The user can open it in Canvas: ${f.url}`)];
}
