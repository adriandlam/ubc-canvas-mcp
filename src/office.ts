import { inflateRawSync } from 'node:zlib';
import { decodeEntities } from './entities';

/**
 * The text of a Word, PowerPoint or Excel file, or `undefined` if it isn't one or can't be read.
 *
 * These formats are zip files full of XML, so no Office library is needed: unzip, then strip the tags.
 */
export function officeText(name: string, type: string, bytes: Uint8Array): string | undefined {
  const kind = officeKind(name, type);
  if (!kind) return undefined;
  try {
    const zip = unzip(bytes);
    if (kind === 'docx') return docx(zip);
    if (kind === 'pptx') return pptx(zip);
    return xlsx(zip);
  } catch {
    return undefined;
  }
}

type Kind = 'docx' | 'pptx' | 'xlsx';

function officeKind(name: string, type: string): Kind | undefined {
  const ext = name.match(/\.(docx|pptx|xlsx)$/i)?.[1]?.toLowerCase();
  if (ext) return ext as Kind;
  if (type.includes('wordprocessingml')) return 'docx';
  if (type.includes('presentationml')) return 'pptx';
  if (type.includes('spreadsheetml')) return 'xlsx';
  return undefined;
}

type Zip = { paths: string[]; read: (path: string) => string | undefined };

/**
 * Reads a zip's central directory. Handles the two compression methods Office uses: stored (0) and deflate (8).
 *
 * ponytail: no zip64, so files over 4 GB fail; Office files never get near that.
 */
function unzip(bytes: Uint8Array): Zip {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // The end-of-central-directory record sits in the last 22 bytes, plus up to 64 KB of trailing comment.
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip');

  const entryCount = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = new Map<string, { method: number; size: number; headerOffset: number }>();

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('bad central directory');
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(path, {
      method: view.getUint16(offset + 10, true),
      size: view.getUint32(offset + 20, true),
      headerOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  function read(path: string): string | undefined {
    const entry = entries.get(path);
    if (!entry) return undefined;
    // The local header repeats the name and has its own extra field, so its length is read from there.
    const local = entry.headerOffset;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + entry.size);
    if (entry.method === 0) return decoder.decode(data);
    if (entry.method === 8) return decoder.decode(inflateRawSync(data));
    throw new Error(`unsupported compression method ${entry.method}`);
  }

  return { paths: [...entries.keys()], read };
}

function stripXml(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]*>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Word: the body is one XML file; `w:p` is a paragraph, `w:tab` and `w:br` are tabs and line breaks. */
function docx(zip: Zip): string | undefined {
  const xml = zip.read('word/document.xml');
  if (xml === undefined) return undefined;
  return stripXml(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n'),
  );
}

/**
 * PowerPoint: one XML file per slide, numbered in order. Each slide gets a "Slide N" heading.
 *
 * ponytail: speaker notes (ppt/notesSlides) are skipped; add them if lecture notes turn out to live there.
 */
function pptx(zip: Zip): string | undefined {
  const slides = zip.paths
    .map((path) => ({ path, number: Number(path.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]) }))
    .filter((slide) => slide.number > 0)
    .sort((a, b) => a.number - b.number);
  if (slides.length === 0) return undefined;

  return slides
    .map(({ path, number }) => {
      // Slide text only appears inside text runs; every other tag is layout and strips to nothing.
      const xml = zip.read(path) ?? '';
      return `--- Slide ${number} ---\n${stripXml(xml.replace(/<\/a:p>/g, '\n'))}`;
    })
    .join('\n\n');
}

/**
 * Excel: every sheet as tab-separated rows, under its sheet name. Shows the values Excel last saved, not formulas.
 *
 * ponytail: rows are joined in file order and empty cells are dropped, so columns can shift left in sparse sheets.
 * Use each cell's `r` reference to place it if that matters.
 */
function xlsx(zip: Zip): string | undefined {
  // Text cells don't hold their text; they hold an index into this shared list.
  const sharedStrings = [...(zip.read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => stripXml(m[1]!));

  // workbook.xml names the sheets; its rels file says which XML file each one lives in.
  const rels = new Map(
    [...(zip.read('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      attribute(m[0], 'Id'),
      attribute(m[0], 'Target'),
    ]),
  );
  const sheets = [...(zip.read('xl/workbook.xml') ?? '').matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const target = rels.get(attribute(m[0], 'r:id')) ?? '';
    return { name: stripXml(attribute(m[0], 'name')), path: target.startsWith('/') ? target.slice(1) : `xl/${target}` };
  });
  if (sheets.length === 0) return undefined;

  return sheets
    .map(({ name, path }) => {
      const rows = [...(zip.read(path) ?? '').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
        [...row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map(([, attrs, body = '']) => cellValue(attribute(attrs!, 't'), body, sharedStrings))
          .filter(Boolean)
          .join('\t'),
      );
      return `--- Sheet: ${name} ---\n${rows.filter(Boolean).join('\n')}`;
    })
    .join('\n\n');
}

/** A cell's display value, given its type attribute (`t`) and inner XML. */
function cellValue(type: string, body: string, sharedStrings: string[]): string {
  if (type === 's') return sharedStrings[Number(body.match(/<v>(.*?)<\/v>/)?.[1])] ?? '';
  if (type === 'inlineStr') return stripXml(body);
  return stripXml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
}

function attribute(tag: string, name: string): string {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? '';
}
