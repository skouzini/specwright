// Turn a block body into a VS Code snippet, filling values from the file.
//
//   <name>          tab stop, "name" as default text
//   <a|b|c>         tab stop with choices
//   <source>        bound variable: list → repeat (line start) or dropdown
//                   (inline); value → literal
//   [[<var>, ...]]  bound list as a flow list [a, b]

export interface Vars {
  lists: Record<string, string[]>;
  values: Record<string, string>;
}

type Seg = { text: string } | { stop: string } | { choice: string[] };

const PH = /<([^<>\n]+)>/g;

export function yamlScalar(v: string): string {
  if (v === '' || /^\s|\s$/.test(v) || /: |\s#|[\[\]{},]/.test(v) || /^[&*!|>'"%@`?#\-]/.test(v) ||
      /^(true|false|null|yes|no|on|off|~)$/i.test(v) || /^[-+]?(\d|\.\d)/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

const indentOf = (l: string) => (l.trim() ? l.search(/\S/) : Infinity);

/** Expand lines that start with a bound list variable, once per value. */
function expandRepeats(lines: string[], vars: Vars): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*(?:-\s+)?)<(\w+)>/);
    const list = m ? vars.lists[m[2]] : undefined;
    if (!m || !list || !list.length) { out.push(lines[i]); i++; continue; }
    const base = indentOf(lines[i]);
    let end = i + 1;
    while (end < lines.length && indentOf(lines[end]) > base) end++;
    const block = lines.slice(i, end);
    list.forEach((value, n) => {
      block.forEach((l, j) => {
        let line = j === 0 ? l.replace(`<${m[2]}>`, yamlScalar(value)) : l;
        // Give unbound placeholders in each copy their own tab stop.
        line = line.replace(PH, (all, name: string) =>
          isBound(name, vars) || name.includes('|') ? all : `<${name}\u0000${n}>`);
        out.push(line);
      });
    });
    i = end;
  }
  return out;
}

function isBound(name: string, vars: Vars): boolean {
  return (vars.lists[name]?.length ?? 0) > 0 || vars.values[name] != null;
}

function segments(line: string, vars: Vars): Seg[] {
  // Flow lists first.
  line = line.replace(/\[\[\s*<(\w+)>\s*,\s*\.\.\.\s*\]\]/g, (all, name: string) => {
    const list = vars.lists[name];
    return list && list.length ? `[${list.map(yamlScalar).join(', ')}]` : `[<${name}>]`;
  });
  const segs: Seg[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  PH.lastIndex = 0;
  while ((m = PH.exec(line))) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index) });
    const raw = m[1];
    const name = raw.split('\u0000')[0];
    if (name.includes('|')) {
      segs.push({ choice: name.split('|') });
    } else if (vars.values[name] != null) {
      segs.push({ text: yamlScalar(vars.values[name]) });
    } else if ((vars.lists[name]?.length ?? 0) > 0) {
      const list = vars.lists[name];
      segs.push(list.length === 1 ? { text: yamlScalar(list[0]) } : { choice: list.map(yamlScalar) });
    } else {
      segs.push({ stop: name });
    }
    last = PH.lastIndex;
  }
  if (last < line.length) segs.push({ text: line.slice(last) });
  return segs;
}

const escText = (s: string) => s.replace(/[\\$}]/g, (c) => '\\' + c);
const escDefault = (s: string) => s.replace(/[\\$}]/g, (c) => '\\' + c);
const escChoice = (s: string) => s.replace(/[\\,|$}]/g, (c) => '\\' + c);

export interface Rendered { snippet: string; preview: string; }

export function render(body: string, vars: Vars): Rendered {
  const lines = expandRepeats(body.replace(/\n+$/, '').split('\n'), vars);
  let n = 0;
  const snip: string[] = [];
  const prev: string[] = [];
  for (const line of lines) {
    let s = '';
    let p = '';
    for (const seg of segments(line, vars)) {
      if ('text' in seg) { s += escText(seg.text); p += seg.text; }
      else if ('stop' in seg) { s += `\${${++n}:${escDefault(seg.stop)}}`; p += `<${seg.stop}>`; }
      else { s += `\${${++n}|${seg.choice.map(escChoice).join(',')}|}`; p += seg.choice[0]; }
    }
    snip.push(s);
    prev.push(p);
  }
  return { snippet: snip.join('\n'), preview: prev.join('\n') };
}

/** Indent every line after the first. */
export function indentRest(text: string, by: number): string {
  const pad = ' '.repeat(by);
  return text.split('\n').map((l, i) => (i === 0 || !l ? l : pad + l)).join('\n');
}
