import type { CanvasFile } from './canvas';
import type { Content } from './mcp';
import { officeText } from './office';

/** Longest text block sent to the model; anything past this is cut with a note saying so. */
const MAX_CHARS = 150_000;

/** Wraps a string as MCP text content, truncating it at {@link MAX_CHARS}. */
export function text(s: string): Content {
  if (s.length <= MAX_CHARS) return { type: 'text', text: s };
  return { type: 'text', text: `${s.slice(0, MAX_CHARS)}\n[truncated at ${MAX_CHARS} characters]` };
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
 * and turns HTML into plain text that keeps link targets, so the model can follow `files/:id` links into
 * `canvas_read_file`.
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

/** Fields that are tokens or IDs for other systems; they cost characters and tell the model nothing. */
const OPAQUE = new Set(['secure_params', 'lti_context_id', 'uuid', 'context_image']);

const isEmpty = (v: unknown) => v == null || v === false || v === '' || (typeof v === 'object' && Object.keys(v).length === 0);
const looksLikeHtml = (s: string) => /^\s*<[a-z!][\s\S]*>\s*$/i.test(s);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Converts Canvas HTML (page bodies, descriptions, messages) to plain text, keeping link targets.
 *
 * ponytail: regex, not a parser; fine for Canvas's editor output, breaks on ">" inside attributes.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, imageToText)
    .replace(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/ul|\/ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, decodeEntity)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n+/g, '\n')
    .trim();
}

/** An image becomes its alt text, plus its URL when it's a Canvas file `canvas_read_file` can fetch. */
function imageToText(tag: string): string {
  const alt = tag.match(/\balt="([^"]*)"/i)?.[1] ?? '';
  const src = tag.match(/\bsrc="([^"]*)"/i)?.[1] ?? '';
  return /\/files\/\d+/.test(src) ? ` ${alt} (${src}) ` : ` ${alt} `;
}

/** Replacer for `&name;`, `&#123;` and `&#x1F;` entities; unknown names are left as written. */
export function decodeEntity(match: string, entity: string): string {
  if (entity[0] !== '#') return ENTITIES[entity] ?? match;
  const isHex = entity[1] === 'x' || entity[1] === 'X';
  return String.fromCodePoint(isHex ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
}

/**
 * Turns a downloaded Canvas file into MCP content the model can read.
 *
 * - PDFs and images go to the model as themselves; it reads both.
 * - Word, PowerPoint and Excel files become their text.
 * - Notebooks become their cells and text outputs.
 * - Anything that decodes as text is sent as text.
 * - Everything else gets a link the user can open in Canvas.
 *
 * Nothing is written to disk.
 */
export function fileContent(f: CanvasFile): Content[] {
  const header = text(`${f.name} (${f.type}, ${f.bytes.length} bytes)`);
  const base64 = () => Buffer.from(f.bytes).toString('base64');

  if (f.type === 'application/pdf') return [header, { type: 'resource', resource: { uri: f.url, mimeType: f.type, blob: base64() } }];
  if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return [header, { type: 'image', data: base64(), mimeType: f.type }];

  const office = officeText(f.name, f.type, f.bytes);
  if (office !== undefined) return [header, text(office)];

  const s = utf8(f.bytes);
  if (s !== undefined && /\.ipynb$/i.test(f.name)) return [header, text(notebook(s) ?? s)];

  // Canvas often labels code and notebooks application/octet-stream, so text is sniffed, not trusted to the type.
  if (s !== undefined) return [header, text(s)];
  if (/^text\/|^application\/(json|xml)$|\+(json|xml)$/.test(f.type)) return [header, text(new TextDecoder().decode(f.bytes))];

  return [header, text(`This type can't be passed to the model. The user can open it in Canvas: ${f.url}`)];
}

/** Decodes bytes as UTF-8, or returns `undefined` if they're binary (invalid UTF-8 or containing NUL). */
function utf8(bytes: Uint8Array): string | undefined {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return s.includes('\0') ? undefined : s;
  } catch {
    return undefined;
  }
}

/** The parts of a Jupyter notebook this file reads. */
type Output = { text?: string | string[]; data?: Record<string, string | string[]>; ename?: string; evalue?: string };
type Cell = { cell_type: string; source: string | string[]; outputs?: Output[] };

/** Notebooks store multi-line strings either as one string or as a list of lines. */
const join = (s: string | string[] = '') => (Array.isArray(s) ? s.join('') : s);

/**
 * Renders a notebook as its cells and their text outputs, or `undefined` if it isn't valid notebook JSON.
 *
 * Image outputs become `[image output]`: they're base64 and would eat the character budget.
 */
function notebook(s: string): string | undefined {
  try {
    const cells: Cell[] = JSON.parse(s).cells;
    return cells.map(cellToText).join('\n\n');
  } catch {
    return undefined;
  }
}

function cellToText(cell: Cell): string {
  const source = join(cell.source);
  if (cell.cell_type !== 'code') return source;
  const output = (cell.outputs ?? []).map(outputToText).filter(Boolean).join('\n');
  return '```python\n' + source + '\n```' + (output ? `\nOutput:\n${output}` : '');
}

function outputToText(o: Output): string {
  const printed = join(o.text ?? o.data?.['text/plain']);
  if (printed) return printed;
  if (o.ename) return `${o.ename}: ${o.evalue}`;
  if (o.data && Object.keys(o.data).some((key) => key.startsWith('image/'))) return '[image output]';
  return '';
}
