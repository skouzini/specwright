import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import { SchemaIndex } from './core/schema';
import { offersAt, Offer } from './core/offers';
import { contextsAt, pathAt, formatPath } from './core/context';
import { lint } from './core/lint';

let index: SchemaIndex | undefined;
let schemaFile = '';
let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;
let ext: vscode.ExtensionContext;

const cfg = () => vscode.workspace.getConfiguration('yamlSpecBlocks');

// ── schema ────────────────────────────────────────────────────────────
function schemaCandidates(): string[] {
  const setting = cfg().get<string>('schemaPath', '').trim();
  const folders = vscode.workspace.workspaceFolders ?? [];
  const out: string[] = [];
  if (setting) {
    if (path.isAbsolute(setting)) out.push(setting);
    else folders.forEach((f) => out.push(path.join(f.uri.fsPath, setting)));
  } else {
    folders.forEach((f) => {
      out.push(path.join(f.uri.fsPath, 'schemas', 'model_spec.schema.yaml'));
      out.push(path.join(f.uri.fsPath, 'schemas', 'model_spec.schema.json'));
    });
  }
  out.push(ext.asAbsolutePath(path.join('schemas', 'model_spec.schema.yaml')));
  return out;
}

function loadSchema(): void {
  for (const file of schemaCandidates()) {
    if (!fs.existsSync(file)) continue;
    try {
      const data = parse(fs.readFileSync(file, 'utf8'));
      index = new SchemaIndex(data);
      schemaFile = file;
      syncJson(file, data);
      return;
    } catch (err) {
      vscode.window.showWarningMessage(`YAML Spec Blocks: couldn't read schema ${file}: ${(err as Error).message}`);
    }
  }
  index = undefined;
}

/** Keep a JSON copy next to a YAML schema, for the Red Hat YAML extension. */
function syncJson(file: string, data: unknown): void {
  if (!cfg().get<boolean>('syncJsonSchema', true)) return;
  if (!/\.ya?ml$/.test(file) || file.startsWith(ext.extensionPath)) return;
  const target = file.replace(/\.ya?ml$/, '.json');
  const json = JSON.stringify(data, null, 2) + '\n';
  try {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== json) fs.writeFileSync(target, json);
  } catch { /* read-only workspace: skip */ }
}

// ── which files ───────────────────────────────────────────────────────
function isTarget(doc: vscode.TextDocument): boolean {
  if (doc.languageId !== 'yaml') return false;
  const pattern = cfg().get<string>('include', '**/models/**/*.{yml,yaml}');
  return vscode.languages.match({ language: 'yaml', pattern }, doc) > 0;
}

// ── completions ───────────────────────────────────────────────────────
function rangeOf(doc: vscode.TextDocument, o: Offer): vscode.Range {
  return new vscode.Range(doc.positionAt(o.ctx.replaceStart), doc.positionAt(o.ctx.replaceEnd));
}

function toItem(doc: vscode.TextDocument, o: Offer, i: number): vscode.CompletionItem {
  const kind = o.kind === 'block' ? vscode.CompletionItemKind.Snippet
    : o.kind === 'entry' ? vscode.CompletionItemKind.Field
    : vscode.CompletionItemKind.Property;
  const item = new vscode.CompletionItem({ label: o.label, description: 'YAML Spec Blocks' }, kind);
  item.detail = o.detail;
  item.documentation = new vscode.MarkdownString().appendCodeblock(o.preview, 'yaml');
  item.insertText = new vscode.SnippetString(o.snippet);
  item.range = rangeOf(doc, o);
  item.filterText = o.ctx.dash + o.label;
  item.sortText = `${o.sort}${String(i).padStart(4, '0')}`;
  item.preselect = i === 0;
  return item;
}

const completionProvider: vscode.CompletionItemProvider = {
  provideCompletionItems(doc, pos) {
    if (!index || !isTarget(doc)) return undefined;
    const offers = offersAt(index, doc.getText(), doc.offsetAt(pos));
    if (!offers.length) return undefined;
    return new vscode.CompletionList(offers.map((o, i) => toItem(doc, o, i)), false);
  },
};

