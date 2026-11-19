import { expect, test } from 'bun:test';
import { compact, fileContent } from '../src/format';

test('drops empty and false fields but keeps 0', () => {
  expect(compact({ a: null, b: '', c: [], d: {}, e: false, f: 0, g: [{ h: null, i: 1 }] })).toEqual({ f: 0, g: [{ i: 1 }] });
});

test('turns HTML into text that keeps links, equation alt text and entities', () => {
  const html =
    '<p>Read the <a href="https://canvas.ubc.ca/courses/1/files/2?wrap=1" data-api-returntype="File">outline</a>&nbsp;&amp; solve ' +
    '<img class="equation_image" src="/equation_images/x%255E2" alt="LaTeX: x^2 &lt; 1">.</p><ul><li>one</li><li>two&#x21;</li></ul>' +
    '<p><img src="https://canvas.ubc.ca/courses/1/files/3/preview" alt="Fig 1.jpg"></p>';
  expect(compact({ description: html })).toEqual({
    description:
      'Read the outline (https://canvas.ubc.ca/courses/1/files/2?wrap=1) & solve LaTeX: x^2 < 1 .\n- one\n- two!\nFig 1.jpg (https://canvas.ubc.ca/courses/1/files/3/preview)',
  });
});

test('leaves text that merely contains angle brackets alone', () => {
  expect(compact({ title: 'a<b and c>d' })).toEqual({ title: 'a<b and c>d' });
});

test('sends only what the model can read as content', () => {
  const file = (type: string) => fileContent({ url: 'https://canvas.example/files/1', name: 'f', type, bytes: new TextEncoder().encode('PK\u0003\u0004\u0000 data') });
  expect(file('application/pdf')[1]).toMatchObject({ type: 'resource', resource: { mimeType: 'application/pdf' } });
  expect(file('image/png')[1]).toMatchObject({ type: 'image' });
  expect(file('image/svg+xml')[1]).toMatchObject({ type: 'text', text: 'PK\u0003\u0004\u0000 data' });
  expect(file('application/vnd.openxmlformats-officedocument.wordprocessingml.document')[1]).toMatchObject({ text: expect.stringContaining('https://canvas.example/files/1') });
});

test('reads text Canvas mislabels as binary, and notebooks as cells', () => {
  const file = (name: string, s: string) => fileContent({ url: 'u', name, type: 'application/octet-stream', bytes: new TextEncoder().encode(s) });
  expect(file('lp.py', 'from scipy.optimize import linprog')[1]).toMatchObject({ text: 'from scipy.optimize import linprog' });
  const nb = {
    cells: [
      { cell_type: 'markdown', source: ['# LP'] },
      { cell_type: 'code', source: 'linprog(c)', outputs: [{ data: { 'text/plain': 'x=1', 'image/png': 'AAAA' } }, { data: { 'image/png': 'BBBB' } }] },
      { cell_type: 'code', source: '-r.fun', outputs: [{ ename: 'TypeError', evalue: 'bad operand' }] },
    ],
  };
  expect(file('L7.ipynb', JSON.stringify(nb))[1]).toMatchObject({
    text: '# LP\n\n```python\nlinprog(c)\n```\nOutput:\nx=1\n[image output]\n\n```python\n-r.fun\n```\nOutput:\nTypeError: bad operand',
  });
});
