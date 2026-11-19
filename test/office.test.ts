import { expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { fileContent } from '../src/format';
import { officeText } from '../src/office';

/** Builds a minimal zip: even-numbered entries stored, odd ones deflated, so both read paths run. */
function zip(files: Record<string, string>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([path, content], i) => {
    const name = Buffer.from(path);
    const method = i % 2 ? 8 : 0;
    const data = method ? deflateRawSync(content) : Buffer.from(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(entry, name);
    offset += 30 + name.length + data.length;
  });
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

test('reads Word paragraphs, tabs and entities', () => {
  const doc = zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Due</w:t></w:r><w:r><w:tab/><w:t>Friday &amp; late</w:t></w:r></w:p><w:p><w:r><w:t>Line &#x32;</w:t></w:r></w:p></w:body></w:document>',
  });
  expect(officeText('a.docx', 'application/octet-stream', doc)).toBe('Due\tFriday & late\nLine 2');
});

test('reads PowerPoint slides in numeric order', () => {
  const slide = (s: string) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${s}</a:t></a:r></a:p><a:p><a:r><a:t>more</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const deck = zip({ 'ppt/slides/slide10.xml': slide('ten'), 'ppt/slides/slide2.xml': slide('two'), 'ppt/slides/_rels/slide2.xml.rels': '<x/>' });
  expect(officeText('lecture.pptx', '', deck)).toBe('--- Slide 2 ---\ntwo\nmore\n\n--- Slide 10 ---\nten\nmore');
});

test('reads Excel sheets by name with shared, inline and number cells', () => {
  const book = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Grades &amp; marks" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><r><t>Sco</t></r><r><t>re</t></r></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Ada</t></is></c><c r="B2"><f>SUM(1,2)</f><v>3</v></c><c r="C2"/></row></sheetData></worksheet>',
  });
  expect(officeText('marks.xlsx', '', book)).toBe('--- Sheet: Grades & marks ---\nName\tScore\nAda\t3');
});

test('detects Office files by MIME type and falls back to the link when the zip is broken', () => {
  const doc = zip({ 'word/document.xml': '<w:p><w:t>hi</w:t></w:p>' });
  const word = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  expect(fileContent({ url: 'u', name: 'download', type: word, bytes: doc })[1]).toMatchObject({ text: 'hi' });
  expect(fileContent({ url: 'https://canvas.example/files/1', name: 'x.docx', type: word, bytes: doc.slice(0, 20) })[1]).toMatchObject({
    text: expect.stringContaining('https://canvas.example/files/1'),
  });
  expect(officeText('notes.pdf', 'application/pdf', doc)).toBeUndefined();
});
