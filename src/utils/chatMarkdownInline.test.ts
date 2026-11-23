import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeInlineMarkdown } from './chatMarkdownInline.ts';
import { isValidInlineDollarMath, renderMathToHtml } from './chatMath.ts';

test('tokenizeInlineMarkdown preserves underscores inside identifiers and escaped underscores', () => {
  const nodes = tokenizeInlineMarkdown(
    'Użytkownik jyn_mitek_root w repo SVL_Core uruchamia Jyn oraz \\_test\\_ i _kursywa_.',
  );

  const plainText = nodes
    .filter((n) => n.type === 'text')
    .map((n) => n.text)
    .join('');

  assert.match(plainText, /jyn_mitek_root/);
  assert.match(plainText, /SVL_Core/);
  assert.match(plainText, /Jyn/);
  assert.match(plainText, /_test_/);

  const italics = nodes.filter((n) => n.type === 'italic');
  assert.equal(italics.length, 1);
  assert.deepEqual(italics[0], {
    type: 'italic',
    children: [{ type: 'text', text: 'kursywa' }],
  });
});

test('tokenizeInlineMarkdown handles inline math, highlights, kbd, sup, sub, and SVL tokens', () => {
  const nodes = tokenizeInlineMarkdown(
    'Wzór $x^2 + y^2 = r^2$, \\(a_n = 2^n\\), ==ważne==, <kbd>Ctrl+K</kbd>, H<sub>2</sub>O, x<sup>3</sup>, [hl: test|cyan], [checkbox: Opcja|on|send:/ok]',
  );

  const maths = nodes.filter((n) => n.type === 'math').map((n) => n.tex);
  assert.deepEqual(maths, ['x^2 + y^2 = r^2', 'a_n = 2^n']);

  const highlights = nodes.filter((n) => n.type === 'highlight');
  assert.deepEqual(highlights, [{ type: 'highlight', text: 'ważne', tone: 'amber' }]);

  const kbds = nodes.filter((n) => n.type === 'kbd');
  assert.deepEqual(kbds, [{ type: 'kbd', keys: 'Ctrl+K' }]);

  const subs = nodes.filter((n) => n.type === 'sub');
  const sups = nodes.filter((n) => n.type === 'sup');
  assert.deepEqual(subs, [{ type: 'sub', text: '2' }]);
  assert.deepEqual(sups, [{ type: 'sup', text: '3' }]);

  const tokens = nodes.filter((n) => n.type === 'token').map((n) => n.raw);
  assert.deepEqual(tokens, ['[hl: test|cyan]', '[checkbox: Opcja|on|send:/ok]']);
});

test('inline dollar math guards against currency amounts while rendering real LaTeX with KaTeX', () => {
  assert.equal(isValidInlineDollarMath('x^2 + 1'), true);
  assert.equal(isValidInlineDollarMath('\\frac{a}{b}'), true);
  assert.equal(isValidInlineDollarMath('100 USD'), false);
  assert.equal(isValidInlineDollarMath('50 zł'), false);
  assert.equal(isValidInlineDollarMath(' 100 '), false);

  const currencyNodes = tokenizeInlineMarkdown('Ceny wynoszą $100 i $200 lub $50/$100.');
  assert.equal(currencyNodes.some((n) => n.type === 'math'), false);

  const inlineRendered = renderMathToHtml('E = mc^2', false);
  assert.equal(inlineRendered.ok, true);
  assert.match(inlineRendered.html, /class="katex"/);

  const blockRendered = renderMathToHtml('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', true);
  assert.equal(blockRendered.ok, true);
  assert.match(blockRendered.html, /katex-display/);
});
