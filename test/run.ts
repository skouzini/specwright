import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { SchemaIndex } from '../src/core/schema';
import { offersAt } from '../src/core/offers';
import { lint } from '../src/core/lint';
import { contextsAt, formatPath, pathAt } from '../src/core/context';

const index = new SchemaIndex(parse(readFileSync(__dirname + '/../schemas/model_spec.schema.yaml', 'utf8')));
const base = readFileSync(__dirname + '/fixtures/subscriptions.yml', 'utf8');

let failures = 0;
function check(name: string, ok: boolean, info = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + info}`);
}

/** Put the cursor on a new line after `anchor` (first match), at `indent` spaces. */
function at(anchor: string, indent: number, typed = '', src = base) {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error('anchor not found: ' + anchor);
  const eol = src.indexOf('\n', i);
  const text = src.slice(0, eol + 1) + ' '.repeat(indent) + typed + '\n' + src.slice(eol + 1);
  const offset = eol + 1 + indent + typed.length;
  return { text, offset };
}

function offers(anchor: string, indent: number, typed = '', src = base) {
  const { text, offset } = at(anchor, indent, typed, src);
  const ctx = contextsAt(text, offset);
  const o = offersAt(index, text, offset);
  return { o, labels: o.map((x) => x.label), where: ctx.map((c) => `${c.kind}@${formatPath(c.path)}`).join(' | ') };
}

const show = (name: string, r: ReturnType<typeof offers>) =>
  console.log(`\n# ${name}\n  context: ${r.where || '(none)'}\n  offers:  ${r.labels.join(' · ') || '(none)'}`);

// 1. New source item in sources (after the last source's last key)
{
  const r = offers('match_pick: first-seen row', 10);
  show('new item in sources', r);
  check('sources item → Source blocks', r.labels.includes('Source') && r.labels.includes('Source (completes another source)'), r.labels.join(','));
  const comp = r.o.find((x) => x.label === 'Source (completes another source)')!;
  check('completes offers a dropdown of existing sources', /completes: \$\{\d+\|subscriptions,cancelled_subscriptions\|\}/.test(comp.snippet), comp.snippet);
}

// 2. Key inside a source item → only keys that source doesn't have
{
  const r = offers('watermark: DELETED_AT', 12);
  show('new key in a source', r);
  check('source keys exclude existing ones', !r.labels.includes('name') && r.labels.includes('pick') && r.labels.includes('match_pick'), r.labels.join(','));
  check('no blocks for a non-empty source', !r.labels.includes('Source'), r.labels.join(','));
}

// 3. New column item → column blocks; definitions repeats per source
{
  const r = offers('transform: lookup', 6);
  show('new item in columns', r);
  const col = r.o.find((x) => x.label === 'Column (read from sources)')!;
  check('column block offered', !!col, r.labels.join(','));
  check('definitions has one entry per source', /subscriptions:\n[\s\S]*cancelled_subscriptions:/.test(col.preview), col.preview);
  check('fact measure offered for a fact', r.labels.includes('Column (fact measure)'));
  const der = r.o.find((x) => x.label === 'Column (derived from other columns)')!;
  check('derived column: source is a dropdown of model columns', /source: \$\{\d+\|CUSTOMER_ID,PRODUCT_ID,PLAN_CODE\|\}/.test(der.snippet), der.snippet);
  console.log('\n--- Column (read from sources) preview ---\n' + col.preview);
}

// 4. Inside definitions with one source missing → offer just that source
{
  const r = offers('trial_subscriptions: default', 12);
  show('new key in a definitions map missing a source', r);
  check('offers the missing source only', r.labels.some((l) => l.startsWith('cancelled_subscriptions:')) && !r.labels.some((l) => l.startsWith('subscriptions:')), r.labels.join(','));
}

// 5. Column meta with definitions → no source/transform offered
{
  const r = offers('display_name: Plan Code', 10);
  show('new key in column meta (has definitions)', r);
  check('no source/transform when definitions exists', !r.labels.some((l) => /^(source|transform)/.test(l)), r.labels.join(','));
  check('sensitivity offered', r.labels.includes('sensitivity'));
  check('additivity offered on a fact', r.labels.includes('additivity'));
}

// 6. Model meta → combine already there, fact_type offered for a fact
{
  const r = offers('status: current', 8);
  show('new key in model meta', r);
  check('fact_type offered (fact model, not present)', r.labels.includes('fact_type'), r.labels.join(','));
  check('nothing already present is offered', !r.labels.includes('combine') && !r.labels.includes('grain'), r.labels.join(','));
}

// 7. Dimension: no fact_type, no measures; single source: no combine
{
  const dim = readFileSync(__dirname + '/fixtures/dim_customer.yml', 'utf8');
  const meta = offers('status: planned', 8, '', dim);
  show('dimension meta (1 source)', meta);
  check('dimension: no fact_type, no combine', !meta.labels.includes('fact_type') && !meta.labels.includes('combine'), meta.labels.join(','));
  const cols = offers('transform: hash of CUSTOMER_ID', 6, '', dim);
  check('dimension: no fact measure block', !cols.labels.includes('Column (fact measure)'), cols.labels.join(','));
  const pk = offers('constraints:', 4, '- ', dim);
  show('dimension constraints item (typed "- ")', pk);
  check('dimension: surrogate key PK only', pk.labels.includes('Primary key (surrogate key)') && !pk.labels.includes('Primary key (grain columns)'), pk.labels.join(','));
}

// 8. Fact PK block fills grain columns
{
  const r = offers('constraints:', 6, '- ');
  const pk = r.o.find((x) => x.label === 'Primary key (grain columns)');
  check('fact PK fills grain columns', !!pk && pk.preview.includes('columns: [CUSTOMER_ID, PRODUCT_ID, PLAN_CODE]'), pk?.preview ?? r.labels.join(','));
}

// 9. Typed prefix filters nothing structurally (VS Code filters by text)
{
  const r = offers('watermark: DELETED_AT', 12, 'pi');
  check('partial word keeps the same context', r.labels.includes('pick'), r.where);
}

// 10. Value position → nothing
{
  const i = base.indexOf('grain: ') + 'grain: '.length;
  check('no offers on a key: value line', offersAt(index, base, i).length === 0);
}

// 11. Status bar path
{
  const i = base.indexOf('SHOP.RAW.SUBSCRIPTIONS.PLANCD');
  check('pathAt inside a definition', formatPath(pathAt(base, i) ?? []) === 'models[0] › columns[2] › meta › definitions › subscriptions › column', formatPath(pathAt(base, i) ?? []));
}

// 12. Lint
{
  const f = lint(base);
  console.log('\n# lint findings\n' + f.map((x) => `  ${x.code} ${x.message}`).join('\n'));
  check('SW001 missing source in definitions', f.some((x) => x.code === 'SW001' && x.message.startsWith('PLAN_CODE')));
  check('SW002 unknown source in definitions', f.some((x) => x.code === 'SW002' && x.message.includes('"trial_subscriptions"')));
  check('SW003 completes unknown source', f.some((x) => x.code === 'SW003' && x.message.includes('"subscription"')));
  check('no false positives on CUSTOMER_ID', !f.some((x) => x.message.startsWith('CUSTOMER_ID')));
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
