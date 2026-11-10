// Cursor position → the blocks and keys that fit there, filled from the file.

import { contextsAt, CursorContext, MARK } from './context';
import { SchemaIndex, Schema, When } from './schema';
import { render, indentRest, Vars, Rendered } from './template';

export interface Offer {
  label: string;
  detail: string;
  snippet: string;
  preview: string;
  kind: 'block' | 'key' | 'entry';
  sort: string;
  ctx: CursorContext;
}

const strings = (xs: unknown): string[] =>
  Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string' && x !== MARK) : [];

const names = (xs: unknown): string[] => strings(Array.isArray(xs) ? xs.map((x: any) => x?.name) : []);

/** Variables from the file and the model the cursor is in. */
export function modelVars(ctx: CursorContext): Vars {
  const lists: Record<string, string[]> = {};
  const values: Record<string, string> = {};
  const data = ctx.data as any;
  lists.model = names(data?.models);
  const i = ctx.path[0] === 'models' && typeof ctx.path[1] === 'number' ? ctx.path[1] : -1;
  const model = i >= 0 ? data?.models?.[i] : undefined;
  if (model && typeof model === 'object') {
    const meta = model.config?.meta ?? {};
    lists.source = names(meta.sources);
    lists.column = names(model.columns);
    const grain = (model.data_tests ?? []).find((t: any) => t && typeof t === 'object' && t['dbt_utils.unique_combination_of_columns']);
    lists.grain_column = strings(grain?.['dbt_utils.unique_combination_of_columns']?.combination_of_columns);
    if (typeof model.name === 'string') values.model_name = model.name;
    if (meta.table_type === 'fact' || meta.table_type === 'dimension') values.table_type = meta.table_type;
  }
  return { lists, values };
}

function allowed(when: When | undefined, vars: Vars, siblings: string[]): boolean {
  if (!when) return true;
  const tt = vars.values.table_type;
  if (when.table_type && tt && when.table_type !== tt) return false;
  if (when.source_count) {
    const n = vars.lists.source?.length ?? 0;
    if (when.source_count.min != null && n < when.source_count.min) return false;
    if (when.source_count.max != null && n > when.source_count.max) return false;
  }
  if (when.absent && when.absent.some((k) => siblings.includes(k))) return false;
  return true;
}

/** `key:` followed by a rendered value, inline or nested. */
function keyed(key: string, r: Rendered, inline: boolean): Rendered {
  if (inline) return { snippet: `${key}: ${r.snippet}`, preview: `${key}: ${r.preview}` };
  return {
    snippet: `${key}:\n  ${indentRest(r.snippet, 2)}`,
    preview: `${key}:\n  ${indentRest(r.preview, 2)}`,
  };
}

function listItem(r: Rendered): Rendered {
  return { snippet: `- ${indentRest(r.snippet, 2)}`, preview: `- ${indentRest(r.preview, 2)}` };
}

const isArray = (s: Schema) => s.type === 'array' || (Array.isArray(s.type) && s.type.includes('array'));
const isObject = (s: Schema) => s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object')) || (!s.type && s.properties);

/** A value for a key with no block: enum dropdown, const, or a plain tab stop. */
function simpleValue(key: string, s: Schema): Rendered {
  if (Array.isArray(s.enum)) {
    return { snippet: ` \${1|${s.enum.join(',')}|}`, preview: ` ${s.enum[0]}` };
  }
  if (s.const !== undefined) return { snippet: ` ${s.const}`, preview: ` ${s.const}` };
  if (isArray(s)) return { snippet: ` [\${1}]`, preview: ' []' };
  if (isObject(s)) return { snippet: `\n  \${1}`, preview: '' };
  return { snippet: ` \${1:${key}}`, preview: ` <${key}>` };
}

const firstLine = (d: unknown) => (typeof d === 'string' ? d.trim().split('\n')[0].slice(0, 120) : '');

