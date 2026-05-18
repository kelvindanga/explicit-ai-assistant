import * as vscode from "vscode";
import * as path from "path";

/**
 * Diff preview system — shows proposed changes as a VS Code diff view
 * before applying them. Supports multi-file changes with accept/reject per file.
 */

export interface ProposedChange {
  filePath: string;
  relativePath: string;
  originalContent: string;
  proposedContent: string;
  isNew: boolean; // true if file doesn't exist yet
}

const SCHEME = "explicit-ai-diff";
let diffContentProvider: DiffContentProvider | undefined;

class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  onDidChangeTextDocument = this._onDidChange.event;

  // Required by the interface
  get onDidChange() { return this._onDidChange.event; }

  setContent(uri: string, content: string): void {
    this.contents.set(uri, content);
    this._onDidChange.fire(vscode.Uri.parse(uri));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  clear(): void {
    this.contents.clear();
  }
}

export function registerDiffProvider(context: vscode.ExtensionContext): void {
  diffContentProvider = new DiffContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, diffContentProvider)
  );
}

/**
 * Show a diff preview for a single file change.
 * Returns true if the user accepted, false if rejected.
 */
export async function showDiff(change: ProposedChange): Promise<boolean> {
  if (!diffContentProvider) return true; // No provider registered, just apply

  const originalUri = vscode.Uri.parse(`${SCHEME}:original/${change.relativePath}`);
  const proposedUri = vscode.Uri.parse(`${SCHEME}:proposed/${change.relativePath}`);

  diffContentProvider.setContent(originalUri.toString(), change.originalContent);
  diffContentProvider.setContent(proposedUri.toString(), change.proposedContent);

  const title = change.isNew
    ? `New: ${change.relativePath}`
    : `Changes: ${change.relativePath}`;

  await vscode.commands.executeCommand("vscode.diff", originalUri, proposedUri, title, {
    preview: true
  });

  // Ask user to accept or reject
  const choice = await vscode.window.showInformationMessage(
    `Apply changes to ${change.relativePath}?`,
    { modal: false },
    "✓ Accept",
    "✕ Reject"
  );

  // Close the diff tab
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  return choice === "✓ Accept";
}

/**
 * Show a multi-file change summary and let user accept/reject each.
 * Returns the list of accepted changes.
 */
export async function showMultiFileDiff(changes: ProposedChange[]): Promise<ProposedChange[]> {
  if (changes.length === 0) return [];
  if (changes.length === 1) {
    const accepted = await showDiff(changes[0]);
    return accepted ? changes : [];
  }

  // Show a quick pick with all files
  const items = changes.map((c) => ({
    label: c.isNew ? "$(new-file) " + c.relativePath : "$(edit) " + c.relativePath,
    description: c.isNew ? "New file" : `${countChangedLines(c.originalContent, c.proposedContent)} lines changed`,
    picked: true,
    change: c
  }));

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `${changes.length} file(s) to modify. Select which to apply:`,
    title: "Proposed Changes"
  });

  if (!selected) return []; // User cancelled

  // Optionally show diff for each selected file
  const viewDiff = await vscode.window.showQuickPick(
    [
      { label: "Apply all selected", value: "apply" },
      { label: "Review each diff first", value: "review" }
    ],
    { placeHolder: `${selected.length} file(s) selected` }
  );

  if (!viewDiff) return [];

  if (viewDiff.value === "review") {
    const accepted: ProposedChange[] = [];
    for (const item of selected) {
      const ok = await showDiff(item.change);
      if (ok) accepted.push(item.change);
    }
    return accepted;
  }

  return selected.map((s) => s.change);
}

function countChangedLines(original: string, proposed: string): number {
  const origLines = original.split("\n");
  const propLines = proposed.split("\n");
  let changed = 0;
  const maxLen = Math.max(origLines.length, propLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (origLines[i] !== propLines[i]) changed++;
  }
  return changed;
}
