# Vendored: dbt-labs/dbt-jsonschema

`dbt_yml_files-latest.json` is copied unmodified from
https://github.com/dbt-labs/dbt-jsonschema (commit `6a401244651d3b5e0fd2f7cfcfb120187118edb4`,
`schemas/latest/dbt_yml_files-latest.json`), licensed under Apache-2.0
(see `dbt-jsonschema.LICENSE.md`). Copyright dbt Labs, Inc.

The schemas in `../` reference it by its pinned jsDelivr URL:

    https://cdn.jsdelivr.net/gh/dbt-labs/dbt-jsonschema@6a401244651d3b5e0fd2f7cfcfb120187118edb4/schemas/latest/dbt_yml_files-latest.json

The Red Hat YAML extension fetches that URL; YAML Spec Blocks maps it to this
bundled copy, so it works offline and always matches what was tested.

To update: replace the file from a newer commit, update the SHA in the URL in
`../model_spec.schema.yaml`, `../dbt.schema.yaml` and `src/core/vendor.ts`, then `npm test`.
