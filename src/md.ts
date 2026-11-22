// Small safe Markdown for notes: parsed to a tree (never HTML), so note text can never inject markup.
export type Inl = { t: 'text' | 'b' | 'i' | 'code' | 'link'; v: string };
export type Block =
  | { t: 'h'; n: number; inl: Inl[] } | { t: 'p'; inl: Inl[] } | { t: 'quote'; inl: Inl[] } | { t: 'code'; text: string } | { t: 'hr' }
  | { t: 'ul' | 'ol'; items: { inl: Inl[]; check?: boolean; line: number }[] };

export function inline(s: string): Inl[] {
  const out: Inl[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_|https?:\/\/[^\s<>)\]]+)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    const x = m[0];
    if (x[0] === '`') out.push({ t: 'code', v: x.slice(1, -1) });
    else if (x.startsWith('**') || x.startsWith('__')) out.push({ t: 'b', v: x.slice(2, -2) });
    else if (x[0] === '*' || x[0] === '_') out.push({ t: 'i', v: x.slice(1, -1) });
    else out.push({ t: 'link', v: x });
    last = m.index + x.length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

export function parse(src: string): Block[] {
  const lines = src.replace(/\r/g, '').split('\n'), out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) { const buf: string[] = []; i++; while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]); i++; out.push({ t: 'code', text: buf.join('\n') }); continue; }
    const hm = /^(#{1,3})\s+(.*)$/.exec(l);
    if (hm) { out.push({ t: 'h', n: hm[1].length, inl: inline(hm[2]) }); i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(l)) { out.push({ t: 'hr' }); i++; continue; }
    if (l.startsWith('>')) { out.push({ t: 'quote', inl: inline(l.replace(/^>\s?/, '')) }); i++; continue; }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
    if (li.test(l)) {
      const ordered = !!li.exec(l)![2], items: { inl: Inl[]; check?: boolean; line: number }[] = [];
      while (i < lines.length && li.test(lines[i])) {
        const body = li.exec(lines[i])![3], cm = /^\[( |x|X)\]\s+(.*)$/.exec(body);
        items.push(cm ? { inl: inline(cm[2]), check: cm[1] !== ' ', line: i } : { inl: inline(body), line: i });
        i++;
      }
      out.push({ t: ordered ? 'ol' : 'ul', items }); continue;
    }
    const buf = [l]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push({ t: 'p', inl: inline(buf.join('\n')) });
  }
  return out;
}

/** Flips the checkbox on one line (for clickable checklists) and returns the new text. */
export function toggleLine(src: string, line: number): string {
  const lines = src.split('\n');
  lines[line] = lines[line].replace(/\[( |x|X)\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]'));
  return lines.join('\n');
}
