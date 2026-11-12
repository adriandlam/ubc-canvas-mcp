import { expect, test } from 'bun:test';
import { compact, fileContent } from '../src/format';

test('drops empty fields but keeps false and 0', () => {
  expect(compact({ a: null, b: '', c: [], d: {}, e: false, f: 0, g: [{ h: null, i: 1 }] })).toEqual({ e: false, f: 0, g: [{ i: 1 }] });
});

test('turns HTML into text that keeps links, equation alt text and entities', () => {
  const html =
    '<p>Read the <a href="https://canvas.ubc.ca/courses/1/files/2?wrap=1" data-api-returntype="File">outline</a>&nbsp;&amp; solve ' +
    '<img class="equation_image" alt="LaTeX: x^2 &lt; 1">.</p><ul><li>one</li><li>two&#x21;</li></ul>';
  expect(compact({ description: html })).toEqual({
    description: 'Read the outline (https://canvas.ubc.ca/courses/1/files/2?wrap=1) & solve LaTeX: x^2 < 1 .\n- one\n- two!',
  });
});

test('leaves text that merely contains angle brackets alone', () => {
  expect(compact({ title: 'a<b and c>d' })).toEqual({ title: 'a<b and c>d' });
});

test('sends only what the model can read as content', () => {
  const file = (type: string) => fileContent({ url: 'https://canvas.example/files/1', name: 'f', type, bytes: new TextEncoder().encode('PK\u0003\u0004 data') });
  expect(file('application/pdf')[1]).toMatchObject({ type: 'resource', resource: { mimeType: 'application/pdf' } });
  expect(file('image/png')[1]).toMatchObject({ type: 'image' });
  expect(file('image/svg+xml')[1]).toMatchObject({ type: 'text', text: 'PK\u0003\u0004 data' });
  expect(file('application/vnd.openxmlformats-officedocument.wordprocessingml.document')[1]).toMatchObject({ text: expect.stringContaining('https://canvas.example/files/1') });
});
