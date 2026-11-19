import type { CanvasFile } from './canvas';
import type { Content } from './mcp';

const MAX_CHARS = 150_000;

export function text(s: string): Content {
  return { type: 'text', text: s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n[truncated at ${MAX_CHARS} characters]` : s };
}

// Canvas JSON is mostly nulls, false flags, empty lists, opaque tokens and HTML bodies. Drop the first four and
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
const isEmpty = (v: unknown) => v == null || v === false || v === '' || (typeof v === 'object' && Object.keys(v).length === 0);

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

// PDFs and images go to the model as themselves; it reads both. The server never writes them to disk.
export function fileContent(f: CanvasFile): Content[] {
  const header = text(`${f.name} (${f.type}, ${f.bytes.length} bytes)`);
  const base64 = () => Buffer.from(f.bytes).toString('base64');
  if (f.type === 'application/pdf')
    return [header, { type: 'resource', resource: { uri: f.url, mimeType: f.type, blob: base64() } }];
  if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return [header, { type: 'image', data: base64(), mimeType: f.type }];
  const s = utf8(f.bytes);
  if (s !== undefined && /\.ipynb$/i.test(f.name)) return [header, text(notebook(s) ?? s)];
  // Canvas often labels code and notebooks application/octet-stream, so text is sniffed, not trusted to the type.
  if (s !== undefined || /^text\/|^application\/(json|xml)$|\+(json|xml)$/.test(f.type)) return [header, text(s ?? new TextDecoder().decode(f.bytes))];
  return [header, text(`This type can't be passed to the model. The user can open it in Canvas: ${f.url}`)];
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return s.includes('\0') ? undefined : s;
  } catch {
    return undefined;
  }
}

type Output = { text?: string | string[]; data?: Record<string, string | string[]>; ename?: string; evalue?: string };
type Cell = { cell_type: string; source: string | string[]; outputs?: Output[] };
const join = (s: string | string[] = '') => (Array.isArray(s) ? s.join('') : s);

// Cells and their text outputs; image outputs are base64 and would eat the character budget.
function notebook(s: string): string | undefined {
  try {
    const cells: Cell[] = JSON.parse(s).cells;
    return cells
      .map((c) => {
        const src = join(c.source);
        if (c.cell_type !== 'code') return src;
        const out = (c.outputs ?? [])
          .map(
            (o) =>
              join(o.text ?? o.data?.['text/plain']) ||
              (o.ename ? `${o.ename}: ${o.evalue}` : '') ||
              (o.data && Object.keys(o.data).some((k) => k.startsWith('image/')) ? '[image output]' : ''),
          )
          .filter(Boolean)
          .join('\n');
        return '```python\n' + src + '\n```' + (out ? `\nOutput:\n${out}` : '');
      })
      .join('\n\n');
  } catch {
    return undefined;
  }
}
