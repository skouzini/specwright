import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { parse, parseDocument } from 'yaml';
import { SchemaIndex } from '../src/core/schema';
import { offersAt } from '../src/core/offers';

const index = new SchemaIndex(parse(readFileSync(__dirname + '/../schemas/model_spec.schema.yaml', 'utf8')));
const base = readFileSync(__dirname + '/fixtures/subscriptions.yml', 'utf8');

// Resolve a snippet the way accepting every default would, then apply VS Code's
// whitespace adjustment (later lines get the insertion line's indentation).
function resolveSnippet(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { out += s[++i]; continue; }
    if (s[i] === '$' && s[i + 1] === '{') {
      let j = i + 2; while (/\d/.test(s[j])) j++;
      let depth = 1, k = j, body = '';
      while (depth) { const c = s[k]; if (c === '\\') { body += s[k + 1]; k += 2; continue; } if (c === '}') { depth--; if (!depth) break; } body += c; k++; }
      out += s[j] === ':' ? body.slice(1) : body.slice(1, -1).split(',')[0];
      i = k; continue;
    }
    out += s[i];
  }
  return out;
}

const spots: Array<[string, number, string]> = [
  ['match_pick: first-seen row', 10, ''],
  ['watermark: DELETED_AT', 12, ''],
  ['transform: lookup', 6, ''],
  ['trial_subscriptions: default', 12, ''],
  ['display_name: Plan Code', 10, ''],
  ['status: current', 8, ''],
  ['constraints:', 6, '- '],
  ['combination_of_columns: [CUSTOMER_ID, PRODUCT_ID, PLAN_CODE]', 6, '- '],
  ['transform: lookup', 8, ''],
];
let total = 0, bad = 0;
mkdirSync(__dirname + '/out', { recursive: true });
for (const [anchor, indent, typed] of spots) {
  const i = base.indexOf(anchor); const eol = base.indexOf('\n', i);
  const text = base.slice(0, eol + 1) + ' '.repeat(indent) + typed + '\n' + base.slice(eol + 1);
  const offset = eol + 1 + indent + typed.length;
  for (const o of offersAt(index, text, offset)) {
    total++;
    const body = resolveSnippet(o.snippet).split('\n').map((l, n) => (n && l ? ' '.repeat(indent) + l : l)).join('\n');
    const result = text.slice(0, o.ctx.replaceStart) + body + text.slice(o.ctx.replaceEnd);
    const doc = parseDocument(result);
    if (doc.errors.length) { bad++; console.log(`BROKEN YAML: ${o.label} @ ${anchor}\n${doc.errors[0].message}`); continue; }
    writeFileSync(`${__dirname}/out/${total}.yml`, result);
  }
}
console.log(`${total} inserts, ${bad} produced invalid YAML`);
process.exit(bad ? 1 : 0);
