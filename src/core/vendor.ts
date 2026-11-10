// Pinned URLs of vendored schemas → bundled file names (schemas/vendor/).
export const DBT_SCHEMA_URL =
  'https://cdn.jsdelivr.net/gh/dbt-labs/dbt-jsonschema@6a401244651d3b5e0fd2f7cfcfb120187118edb4/schemas/latest/dbt_yml_files-latest.json';

export const VENDOR: Record<string, string> = {
  [DBT_SCHEMA_URL]: 'dbt_yml_files-latest.json',
};
