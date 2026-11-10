# YAML Spec Blocks

[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/skouzini)

*Formerly **Specwright** (renamed in 0.2.0 to avoid clashing with several unrelated "Specwright" projects).*

A VS Code extension that suggests the right YAML block for where your cursor
is in a dbt property file, fills it in from the model you're editing, and flags
cross-reference mistakes the JSON Schema can't catch.

It is driven by a JSON Schema extended with a few `x-` keywords that describe
the insertable blocks. Two schemas ship with it, both layered on
[dbt Labs' own schema](https://github.com/dbt-labs/dbt-jsonschema) for dbt
property files:

| Preset | File | For |
|---|---|---|
| `dbt` (default) | `schemas/dbt.schema.yaml` | Any dbt project — standard dbt validation plus blocks for models, columns, tests and sources |
| `beam` | `schemas/model_spec.schema.yaml` | dbt models that follow the BEAM*/Kimball model spec — adds required keys, naming, and the structure of `config.meta` / column `meta` |

A `schemas/model_spec.schema.yaml` (or any schema you point it at) in your
workspace takes precedence over both.

---

## Why this exists

Model YAML follows a spec written in the style of Snowflake's docs
(`{ a | b }` choices, `[ optional ]`, `{{ pattern }}` sections). Writing it by
hand means remembering which blocks are required in which situation:
`definitions` needs one entry per source, `combine: union` only with 2+ sources,
`fact_type` and `additivity` only on facts, `completes` requires `match`, and so
on. YAML Spec Blocks puts that knowledge in the editor:

| Need | Where it's handled |
|---|---|
| Standard dbt keys (`config`, `access`, `data_tests`, `versions`…) | dbt Labs' schema (vendored, `schemas/vendor/`) → Red Hat YAML extension |
| Spec shape, enums, required keys, simple conditionals | Our schema layer → Red Hat YAML extension |
| "What can go here?" + pre-filled blocks | YAML Spec Blocks completions (`x-blocks`, `x-when`, `x-keys`) |
| Rules that compare one part of a file with another | YAML Spec Blocks diagnostics (`src/core/lint.ts`) |
| Judgment calls (is this filter intent clear?) | Human / agent review — out of scope |

## Using it

### Install
1. `npm install && npm run package` → `yaml-spec-blocks-0.2.0.vsix`
   (a built copy may already be in the folder; it's git-ignored).
2. VS Code → Extensions → `…` → **Install from VSIX**.
3. Pick a schema:
   - **Plain dbt project:** nothing to do — the `dbt` preset is used.
   - **BEAM model spec:** copy `schemas/model_spec.schema.yaml` into the dbt repo's
     `schemas/` folder (found automatically, reloaded on save, `.json` copy
     written next to it), or set `"yamlSpecBlocks.preset": "beam"`.
4. For validation underlines, install **YAML** (Red Hat) and map the schema in
   the dbt repo's `.vscode/settings.json`:
   ```json
   "yaml.schemas": { "./schemas/model_spec.schema.json": ["models/**/_*.yml"] }
   ```
   The schema pulls in dbt Labs' schema by a pinned jsDelivr URL, which the Red
   Hat extension downloads once (needs network). For a plain dbt project, map
   dbt Labs' schema directly — see [their README](https://github.com/dbt-labs/dbt-jsonschema).

### Day to day
- Put the cursor on an **empty line, at the indentation where the new key or
  list item belongs**, then press Enter (suggestions open automatically) or
  Ctrl+Space. You only get blocks/keys that fit there and aren't already present.
- **Insert Block Here**: Ctrl+Alt+Enter (Cmd+Alt+Enter on Mac), or click the
  path shown in the status bar (e.g. `models[0] › columns[2] › meta`).
- Warnings appear in the Problems panel:
  - `SW001` a column's `definitions` is missing a source
  - `SW002` `definitions` names a source not in the model
  - `SW003` `completes` names a source not in the model (or itself)

### Settings
| Setting | Default | |
|---|---|---|
| `yamlSpecBlocks.schemaPath` | `""` | Schema file; empty = `schemas/model_spec.schema.yaml` / `.json` in the workspace, else the bundled preset |
| `yamlSpecBlocks.preset` | `dbt` | Bundled schema when the workspace has none: `dbt` or `beam` |
| `yamlSpecBlocks.include` | `**/models/**/*.{yml,yaml}` | Which YAML files YAML Spec Blocks works in |
| `yamlSpecBlocks.suggestOnNewLine` | `true` | Open suggestions after Enter when something fits |
| `yamlSpecBlocks.lint` | `true` | Cross-reference warnings |
| `yamlSpecBlocks.syncJsonSchema` | `true` | Keep `model_spec.schema.json` in sync with the YAML schema |

---

## How it works

```
cursor ──► context.ts ──► schema.ts ──► offers.ts ──► template.ts ──► VS Code snippet
           "where am I"    "what does     "what fits,     "fill from the
                            the schema     given the       current model"
                            say here"      model's facts"
```

1. **Where is the cursor?** (`src/core/context.ts`)
   The cursor is usually on a blank or half-typed line, which YAML can't place.
   So we temporarily write a marker (`__yaml_spec_blocks_cursor__: 0`) on that line —
   once as a new key, once as a new list item (`- __yaml_spec_blocks_cursor__: 0`) —
   parse with the `yaml` package, and see where the marker landed. Whichever
   attempt parses cleanly gives a context:
   - `key` context: the path of the map the new key goes into, plus its existing keys
   - `item` context: the path of the list the new item goes into
   Consequence: **the rest of the file must be valid YAML** for suggestions to appear.

2. **What does the schema say there?** (`src/core/schema.ts`)
   `SchemaIndex.atAll(path)` walks the schema by document path and returns
   **every** schema that applies there — ours and dbt Labs' — following `$ref`
   (also into other documents: the dbt schema's URL is mapped to the bundled copy
   by `src/core/vendor.ts`, so nothing is fetched), keeping sibling keywords like
   `x-when` on the referring node, and expanding `allOf` / `anyOf` / `oneOf`
   branches and `additionalProperties`. Offers merge the layers; where both define
   a key, ours comes first (so its `x-when` / `x-hide` / blocks win).

3. **What fits?** (`src/core/offers.ts`)
   - `item` context → the list's item schema `x-blocks`, each prefixed with `- `.
   - `key` context →
     - the map's own `x-blocks`, if the map is empty;
     - for `x-keys` maps (`definitions`): one entry per source not yet listed;
     - every property not already present, filtered by `x-when`. A property
       with `x-blocks` is offered with its block as the value; an array property
       whose items have `x-blocks` gets `key:` + a first item; otherwise an enum
       dropdown, the const value, or a plain tab stop.
   Sorted: blocks, then required keys, then optional keys.
   "Facts" for `x-when` and filling come from the **current model** —
   `models[i]` where `i` is taken from the cursor path (`modelVars`).

4. **Fill it in** (`src/core/template.ts`) — see the template syntax below.
   Output is a VS Code snippet (tab stops, dropdowns) plus a plain preview for the
   completion's documentation pane. VS Code adds the insertion line's
   indentation to each later line, so blocks are written relative to column 0.

5. **Lint** (`src/core/lint.ts`) parses with `yaml` and reports source-offset
   ranges, so diagnostics underline the exact key.

`src/extension.ts` is the only file that touches the VS Code API: schema
loading/watching, completion provider, the Insert Block quick pick, the status
bar, auto-suggest on Enter, and diagnostics.

## The schema's YAML Spec Blocks keywords

Validators ignore unknown keywords, so these don't affect validation.

**`x-blocks`** — list of blocks that can be inserted as a *value* of this schema.
```yaml
x-blocks:
  - label: Source (completes another source)   # shown in the list
    detail: Records a later event for another source's rows
    x-when: { source_count: { min: 1 } }        # optional
    inline: false                               # true = scalar, goes after "key: "
    body: |
      name: <source_label>
      completes: <source>
```
Template syntax in `body`:

| Write | Becomes |
|---|---|
| `<name>` | tab stop with default text `name` |
| `<a\|b\|c>` | tab stop with a dropdown of choices |
| `<source>` at the **start of a line** | that line + lines indented under it, repeated once per source |
| `<source>` **anywhere else** | dropdown of the model's sources (literal if only one) |
| `[[<grain_column>, ...]]` | flow list `[A, B, C]` of the bound values |

Bound variables (from the current model): `source` (source names),
`column` (column names), `grain_column` (grain test columns) — lists;
`model_name`, `table_type` — single values. Unbound or empty → ordinary tab stop.
Each repeated copy gets its own tab stops.

**`x-when`** — on a block or a property; all conditions must hold. Unknown
facts (e.g. `table_type` not set yet) don't block.
```yaml
x-when:
  table_type: fact            # or dimension
  source_count: { min: 2 }    # min and/or max
  absent: [source, transform] # none of these keys in the current map
```

**`x-keys`** — on a map whose keys are bound values (`definitions: x-keys: source`):
inside that map, offer one entry per missing value, using
`additionalProperties`' blocks as the entry body.

**`x-hide: true`** — on a property: never suggest it (still validated). Used to
hide dbt's legacy `tests` key (superseded by `data_tests`) and, in the BEAM
preset, model-level `meta` (the spec keeps it under `config.meta`).

Also bound: `model` — every model name in the file (used by the `relationships`
test block). dbt's schema doesn't list `unique_key`, `incremental_strategy`,
`merge_update_columns`, `alias`, `schema`, `enabled` or `tags` under model
`config` (it accepts them anyway), so both presets declare them so they're suggested.

To add a block: add an `x-blocks` entry in the right `$defs` node, save — YAML Spec Blocks reloads.

## Project layout

```
schemas/
  dbt.schema.yaml          generic preset (edit the .yaml; .json is generated)
  model_spec.schema.yaml   BEAM preset
  *.schema.json            generated copies for the Red Hat YAML extension
  vendor/                  dbt Labs' dbt_yml_files schema (Apache-2.0), pinned — see vendor/README.md
src/
  extension.ts             VS Code wiring
  core/
    context.ts             cursor → structural context (marker trick), pathAt for the status bar
    schema.ts              $ref/branch-aware schema walker
    offers.ts              context + schema + model facts → offers
    template.ts            block body → snippet (placeholders, repeats, dropdowns)
    lint.ts                SW001–SW003
    vendor.ts              pinned URLs of vendored schemas → bundled files
test/
  run.ts                   BEAM preset: checks at specific cursor positions
  insert.ts                applies every offer like VS Code would; asserts YAML stays valid
  dbt.ts                   generic dbt preset: cursor checks
  validate.ts              validation through yaml-language-server (the Red Hat extension's engine)
  yamlls.ts, loader.ts     test helpers
  fixtures/                subscriptions.yml (2-source fact), dim_customer.yml (1-source dimension),
                           bad_model.yml (one violation per rule), plain_dbt.yml (generic dbt)
```
`src/core` has no VS Code dependency, so it is testable with plain Node.

## Development

```bash
npm install
npm test            # cursor checks (both presets), insertion checks, validation via yaml-language-server
npm run typecheck
npm run build       # esbuild → dist/extension.js
npm run package     # → yaml-spec-blocks-<version>.vsix
```
To debug inside VS Code: open this folder, press F5 with a launch config of
type `extensionHost` (not included yet), and open a model file in the
Extension Development Host window.

Test pattern: `test/run.ts` puts the cursor on a new line after an anchor
string at a given indentation (`offers(anchor, indent, typed)`), then asserts on
offer labels / snippet text. Add a case there for every new behaviour.

## Decisions (and why)

- **JSON Schema + extensions, not a custom spec language.** Standard tooling
  (validators, Red Hat YAML, `check-jsonschema`) works for free; YAML Spec Blocks adds
  only what JSON Schema can't express.
- **Layer on dbt Labs' schema, not Fivetran's.** `fivetran/dbt_yaml_schemas` was
  last updated in 2022 and doesn't know `data_tests`, `constraints`,
  `deprecation_date`, `contract`, `versions`, `access` or `group`.
  `dbt-labs/dbt-jsonschema` is maintained (synced with dbt Fusion), Apache-2.0, and
  leaves `meta` open — exactly where the BEAM conventions live. It's vendored at a
  pinned commit so tests and the extension are deterministic and work offline.
- **Our layer is strict only where it owns the shape** (`config.meta`, column
  `meta`, sources, review). Model, column and `config` objects are left open so
  dbt's schema decides which standard keys are allowed.
- **Blocks in `x-blocks`, not `defaultSnippets`.** The Red Hat extension shows
  `defaultSnippets` itself, unfilled, which duplicated every suggestion.
- **`definitions` vs `source`+`transform` is about where the value comes from,
  not the number of sources.** `definitions` = read from raw data (one entry per
  source, even with one source); `source` + `transform` = derived from model
  columns or `generated`. The schema enforces exactly one of the two.
- **Marker-based cursor context** instead of indentation heuristics: it uses the
  real YAML parser, so compact lists, flow collections and comments behave.
- **`match_pick` requires `match`** in the schema. The written spec only says it's
  relevant with `match`; delete `match_pick: [match]` under `dependentRequired`
  if that's too strict.
- Model names are UPPER_SNAKE, source labels lower_snake, tables 3-part,
  column paths 4-part — one line each in `$defs` if conventions differ.

## Known limits / ideas

- Suggestions need the rest of the file to parse. Possible fix: fall back to
  an indentation-based context when parsing fails.
- Only one level of repeat in templates (no repeat inside a repeat).
- Not enforced anywhere yet (needs lint rules):
  - `match` with fewer columns than the grain → a match uniqueness test must
    exist (needs `match` split into structured `columns` / `where`)
  - fact primary key columns == grain test columns
  - `where:` on the grain test for dimensions only
  - `default_value` required except on QA columns (needs a column role)
- Quick fixes: "add missing definitions entries" for SW001.
- No `.vscode/launch.json` yet for F5 debugging.
- Uses dbt Labs' `latest` (dbt Core) schema. A `latest_fusion` variant exists
  (larger, `definitions`-based, includes column `config`); a preset for it would
  be a small addition if you move to Fusion.
- The Red Hat extension downloads dbt's schema by URL; behind a firewall that
  blocks jsDelivr, point the `$ref` at a local copy of `vendor/…json` instead.
- Origin: a Claude Design prototype ("Specwright" canvas) explored the
  fill-from-file idea with `<placeholder>` templates; this extension replaces
  its line-regex parsing with schema- and path-aware logic.

## Support

If YAML Spec Blocks saves you time, you can buy me a coffee on [Ko-fi](https://ko-fi.com/skouzini).

## License

[MIT](LICENSE) © 2026 Josh Skousen
