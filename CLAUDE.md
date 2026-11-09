# CLAUDE.md

YAML Spec Blocks: VS Code extension for cursor-aware, pre-filled block suggestions in
dbt model YAML, driven by `schemas/model_spec.schema.yaml`. Read `README.md`
first — it covers architecture, the `x-blocks` / `x-when` / `x-keys` keywords,
and decisions.

## Commands
- `npm install` once
- `npm test` — must pass before any commit (engine checks + insertion checks)
- `npm run typecheck`
- `npm run package` — builds `yaml-spec-blocks-<version>.vsix`

## Rules of thumb
- Edit `schemas/model_spec.schema.yaml`, never the `.json` (it's generated;
  regenerate with
  `node -e "const y=require('yaml'),fs=require('fs');fs.writeFileSync('schemas/model_spec.schema.json',JSON.stringify(y.parse(fs.readFileSync('schemas/model_spec.schema.yaml','utf8')),null,2)+'\n')"`).
- Keep `src/core/*` free of the `vscode` import so it stays testable in Node.
- New behaviour → add a case to `test/run.ts` (`offers(anchor, indent, typed)`)
  and make sure `test/insert.ts` still reports 0 invalid inserts.
- Block bodies are written relative to column 0; VS Code adds indentation.
- Bump `version` in package.json when shipping a new .vsix.
- Code style: TypeScript strict, 2-space indent, small pure functions.