// ── Insert block command (quick pick) ─────────────────────────────────
async function insertBlock(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !index) return;
  const doc = editor.document;
  const offers = offersAt(index, doc.getText(), doc.offsetAt(editor.selection.active));
  if (!offers.length) {
    vscode.window.showInformationMessage(
      'YAML Spec Blocks: nothing fits here. Put the cursor on an empty line, at the indentation where the new key or list item belongs.');
    return;
  }
  const where = formatPath(offers[0].ctx.path);
  const pick = await vscode.window.showQuickPick(
    offers.map((o) => ({
      label: o.label,
      description: o.kind === 'block' ? 'block' : o.kind === 'entry' ? 'entry' : 'key',
      detail: o.detail,
      offer: o,
    })),
    { placeHolder: `Insert at ${where}`, matchOnDetail: true });
  if (!pick) return;
  await editor.insertSnippet(new vscode.SnippetString(pick.offer.snippet), rangeOf(doc, pick.offer));
}

// ── suggest after Enter on a blank line ───────────────────────────────
function maybeSuggest(e: vscode.TextDocumentChangeEvent): void {
  if (!cfg().get<boolean>('suggestOnNewLine', true) || !index) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== e.document || !isTarget(e.document)) return;
  if (!e.contentChanges.some((c) => /^\r?\n[ \t]*$/.test(c.text))) return;
  setTimeout(() => {
    const pos = editor.selection.active;
    if (!editor.document.lineAt(pos.line).isEmptyOrWhitespace) return;
    if (offersAt(index!, editor.document.getText(), editor.document.offsetAt(pos)).length) {
      vscode.commands.executeCommand('editor.action.triggerSuggest');
    }
  }, 0);
}

// ── status bar: where am I ────────────────────────────────────────────
let statusTimer: NodeJS.Timeout | undefined;
function updateStatus(): void {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isTarget(editor.document)) { status.hide(); return; }
    const doc = editor.document;
    const off = doc.offsetAt(editor.selection.active);
    const text = doc.getText();
    let label: string | null = null;
    if (doc.lineAt(editor.selection.active.line).isEmptyOrWhitespace) {
      const ctx = contextsAt(text, off)[0];
      if (ctx) label = `${formatPath(ctx.path)} › ${ctx.kind === 'item' ? 'new item' : 'new key'}`;
    } else {
      const p = pathAt(text, off);
      if (p) label = formatPath(p);
    }
    if (!label) { status.hide(); return; }
    status.text = `$(symbol-structure) ${label}`;
    status.tooltip = `YAML Spec Blocks — click to insert a block here\nSchema: ${schemaFile || 'none found'}`;
    status.show();
  }, 120);
}

// ── diagnostics ───────────────────────────────────────────────────────
const lintTimers = new Map<string, NodeJS.Timeout>();
function refreshDiagnostics(doc: vscode.TextDocument): void {
  if (!isTarget(doc) || !cfg().get<boolean>('lint', true)) { diagnostics.delete(doc.uri); return; }
  const key = doc.uri.toString();
  clearTimeout(lintTimers.get(key));
  lintTimers.set(key, setTimeout(() => {
    const found = lint(doc.getText()).map((f) => {
      const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(f.start), doc.positionAt(f.end)), f.message, vscode.DiagnosticSeverity.Warning);
      d.code = f.code;
      d.source = 'yaml-spec-blocks';
      return d;
    });
    diagnostics.set(doc.uri, found);
  }, 250));
}

// ── activate ──────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext): void {
  ext = context;
  loadSchema();

  diagnostics = vscode.languages.createDiagnosticCollection('yaml-spec-blocks');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'yamlSpecBlocks.insertBlock';

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.schema.{yaml,yml,json}');
  const onSchema = (uri: vscode.Uri) => {
    if (uri.fsPath === schemaFile || schemaCandidates().includes(uri.fsPath)) loadSchema();
  };

  context.subscriptions.push(
    diagnostics, status, watcher,
    watcher.onDidChange(onSchema), watcher.onDidCreate(onSchema), watcher.onDidDelete(onSchema),
    vscode.languages.registerCompletionItemProvider({ language: 'yaml' }, completionProvider, '-'),
    vscode.commands.registerCommand('yamlSpecBlocks.insertBlock', insertBlock),
    vscode.commands.registerCommand('yamlSpecBlocks.reloadSchema', () => {
      loadSchema();
      vscode.window.showInformationMessage(index ? `YAML Spec Blocks: using ${schemaFile}` : 'YAML Spec Blocks: no schema found');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('yamlSpecBlocks')) {
        loadSchema();
        vscode.workspace.textDocuments.forEach(refreshDiagnostics);
      }
    }),
    vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) => { refreshDiagnostics(e.document); maybeSuggest(e); }),
    vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)),
    vscode.window.onDidChangeTextEditorSelection(updateStatus),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
  );

  vscode.workspace.textDocuments.forEach(refreshDiagnostics);
  updateStatus();
}

export function deactivate(): void {}
