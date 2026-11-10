# Generating SQL from a model spec — investigation

Status: **investigation / proposal**, nothing implemented. Written 2026-11-09.

The BEAM model spec already describes most of what a model's SQL does: its
sources, how each column is read from each source, how sources combine, the
grain, and (via `completes` / `match`) how later events close earlier rows.
The original spec even has "SQL translation" notes. This note looks at how far
the SQL can be generated from the YAML, what stops it today, and how to get
there.

## TL;DR

- **Feasible for the structure, not yet for the logic.** CTE per source,
  `FROM`, direct column reads, `COALESCE` for `priority`, defaults, joins from
  `path`, `UNION ALL` for `combine`, and the incremental merge config can all be
  generated deterministically. Anything written *in words* — non-`direct`
  transforms, filter intents, `pick` / `match_pick` rules, the `match`
  condition — can't, without either making those fields structured/SQL or
  having an agent translate them (and a human review the result).
- **Recommended shape: a dbt macro, not a code generator.** Each model's `.sql`
  becomes `{{ beam_model() }}`; the macro reads the model's `config.meta`
  (`config.meta_get`, dbt 1.10+) and renders the SQL at compile time. One source
  of truth, no generated files drifting from the YAML. This is the pattern
  AutomateDV uses for Data Vault.
- **Two decisions are needed first:** where column `meta` lives (see
  "Prerequisites"), and which free-text fields become structured.
- **Next step:** a one-day spike — macro for one source, `direct` columns only,
  on one real model — to confirm column meta is readable from the macro.

## Two ways to generate

