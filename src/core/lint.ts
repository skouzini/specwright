// Cross-reference rules JSON Schema can't express.
//   SW001  a column's definitions must list every source in the model
//   SW002  definitions names a source that isn't in the model
//   SW003  completes must name another source in the model

import { parseDocument, isMap, isSeq, isScalar, Node, YAMLMap } from 'yaml';

export interface Finding {
  code: string;
  message: string;
  start: number;
  end: number;
}

const keyOf = (k: unknown) => (isScalar(k) ? String(k.value) : String(k));

function get(map: unknown, key: string): { keyNode: Node | null; value: unknown } | null {
  if (!isMap(map)) return null;
  for (const p of (map as YAMLMap).items) {
    if (keyOf(p.key) === key) return { keyNode: p.key as Node, value: p.value };
  }
  return null;
}

const range = (n: unknown): [number, number] => {
  const r = (n as Node | null)?.range;
  return r ? [r[0], r[1]] : [0, 0];
};

export function lint(text: string): Finding[] {
  const doc = parseDocument(text);
  if (doc.errors.length) return [];
  const out: Finding[] = [];
  const models = get(doc.contents, 'models')?.value;
  if (!isSeq(models)) return out;

  for (const model of models.items) {
    const meta = get(get(model, 'config')?.value, 'meta')?.value;
    const sourcesNode = get(meta, 'sources')?.value;
    if (!isSeq(sourcesNode)) continue;
    const names: string[] = [];
    for (const s of sourcesNode.items) {
      const n = get(s, 'name')?.value;
      if (isScalar(n) && typeof n.value === 'string') names.push(n.value);
    }
    if (!names.length) continue;

    // SW003
    for (const s of sourcesNode.items) {
      const own = get(s, 'name')?.value;
      const ownName = isScalar(own) ? String(own.value) : '';
      const comp = get(s, 'completes')?.value;
      const targets = isSeq(comp) ? comp.items : comp != null ? [comp] : [];
      for (const t of targets) {
        if (!isScalar(t)) continue;
        const v = String(t.value);
        if (v === ownName) {
          out.push({ code: 'SW003', message: `completes names this source itself ("${v}").`, start: range(t)[0], end: range(t)[1] });
        } else if (!names.includes(v)) {
          out.push({ code: 'SW003', message: `completes: "${v}" is not a source in this model (sources: ${names.join(', ')}).`, start: range(t)[0], end: range(t)[1] });
        }
      }
    }

    // SW001 / SW002
    const columns = get(model, 'columns')?.value;
    if (!isSeq(columns)) continue;
    for (const col of columns.items) {
      const colName = get(col, 'name')?.value;
      const label = isScalar(colName) ? String(colName.value) : 'column';
      const defs = get(get(col, 'meta')?.value, 'definitions');
      if (!defs || !isMap(defs.value)) continue;
      const keys = (defs.value as YAMLMap).items.map((p) => ({ name: keyOf(p.key), node: p.key }));
      const missing = names.filter((n) => !keys.some((k) => k.name === n));
      if (missing.length) {
        const [s, e] = range(defs.keyNode);
        out.push({ code: 'SW001', message: `${label}: definitions is missing source${missing.length > 1 ? 's' : ''} ${missing.join(', ')}. Every source must be listed (use "default" if it never provides a value).`, start: s, end: e });
      }
      for (const k of keys) {
        if (!names.includes(k.name)) {
          const [s, e] = range(k.node);
          out.push({ code: 'SW002', message: `${label}: "${k.name}" is not a source in this model (sources: ${names.join(', ')}).`, start: s, end: e });
        }
      }
    }
  }
  return out;
}
