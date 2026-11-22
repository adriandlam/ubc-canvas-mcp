import type { Canvas, CanvasFile } from './canvas';
import { type Content, text, type Tool } from './mcp';
import { officeText } from './office';

export function canvasReadFile(canvas: Canvas): Tool {
  return {
    name: 'canvas_read_file',
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: `Read a Canvas file: PDFs and images come back as the file itself, text and code files as text, Jupyter notebooks as their cells and text outputs,
Word, PowerPoint and Excel files (.docx, .pptx, .xlsx) as their text (slide by slide, sheet by sheet; no images or speaker notes).
Some clients save a PDF to a file and give you its path instead; read that file (PDFs over 10 pages need a page range).
Older .doc/.ppt/.xls files can't be read; you get their Canvas link instead. Works for files linked from modules, pages and assignments even when a course hides its Files tab.`,
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
  };
}

/** Turns a downloaded file into content the model can read, or a link to it in Canvas. Nothing is written to disk. */
export function fileContent(f: CanvasFile): Content[] {
  const header = text(`${f.name} (${f.type}, ${f.bytes.length} bytes)`);
  const base64 = () => Buffer.from(f.bytes).toString('base64');

  if (f.type === 'application/pdf') return [header, { type: 'resource', resource: { uri: f.url, mimeType: f.type, blob: base64() } }];
  if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return [header, { type: 'image', data: base64(), mimeType: f.type }];

  const link = (why: string) => [header, text(`${why} The user can open it in Canvas: ${f.url}`)];
  try {
    const office = officeText(f.name, f.type, f.bytes);
    if (office !== undefined) return [header, text(office)];
  } catch {
    return link("This Office file couldn't be read; it may be damaged or in an older format.");
  }

  const s = asText(f);
  if (s === undefined) return link("This type can't be passed to the model.");
  return [header, text(/\.ipynb$/i.test(f.name) ? (notebook(s) ?? s) : s)];
}

/**
 * The file as text, or `undefined` if it's binary.
 *
 * Canvas labels code and notebooks application/octet-stream, so valid UTF-8 counts as text whatever the type says.
 * A text type is trusted even when the bytes aren't UTF-8 (Latin-1 CSVs from Excel).
 */
function asText(f: CanvasFile): string | undefined {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(f.bytes);
    if (!s.includes('\0')) return s;
  } catch {}
  if (/^text\/|^application\/(json|xml)$|\+(json|xml)$/.test(f.type)) return new TextDecoder().decode(f.bytes);
  return undefined;
}

/** The parts of a Jupyter notebook this file reads. */
type Output = { text?: string | string[]; data?: Record<string, string | string[]>; ename?: string; evalue?: string };
type Cell = { cell_type: string; source: string | string[]; outputs?: Output[] };
type Notebook = { cells: Cell[]; metadata?: { language_info?: { name?: string }; kernelspec?: { language?: string } } };

/** Notebooks store multi-line strings either as one string or as a list of lines. */
const join = (s: string | string[] = '') => (Array.isArray(s) ? s.join('') : s);

/**
 * Renders a notebook as its cells and their text outputs, or `undefined` if it isn't valid notebook JSON.
 *
 * Image outputs become `[image output]`: they're base64 and would eat the character budget.
 */
function notebook(s: string): string | undefined {
  try {
    const nb: Notebook = JSON.parse(s);
    const language = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? '';
    return nb.cells.map((cell) => cellToText(cell, language)).join('\n\n');
  } catch {
    return undefined;
  }
}

function cellToText(cell: Cell, language: string): string {
  const source = join(cell.source);
  if (cell.cell_type !== 'code') return source;
  const output = (cell.outputs ?? []).map(outputToText).filter(Boolean).join('\n');
  return '```' + language + '\n' + source + '\n```' + (output ? `\nOutput:\n${output}` : '');
}

function outputToText(o: Output): string {
  const printed = join(o.text ?? o.data?.['text/plain']);
  if (printed) return printed;
  if (o.ename) return `${o.ename}: ${o.evalue}`;
  if (o.data && Object.keys(o.data).some((key) => key.startsWith('image/'))) return '[image output]';
  return '';
}
