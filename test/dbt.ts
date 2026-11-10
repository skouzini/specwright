// Cursor tests for the generic dbt preset (schemas/dbt.schema.yaml).
import { readFileSync } from 'fs';
import { loadIndex } from './loader';
import { offersAt } from '../src/core/offers';

const index = loadIndex('dbt.schema.yaml');
const base = readFileSync(__dirname + '/fixtures/plain_dbt.yml', 'utf8');
let failures = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + info}`);
};
function offers(anchor: string, indent: number, typed = '') {
  const i = base.indexOf(anchor); if (i < 0) throw new Error('anchor not found: ' + anchor);
  const eol = base.indexOf('\n', i);
  const text = base.slice(0, eol + 1) + ' '.repeat(indent) + typed + '\n' + base.slice(eol + 1);
  return offersAt(index, text, eol + 1 + indent + typed.length);
}
const labels = (o: ReturnType<typeof offers>) => o.map((x) => x.label);

{
  const o = offers('- unique', 10);
  const l = labels(o);
  check('column test item → not_null/unique/accepted_values/relationships', ['not_null', 'unique', 'accepted_values', 'relationships'].every((x) => l.includes(x)), l.join(','));
  const rel = o.find((x) => x.label === 'relationships')!;
  check('relationships: `to` is a dropdown of models in the file', /ref\('\$\{\d+\|stg_orders,dim_customers\|\}'\)/.test(rel.snippet), rel.snippet);
}
{
  const l = labels(offers('description: "Customer"', 6));
  check('columns item → Column blocks', l.includes('Column') && l.includes('Column (key)'), l.join(','));
}
{
  const l = labels(offers('description: "Customer"', 8));
  check('column keys come from dbt (tags, constraints, data_tests…)', ['tags', 'constraints', 'data_tests', 'data_type'].every((x) => l.some((y) => y === x || y.startsWith(x + ':'))), l.join(','));
  check('legacy `tests` is hidden', !l.includes('tests'), l.join(','));
}
{
  const l = labels(offers('incremental_strategy: merge', 6));
  check('config keys: dbt (materialized…) + ours (merge_update_columns)', l.includes('merge_update_columns') && l.includes('on_schema_change') && !l.includes('unique_key'), l.join(','));
}
{
  const l = labels(offers('description: "Raw orders"', 6));
  check('source tables item → Table block', l.includes('Table'), l.join(','));
}
{
  const l = labels(offers('description: "One row per customer."', 4));
  check('model keys from dbt: access, config, data_tests, docs', ['access', 'config', 'docs'].every((x) => l.includes(x)) && l.some((y) => y.startsWith('data_tests')), l.join(','));
}

console.log(`\n${failures ? failures + ' FAILED' : 'dbt preset: all passed'}`);
process.exit(failures ? 1 : 0);