| | A. dbt macro at compile time (recommended) | B. Generate `.sql` files (extension command or CLI) |
|---|---|---|
| How | `models/x.sql` = `{{ beam_model() }}`; macro reads meta, emits SQL | Command writes `models/x.sql` from the YAML |
| Source of truth | YAML only | YAML, plus generated SQL that can be hand-edited |
| Drift | None — SQL is re-rendered every compile | Edits to `.sql` or YAML drift apart; needs a check |
| Escape hatch | Per-column `sql:` overrides in YAML, or drop the macro for that model | Edit the file |
| Where it runs | dbt (CI, Cloud, CLI, any editor) | Only where the generator runs |
| Visibility | `dbt compile` / the dbt extension's compiled view shows the SQL | SQL is in the repo, reviewable in PRs |
| Language | Jinja (awkward for complex logic) | TypeScript, reusing this repo's parser |
| Precedent | [AutomateDV](https://github.com/Datavault-UK/automate-dv) (metadata → hubs/links/sats via macros) | [metadv](https://pypi.org/project/metadv/) (YAML → dbt SQL files), [Workday dj](https://github.com/Workday/dj) (JSON → SQL + YAML) |

B is a reasonable fallback if the macro gets unwieldy in Jinja; the mapping
below is the same either way.

## What maps to SQL today

| Spec element | SQL | Deterministic? |
|---|---|---|
| `sources[].table` | `from <table> as <alias>` in a CTE per source | ✅ |
| `sources[].filter: all` | no `where` | ✅ |
| `sources[].filter: <intent in words>` | `where …` | ❌ words |
| `sources[].pick` | `qualify row_number() over (…) = 1` | ❌ words (partition/order not stated) |
| `sources[].watermark` | incremental predicate `where <wm> > (select max(…) from {{ this }})` | ⚠️ needs a target column to compare against (not in spec) |
| `definitions.<src>: default` | `<default_value>::<data_type>` | ✅ |
| `definitions.<src>: {transform: <constant>}` | literal | ⚠️ only if the constant is a literal, not prose |
| `column` + `transform: direct` | `<alias>.<COL> as <NAME>` | ✅ |
| `column` + `transform: <words>` | expression | ❌ words |
| `path` steps | `left/inner join <table> on …` | ⚠️ needs an alias convention for `A.KEY = B.KEY` (or the `[left, right]` pair form, which the schema already allows) |
| `priority` | `coalesce(c1, c2, …, <fallback>)` | ✅ (fallback ❌ if words) |
| `source: generated` + `transform` | e.g. `dbt_utils.generate_surrogate_key([...])` | ⚠️ only if transform is structured |
| `source: [cols]` + `transform` | expression over model columns | ❌ words |
| `combine: union` | `union all` of the per-source CTEs, same column order | ✅ |
| grain test columns | `unique_key` | ✅ |
| CV columns | `merge_update_columns` | ❌ CV columns aren't marked anywhere |
| `completes` + `match` (full grain) | merge on the grain handles it | ✅ once CV columns are known |
| `completes` + `match` (fewer columns than grain) | pre-merge join (below) | ⚠️ needs `match` structured + CV columns |
| `match_pick` | `qualify row_number() … = 1` | ❌ words |
| `status: planned` | skip the model / `enabled: false` | ✅ |

## Gaps to close (proposed spec changes, all backward compatible)

1. **Let transforms carry SQL.** `transform` accepts `direct`, words (as now),
   or `{ sql: "<expression>" }`. The generator uses `sql` when present and emits
   `null /* TODO: <words> */` otherwise, so a model still compiles while
   half-specified. Same idea for `filter`, `pick`, `match_pick`:
   `{ sql: … }` or `{ partition_by: [...], order_by: "…" }`.
2. **Mark column roles.** `meta.role: key | attribute | measure | cv | qa`.
   Gives `merge_update_columns` (the `cv` columns), and also lets the schema
   require `default_value` except on `qa` and `additivity` only on `measure`
   (both currently unenforceable — see README "Known limits").
3. **Structure `match`.** `match: { columns: [...], where: "...", unless: "..." }`
   instead of one string. The generator needs the column list; the lint layer
   needs it to require the match-uniqueness test.
4. **Fix the join convention.** Require the pair form
   `join: [[<left column>, <right column>]]`, where left is the previous table
   in the chain (the source on the first step) and right is this step's table.
5. **Name the watermark target.** Either store each source's watermark in a
   column (`_WM_<SOURCE>`), or use one load timestamp column and compare source
   watermarks to it. Without one, incremental runs can't filter.

An agent can do the word → SQL translation for (1) as a reviewed step: it reads
the words, proposes `sql:`, a human approves. That keeps the YAML the record of
intent *and* makes the SQL deterministic once approved.

## The hard part: `completes` with a partial `match`

From the spec's SQL translation notes: when `match` uses fewer columns than the
grain, the merge alone would insert a duplicate, so before the merge the
closing source's records are joined to existing rows *and* to the same load's
rows from other sources. Sketch for the `SUBSCRIPTIONS` fixture
(`cancelled_subscriptions` completes `subscriptions`, match on
`CUSTOMER_ID, PRODUCT_ID where IS_ACTIVE`, grain adds `PLAN_CODE`), simplified to two CV columns and `PRODUCT_ID` read
directly. Illustrative only — `{{ … }}` and CTE names are placeholders:

```sql
with src_subscriptions as (
    select s.CUSTID as CUSTOMER_ID, s.PRODID as PRODUCT_ID, s.PLANCD as PLAN_CODE,
           true as IS_ACTIVE, null::date as CANCELLED_ON            -- CV columns
    from SHOP.RAW.SUBSCRIPTIONS s
    {% if is_incremental() %} where s.UPDATED_AT > {{ watermark('subscriptions') }} {% endif %}
),
src_cancelled as (
    select c.CUSTID as CUSTOMER_ID, c.PRODID as PRODUCT_ID, c.PLANCD as PLAN_CODE,
           false as IS_ACTIVE, c.CANCEL_DT as CANCELLED_ON
    from SHOP.RAW.SUBSCRIPTIONS_CANCELLED c
    {% if is_incremental() %} where c.DELETED_AT > {{ watermark('cancelled_subscriptions') }} {% endif %}
),
open_rows as (                         -- rows a cancellation may close
    select *, 1 as _precedence from src_subscriptions where IS_ACTIVE
    {% if is_incremental() %}
    union all select CUSTOMER_ID, PRODUCT_ID, PLAN_CODE, IS_ACTIVE, CANCELLED_ON, 2
    from {{ this }} where IS_ACTIVE
    {% endif %}
),
closing as (                           -- match found: matched row's grain + non-CV, this record's CV
    select o.CUSTOMER_ID, o.PRODUCT_ID, o.PLAN_CODE, c.IS_ACTIVE, c.CANCELLED_ON
    from src_cancelled c
    join open_rows o on o.CUSTOMER_ID = c.CUSTOMER_ID and o.PRODUCT_ID = c.PRODUCT_ID
    qualify row_number() over (partition by c.CUSTOMER_ID, c.PRODUCT_ID
                               order by o._precedence /* match_pick rule */) = 1
),
unmatched as (                         -- no match: insert from this source's definitions
    select c.* from src_cancelled c
    where not exists (select 1 from open_rows o
                      where o.CUSTOMER_ID = c.CUSTOMER_ID and o.PRODUCT_ID = c.PRODUCT_ID)
),
combined as (
    select *, 1 as _wins from closing
    union all select *, 2 from unmatched
    union all select *, 3 from src_subscriptions
)
select CUSTOMER_ID, PRODUCT_ID, PLAN_CODE, IS_ACTIVE, CANCELLED_ON
from combined
qualify row_number() over (partition by CUSTOMER_ID, PRODUCT_ID, PLAN_CODE order by _wins) = 1
-- config: materialized=incremental, incremental_strategy=merge,
--         unique_key=[CUSTOMER_ID, PRODUCT_ID, PLAN_CODE], merge_update_columns=[IS_ACTIVE, CANCELLED_ON]
```

Things this surfaced that the spec doesn't yet say:

- **Same-load collisions.** A subscription and its cancellation in one load
  produce two rows with the same grain; Snowflake's `MERGE` errors (or is
  nondeterministic) on duplicate source keys. The final `qualify` resolves it —
  closing record wins — but the spec should state that precedence.
