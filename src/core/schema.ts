// Walk JSON Schemas by document path. Follows $ref (including into other
// schema documents, e.g. dbt Labs' schema referenced by URL) and collects
// every schema that applies at a path, across allOf/anyOf/oneOf branches,
// so suggestions can merge our conventions with the standard dbt keys.

import type { PathPart } from './context';

export type Schema = Record<string, any>;

/** Returns the schema document for a URI (no fragment), or undefined. */
export type Loader = (uri: string) => Schema | undefined;

export interface Block {
  label: string;
  detail?: string;
  body: string;
  inline?: boolean;
  'x-when'?: When;
}

export interface When {
  table_type?: string;
  source_count?: { min?: number; max?: number };
  absent?: string[];
}

const isObj = (v: unknown): v is Schema => !!v && typeof v === 'object' && !Array.isArray(v);

/** Make a loaded document's local refs ("#/...") absolute ("<uri>#/..."). */
function absolutize(node: unknown, uri: string): unknown {
  if (Array.isArray(node)) return node.map((n) => absolutize(n, uri));
  if (!isObj(node)) return node;
  const out: Schema = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = k === '$ref' && typeof v === 'string' && v.startsWith('#') ? uri + v : absolutize(v, uri);
  }
  return out;
}

export class SchemaIndex {
  private docs = new Map<string, Schema | undefined>();

  constructor(public readonly root: Schema, private readonly loader?: Loader) {
    this.docs.set('', root);
  }

  private doc(uri: string): Schema | undefined {
    if (!this.docs.has(uri)) {
      const d = this.loader?.(uri);
      this.docs.set(uri, d ? (absolutize(d, uri) as Schema) : undefined);
    }
    return this.docs.get(uri);
  }

  private lookup(ref: string): unknown {
    const hash = ref.indexOf('#');
    const uri = hash < 0 ? ref : ref.slice(0, hash);
    const frag = hash < 0 ? '' : ref.slice(hash + 1);
    let cur: any = this.doc(uri);
    if (!frag || frag === '/') return cur;
    for (const part of frag.replace(/^\//, '').split('/')) {
      cur = cur?.[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return cur;
  }

  /** Follow $ref; keep sibling keywords (x-when etc.) of the referring node. */
  resolve(s: unknown, depth = 0): Schema | undefined {
    if (!isObj(s)) return undefined;
    if (typeof s.$ref === 'string' && depth < 32) {
      const { $ref, ...rest } = s;
      const resolved = this.resolve(this.lookup($ref), depth + 1);
      return resolved ? { ...resolved, ...rest } : rest;
    }
    return s;
  }

  private branches(s: Schema): unknown[] {
    return [...(s.allOf ?? []), ...(s.anyOf ?? []), ...(s.oneOf ?? [])];
  }

  /** A schema plus every allOf/anyOf/oneOf branch under it, resolved. */
  expand(s: unknown, depth = 0, seen = new Set<Schema>()): Schema[] {
    const r = this.resolve(s);
    if (!r || depth > 12 || seen.has(r)) return [];
    seen.add(r);
    return [r, ...this.branches(r).flatMap((b) => this.expand(b, depth + 1, seen))];
  }

  /** Every schema that describes child `key` of a value matching `s`. */
  children(s: unknown, key: PathPart): Schema[] {
    const out: Schema[] = [];
    for (const r of this.expand(s)) {
      if (typeof key === 'number') {
        if (isObj(r.items)) out.push(r.items);
      } else if (isObj(r.properties) && isObj(r.properties[key])) {
        out.push(r.properties[key]);
      } else if (isObj(r.additionalProperties) && !(isObj(r.properties) && key in r.properties)) {
        out.push(r.additionalProperties);
      }
    }
    return out;
  }

  /** All schemas (expanded) that apply at a document path, ours first. */
  atAll(path: PathPart[]): Schema[] {
    let cur: unknown[] = [this.root];
    for (const p of path) {
      cur = cur.flatMap((s) => this.children(s, p));
      if (!cur.length) return [];
    }
    const out: Schema[] = [];
    const seen = new Set<Schema>();
    for (const s of cur) for (const e of this.expand(s)) if (!seen.has(e)) { seen.add(e); out.push(e); }
    return out;
  }

  at(path: PathPart[]): Schema | undefined {
    return this.atAll(path)[0];
  }

  /** Properties declared across the schemas; the first definition of a key wins. */
  properties(schemas: Schema[]): Array<[string, Schema]> {
    const props = new Map<string, Schema>();
    for (const s of schemas) {
      if (!isObj(s.properties)) continue;
      for (const [k, v] of Object.entries(s.properties)) {
        if (isObj(v) && !props.has(k)) props.set(k, v);
      }
    }
    return [...props.entries()];
  }

  required(schemas: Schema[]): Set<string> {
    const out = new Set<string>();
    for (const s of schemas) if (Array.isArray(s.required)) s.required.forEach((r: string) => out.add(r));
    return out;
  }

  blocks(schemas: Schema | Schema[] | undefined): Block[] {
    const list = Array.isArray(schemas) ? schemas : schemas ? [schemas] : [];
    return list.flatMap((s) => (Array.isArray(s?.['x-blocks']) ? s['x-blocks'] : []));
  }
}
