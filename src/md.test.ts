import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inline, parse, toggleLine } from './md.ts';

test('inline formatting and links, never HTML', () => {
  assert.deepEqual(inline('a **b** _c_ `d` https://x.io/p?q=1 <b>no</b>').map(x => x.t), ['text', 'b', 'text', 'i', 'text', 'code', 'text', 'link', 'text']);
  assert.equal(inline('<script>alert(1)</script>')[0].v, '<script>alert(1)</script>'); // text stays text
  assert.deepEqual(inline('2 * 3 * 4'), [{ t: 'text', v: '2 * 3 * 4' }]);
});

test('blocks: headings, lists, checklists, code, quote, rule, paragraphs', () => {
  const b = parse('# Title\n\nsome text\nsame para\n\n- [ ] milk\n- [x] eggs\n- plain\n\n1. one\n2. two\n\n```\ncode here\n```\n> quote\n---');
  assert.deepEqual(b.map(x => x.t), ['h', 'p', 'ul', 'ol', 'code', 'quote', 'hr']);
  const ul = b[2] as Extract<typeof b[number], { t: 'ul' }>;
  assert.deepEqual(ul.items.map(i => i.check), [false, true, undefined]);
  assert.equal((b[1] as any).inl[0].v, 'some text\nsame para');
  assert.equal((b[4] as any).text, 'code here');
});

test('toggling a checklist line', () => {
  const t = 'x\n- [ ] a\n- [x] b';
  assert.equal(toggleLine(t, 1), 'x\n- [x] a\n- [x] b');
  assert.equal(toggleLine(toggleLine(t, 2), 2), t);
});