- **"Unless a deleted record for the same role arrives in the same load"**
  (a re-add) needs event ordering within a load, i.e. a timestamp on both
  sources to compare. Not expressible yet.
- **`{{ this }}` only exists on incremental runs**; on a full refresh only
  same-load matching applies, exactly as the spec says — the `is_incremental()`
  guards encode that.

## Prerequisites and risks

- **Column `meta` placement.** dbt 1.10 moved column `meta` under column
  `config:` (backported to 1.9; top-level column `meta` is deprecated). This
  spec puts it directly on the column. dbt Labs' Core `latest` schema — the one
  vendored here — still only allows the old place, while their Fusion schema
  allows *only* `config.meta`. Decide before building: moving to
  `columns[].config.meta` follows dbt's direction (and the Fusion schema); it's
  a mechanical change to the BEAM preset, the lint rules and the fixtures.
- **Reading meta in the macro.** `config.meta_get('sources')` reads model meta
  (dbt 1.10+, documented). Reading *column* meta from a model's SQL isn't
  documented; it's normally reached through the `model` node or `graph.nodes`
  (only when `execute`). The spike should confirm this first.
- **Jinja ergonomics.** The partial-match logic is the most complex piece; if
  it's painful in Jinja, generate SQL text in Python/TypeScript instead (option B).
- **Testing.** dbt unit tests (1.8+) fit well: per model, given source rows →
  expected rows, including the same-load and re-add cases above.

## Suggested plan

1. **Decide** column meta placement and which of gaps 1–5 to adopt.
2. **Spike (≈1 day):** `beam_model()` for a single-source dimension with
   `direct` columns and `default`s. Confirms meta access and the shape.
3. Add `combine: union`, `priority`, `path`, CV columns + merge config.
4. Add `completes` with full-grain match, then the partial-match pre-join, with
   dbt unit tests for each case listed above.
5. In this extension: lint rules for the new structured fields, and a
   "Show generated SQL" command that runs `dbt compile -s <model>` for the
   model under the cursor.
