import { expect, test } from 'bun:test';
import { compact, json } from '../src/canvas-get';

test('drops empty and false fields but keeps 0', () => {
  expect(compact({ a: null, b: '', c: [], d: {}, e: false, f: 0, g: [{ h: null, i: 1 }] })).toEqual({ f: 0, g: [{ i: 1 }] });
});

test('turns HTML into text that keeps links, equation alt text, file images and entities', () => {
  const html =
    '<p>Read\u00a0the <a href="https://canvas.ubc.ca/courses/1/files/2?wrap=1" data-api-returntype="File">outline</a>&nbsp;&amp; solve ' +
    '<img class="equation_image" src="/equation_images/x%255E2" alt="LaTeX: x^2 &lt; 1">.</p><ul><li>one</li><li>two&#x21;</li></ul>' +
    '<p><img src="https://canvas.ubc.ca/courses/1/files/3/preview" alt="Fig 1.jpg"><img src="/users/4/profiles/5" alt="me"></p>';
  expect(compact({ description: html })).toEqual({
    description:
      'Read the outline (https://canvas.ubc.ca/courses/1/files/2?wrap=1) & solve LaTeX: x^2 < 1 .\n- one\n- two!\nFig 1.jpg (https://canvas.ubc.ca/courses/1/files/3/preview) me',
  });
});

test('leaves text that merely contains angle brackets alone', () => {
  expect(compact({ title: 'a<b and c>d' })).toEqual({ title: 'a<b and c>d' });
});

test('puts one list item per line so a saved result can be grepped', () => {
  expect(json([{ a: 1 }, { b: 'x\ny' }])).toBe('[{"a":1},\n{"b":"x\\ny"}]');
  expect(JSON.parse(json([{ a: 1 }, 2]))).toEqual([{ a: 1 }, 2]);
});
