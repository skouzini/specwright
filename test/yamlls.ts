// Validate YAML with the same engine the Red Hat YAML extension uses.
import { readFileSync } from 'fs';
import { getLanguageService } from 'yaml-language-server';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parse } from 'yaml';
import { VENDOR } from '../src/core/vendor';

const files: Record<string, string> = {};
export function serve(uri: string, file: string) { files[uri] = file; }
for (const [url, file] of Object.entries(VENDOR)) serve(url, __dirname + '/../schemas/vendor/' + file);

const ls = getLanguageService({
  schemaRequestService: async (uri: string) => {
    const f = files[uri] ?? (uri.startsWith('file://') ? uri.slice(7) : undefined);
    if (!f) throw new Error('unknown schema ' + uri);
    const text = readFileSync(f, 'utf8');
    return f.endsWith('.json') ? text : JSON.stringify(parse(text));
  },
  workspaceContext: { resolveRelativePath: (rel: string, res: string) => new URL(rel, res).toString() },
} as any);

let n = 0;
export async function validate(schemaFile: string, yamlText: string) {
  const uri = 'file://' + schemaFile;
  ls.configure({ validate: true, completion: true, hover: true, schemas: [{ uri, fileMatch: ['*.yml'] }] } as any);
  const doc = TextDocument.create(`file:///doc${++n}.yml`, 'yaml', 1, yamlText);
  const diags = await ls.doValidation(doc, false);
  return diags.map((d: any) => ({ line: d.range.start.line + 1, msg: String(d.message).replace(/\s+/g, ' ').slice(0, 150) }));
}
