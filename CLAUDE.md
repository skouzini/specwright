# CLAUDE.md

YAML Spec Blocks: VS Code extension for cursor-aware, pre-filled block suggestions in
dbt model YAML, driven by JSON Schemas in `schemas/` (a generic `dbt` preset and the BEAM
`model_spec` preset, both layered on dbt Labs' vendored schema). Read `README.md`
first — it covers architecture, the `x-blocks` / `x-when` / `x-keys` keywords,
and decisions.

## Commands
- `npm install` once
- `npm test` — must pass before any commit (cursor checks for both presets,
  insertion checks, and validation through yaml-language-server)
- `npm run typecheck`
- `npm run package` — builds `yaml-spec-blocks-<version>.vsix`

## Rules of thumb
- Edit `schemas/*.schema.yaml`, never the `.json` copies (generated:
  `npm run schemas`). Never edit `schemas/vendor/` by hand — see its README.
- Keep `src/core/*` free of the `vscode` import so it stays testable in Node.
- New behaviour → add a case to `test/run.ts` (`offers(anchor, indent, typed)`)
  and make sure `test/insert.ts` still reports 0 invalid inserts.
- Block bodies are written relative to column 0; VS Code adds indentation.
- Bump `version` in package.json when shipping a new .vsix.
- Code style: TypeScript strict, 2-space indent, small pure functions.
