// Walk a JSON Schema by document path, following $ref and the branches of
// oneOf/anyOf/allOf where a property or list item is declared.

import type { PathPart } from './context';

export type Schema = Record<string, any>;

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

export class SchemaIndex {
  constructor(public readonly root: Schema) {}

  /** Follow $ref; keep sibling keywords (x-when etc.) of the referring node. */
  resolve(s: unknown, depth = 0): Schema | undefined {
    if (!s || typeof s !== 'object') return undefined;
    const node = s as Schema;
    if (typeof node.$ref === 'string' && depth < 32) {
      const target = this.lookup(node.$ref);
      const { $ref, ...rest } = node;
      const resolved = this.resolve(target, depth + 1);
      return resolved ? { ...resolved, ...rest } : rest;
    }
    return node;
  }

  private lookup(ref: string): unknown {
    if (!ref.startsWith('#/')) return undefined;
    let cur: any = this.root;
    for (const part of ref.slice(2).split('/')) {
      cur = cur?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return cur;
  }

  private branches(s: Schema): Schema[] {
    return [...(s.oneOf ?? []), ...(s.anyOf ?? []), ...(s.allOf ?? [])];
  }

  child(s: unknown, key: PathPart, depth = 0): Schema | undefined {
    const r = this.resolve(s);
    if (!r || depth > 8) return undefined;
    if (typeof key === 'number') {
      if (r.items && typeof r.items === 'object') return r.items;
    } else {
      if (r.properties && key in r.properties) return r.properties[key];
    }
    for (const b of this.branches(r)) {
      const hit = this.child(b, key, depth + 1);
      if (hit) return hit;
    }
    if (typeof key === 'string' && r.additionalProperties && typeof r.additionalProperties === 'object') {
      return r.additionalProperties;
    }
    return undefined;
  }

  at(path: PathPart[]): Schema | undefined {
    let cur: Schema | undefined = this.root;
    for (const p of path) {
      cur = this.child(cur, p);
      if (!cur) return undefined;
    }
    return this.resolve(cur);
  }

  /** Properties declared on the node itself (not branch-only ones). */
  properties(s: Schema): Array<[string, Schema]> {
    const props: Record<string, Schema> = { ...(s.properties ?? {}) };
    return Object.entries(props).filter(([, v]) => (v as unknown) !== false);
  }

  required(s: Schema): Set<string> {
    return new Set<string>(Array.isArray(s.required) ? s.required : []);
  }

  blocks(s: Schema | undefined): Block[] {
    const b = s?.['x-blocks'];
    return Array.isArray(b) ? b : [];
  }
}
