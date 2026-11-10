// Schema validation through yaml-language-server — the engine inside the
// Red Hat YAML extension — so these results are what VS Code shows.
import { readFileSync } from 'fs';
import { validate } from './yamlls';

const schemas = __dirname + '/../schemas/';
const fx = (f: string) => readFileSync(__dirname + '/fixtures/' + f, 'utf8');
let failures = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + info}`);
};
const has = (d: { msg: string }[], re: RegExp) => d.some((x) => re.test(x.msg));
const dump = (d: { line: number; msg: string }[]) => d.map((x) => `L${x.line} ${x.msg}`).join('\n      ');

(async () => {
  const beam = schemas + 'model_spec.schema.json';
  const dbt = schemas + 'dbt.schema.json';

  const sub = await validate(beam, fx('subscriptions.yml'));
  check('BEAM preset: subscriptions.yml is valid', sub.length === 0, dump(sub));
  // dim_customer.yml leaves `constraints:` empty on purpose (cursor tests insert there).
  const dim = await validate(beam, fx('dim_customer.yml'));
  check('BEAM preset: dim_customer.yml only flags its empty constraints', dim.length === 1 && dim[0].line === 22 && /Expected "array"/.test(dim[0].msg), dump(dim));

  const withConfig = fx('subscriptions.yml').replace('    config:\n      meta:', '    config:\n      materialized: incremental\n      unique_key: [CUSTOMER_ID, PRODUCT_ID, PLAN_CODE]\n      incremental_strategy: merge\n      merge_update_columns: [IS_ACTIVE]\n      meta:');
  const dc = await validate(beam, withConfig);
  check('BEAM preset: standard dbt config keys are accepted', dc.length === 0, dump(dc));

  const bad = await validate(beam, fx('bad_model.yml'));
  console.log('      bad_model.yml →\n      ' + dump(bad));
  check('our rule: model name pattern', has(bad, /does not match the pattern/));
  check('our rule: status enum', has(bad, /planned", "current", "deprecated/));
  check('our rule: fact_type not allowed on a dimension', has(bad, /Property fact_type is not allowed/));
  check('our rule: combine not allowed with one source', has(bad, /Property combine is not allowed/));
  check('our rule: completes requires match', has(bad, /missing property match required by property completes/i));
  check('our rule: grain test required', has(bad, /contains/));
  check('our rule: definitions XOR source/transform', has(bad, /Property (source|transform) is not allowed/));
  check('dbt layer: access enum', has(bad, /"private", "protected", "public"/));
  check('dbt layer: unknown column key (typo)', has(bad, /Property descriptin is not allowed/));

  const plain = await validate(dbt, fx('plain_dbt.yml'));
  check('dbt preset: plain dbt file is valid', plain.length === 0, dump(plain));
  const plainBad = await validate(dbt, fx('plain_dbt.yml').replace('description: "Order key"', 'descriptin: "Order key"').replace('materialized: incremental', 'materialized: [incremental]'));
  check('dbt preset: catches a typo key', has(plainBad, /descriptin is not allowed/), dump(plainBad));
  const beamOnPlain = await validate(dbt, fx('subscriptions.yml'));
  check('dbt preset: a BEAM file is valid dbt too', beamOnPlain.length === 0, dump(beamOnPlain));

  console.log(`\n${failures ? failures + ' FAILED' : 'validation: all passed'}`);
  process.exit(failures ? 1 : 0);
})();
