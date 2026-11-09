// Where is the cursor, structurally?
//
// The cursor usually sits on a blank (or half-typed) line, which YAML can't
// place on its own. So we temporarily write a marker key on that line, parse
// the document, and look up where the marker landed. We try it as a new key
// ("key" context) and as a new list item ("item" context); whichever parses
// cleanly tells us what can go there.

import { parseDocument, isMap, isSeq, isScalar, Document, Node, YAMLMap } from 'yaml';

export const MARK = '__specwright_cursor__';

export type PathPart = string | number;

export interface CursorContext {
  kind: 'key' | 'item';
  /** key: path to the map the new key goes in. item: path to the list. */
  path: PathPart[];
  /** Plain JS view of the document (marker included). */
  data: unknown;
  /** Keys already in the map (key context only). */
  siblings: string[];
  /** Offsets in the ORIGINAL text that an insertion replaces. */
  replaceStart: number;
  replaceEnd: number;
  /** "- " if the line already had a dash, else "". */
  dash: string;
  indent: number;
}

const keyOf = (k: unknown): string =>
  isScalar(k) ? String(k.value) : String(k);

function findMarker(node: unknown, path: PathPart[]): PathPart[] | null {
  if (isMap(node)) {
    for (const pair of node.items) {
      const k = keyOf(pair.key);
      if (k === MARK) return [...path, k];
      const hit = findMarker(pair.value, [...path, k]);
      if (hit) return hit;
    }
  } else if (isSeq(node)) {
    for (let i = 0; i < node.items.length; i++) {
      const hit = findMarker(node.items[i], [...path, i]);
      if (hit) return hit;
    }
  }
  return null;
}

function nodeAt(doc: Document, path: PathPart[]): unknown {
  return path.length ? doc.getIn(path, true) : doc.contents;
}

export function contextsAt(text: string, offset: number): CursorContext[] {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  let lineEnd = text.indexOf('\n', offset);
  if (lineEnd < 0) lineEnd = text.length;
  const before = text.slice(lineStart, offset);
  const after = text.slice(offset, lineEnd);
  if (after.trim() !== '') return [];

  // Blank line, a bare dash, or a partly typed word (used to filter).
  const m = before.match(/^( *)(-(?: +|$))?([\w.\-]*)$/);
  if (!m) return [];
  const indent = m[1].length;
  const dash = m[2] ? '- ' : '';
  const pad = ' '.repeat(indent);

  const tries: Array<{ kind: 'key' | 'item'; line: string }> = [];
  if (!dash) tries.push({ kind: 'key', line: `${pad}${MARK}: 0` });
  tries.push({ kind: 'item', line: `${pad}- ${MARK}: 0` });

  const out: CursorContext[] = [];
  for (const t of tries) {
    const probe = text.slice(0, lineStart) + t.line + text.slice(lineEnd);
    const doc = parseDocument(probe);
    if (doc.errors.length) continue;
    const hit = findMarker(doc.contents, []);
    if (!hit) continue;

    if (t.kind === 'key') {
      const mapPath = hit.slice(0, -1);
      const map = nodeAt(doc, mapPath);
      if (!isMap(map)) continue;
      const siblings = (map as YAMLMap).items.map((p) => keyOf(p.key)).filter((k) => k !== MARK);
      out.push({ kind: 'key', path: mapPath, data: doc.toJS(), siblings, replaceStart: lineStart + indent, replaceEnd: lineEnd, dash, indent });
    } else {
      // The marker must be a new one-key item, not glued onto a neighbour.
      if (hit.length < 2 || typeof hit[hit.length - 2] !== 'number') continue;
      const item = nodeAt(doc, hit.slice(0, -1));
      if (!isMap(item) || (item as YAMLMap).items.length !== 1) continue;
      out.push({ kind: 'item', path: hit.slice(0, -2), data: doc.toJS(), siblings: [], replaceStart: lineStart + indent, replaceEnd: lineEnd, dash, indent });
    }
  }
  return out;
}

/** Path of the node under the cursor on a non-blank line (for the status bar). */
export function pathAt(text: string, offset: number): PathPart[] | null {
  const doc = parseDocument(text);
  if (doc.errors.length) return null;
  const out: PathPart[] = [];
  let node: unknown = doc.contents;
  const span = (n: unknown): [number, number] | null => {
    const r = (n as Node | null)?.range;
    return r ? [r[0], r[2]] : null;
  };
  for (;;) {
    let next: unknown = null;
    if (isMap(node)) {
      for (const pair of node.items) {
        const ks = span(pair.key);
        const vs = span(pair.value);
        const start = ks ? ks[0] : vs ? vs[0] : -1;
        const end = vs ? vs[1] : ks ? ks[1] : -1;
        if (start <= offset && offset <= end) { out.push(keyOf(pair.key)); next = pair.value; break; }
      }
    } else if (isSeq(node)) {
      node.items.forEach((it, i) => {
        const s = span(it);
        if (!next && s && s[0] <= offset && offset <= s[1]) { out.push(i); next = it; }
      });
    }
    if (!next) break;
    node = next;
  }
  return out;
}

export function formatPath(path: PathPart[]): string {
  let s = '';
  for (const p of path) {
    if (typeof p === 'number') s += `[${p}]`;
    else s += (s ? ' › ' : '') + p;
  }
  return s || '(root)';
}