export function offersAt(index: SchemaIndex, text: string, offset: number): Offer[] {
  const out: Offer[] = [];
  const seen = new Set<string>();
  const add = (o: Offer) => {
    const k = o.kind + '|' + o.snippet;
    if (!seen.has(k)) { seen.add(k); out.push(o); }
  };

  for (const ctx of contextsAt(text, offset)) {
    const vars = modelVars(ctx);

    if (ctx.kind === 'item') {
      const lists = index.atAll(ctx.path);
      const items = lists.flatMap((l) => index.children(l, 0)).flatMap((s) => index.expand(s));
      const where = ctx.path[ctx.path.length - 1];
      for (const b of index.blocks(items)) {
        if (!allowed(b['x-when'], vars, [])) continue;
        const r = render(b.body, vars);
        add({ ctx, kind: 'block', label: b.label, detail: b.detail ?? `New ${String(where)} item`, sort: '0', ...listItem(r) });
      }
      continue;
    }

    // Key context: inside a map. `objs` = every schema layer that applies here.
    const objs = index.atAll(ctx.path);
    if (!objs.length) continue;
    const sib = ctx.siblings;

    // A map keyed by a variable (definitions): one entry per missing value.
    const keyed_ = objs.find((o) => typeof o['x-keys'] === 'string');
    const keyVar: string | undefined = keyed_?.['x-keys'];
    let entryVars = vars;
    if (keyed_ && keyVar) {
      const missing = (vars.lists[keyVar] ?? []).filter((v) => !sib.includes(v));
      entryVars = { lists: { ...vars.lists, [keyVar]: missing }, values: vars.values };
      const valueSchemas = index.expand(keyed_.additionalProperties);
      for (const m of missing) {
        for (const b of index.blocks(valueSchemas)) {
          if (!allowed(b['x-when'], vars, sib)) continue;
          const r = keyed(m, render(b.body, vars), !!b.inline);
          add({ ctx, kind: 'entry', label: `${m}: ${b.label}`, detail: `Definition for source ${m}`, sort: '1', ...r });
        }
      }
      if (!missing.length && sib.length) continue;
    }

    // The map's own blocks, when it is empty (or keyed and has gaps).
    if (sib.length === 0 || keyVar) {
      for (const b of index.blocks(objs)) {
        if (b.inline || !allowed(b['x-when'], vars, sib)) continue;
        const r = render(b.body, entryVars);
        const label = keyVar && sib.length ? `${b.label} — remaining` : b.label;
        add({ ctx, kind: 'block', label, detail: b.detail ?? '', sort: '0', ...r });
      }
    }

    // Keys this map can still take, across every layer (ours first).
    const required = index.required(objs);
    for (const [key, raw] of index.properties(objs)) {
      if (sib.includes(key) || key === MARK) continue;
      if (raw['x-hide']) continue;
      const s = index.resolve(raw);
      if (!s || s['x-hide'] || !allowed(s['x-when'], vars, sib)) continue;
      const req = required.has(key);
      const rank = req ? '2' : '3';
      const tag = req ? 'required' : 'optional';
      const layers = index.expand(raw);
      const own = index.blocks(layers).filter((b) => allowed(b['x-when'], vars, sib));
      const itemSchemas = layers.flatMap((l) => index.children(l, 0)).flatMap((i) => index.expand(i));
      const itemBlocks = index.blocks(itemSchemas).filter((b) => allowed(b['x-when'], vars, sib));
      const desc = firstLine(layers.find((l) => typeof l.description === 'string')?.description);

      if (own.length) {
        for (const b of own) {
          const v = render(b.body, vars);
          add({ ctx, kind: 'key', label: own.length > 1 ? `${key}: ${b.label}` : key, detail: `${tag} · ${b.detail ?? b.label}`, sort: rank, ...keyed(key, v, !!b.inline) });
        }
      } else if (itemBlocks.length) {
        for (const b of itemBlocks) {
          const v = listItem(render(b.body, vars));
          add({ ctx, kind: 'key', label: `${key}: ${b.label}`, detail: `${tag} · list starting with ${b.label}`, sort: rank, ...keyed(key, v, false) });
        }
      } else {
        const v = simpleValue(key, s);
        add({ ctx, kind: 'key', label: key, detail: `${tag}${desc ? ' · ' + desc : ''}`, sort: rank, snippet: `${key}:${v.snippet}`, preview: `${key}:${v.preview}` });
      }
    }
  }
  return out.sort((a, b) => a.sort.localeCompare(b.sort));
}
