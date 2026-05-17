import * as vscode from "vscode";
import { ChatHost } from "../ui/chatHost";

/**
 * "Fix this error" command — grabs diagnostics from the current file/selection
 * and asks the AI to fix them. Designed for quick-fix workflow.
 */
export async function fixDiagnostic(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("No active editor.");
    return;
  }

  const doc = editor.document;
  const fileName = vscode.workspace.asRelativePath(doc.uri);
  const diagnostics = vscode.languages.getDiagnostics(doc.uri);

  if (!diagnostics.length) {
    void vscode.window.showInformationMessage("No diagnostics found in this file.");
    return;
  }

  // If there's a selection, only get diagnostics in that range
  const selection = editor.selection;
  const relevantDiags = selection.isEmpty
    ? diagnostics
    : diagnostics.filter((d) => selection.contains(d.range));

  if (!relevantDiags.length) {
    void vscode.window.showInformationMessage("No diagnostics in the selected range.");
    return;
  }

  // Get the code around each diagnostic for context
  const errorDetails = relevantDiags.slice(0, 5).map((d) => {
    const line = d.range.start.line;
    const startLine = Math.max(0, line - 2);
    const endLine = Math.min(doc.lineCount - 1, line + 2);
    const codeRange = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
    const code = doc.getText(codeRange);
    const severity = d.severity === vscode.DiagnosticSeverity.Error ? "ERROR"
      : d.severity === vscode.DiagnosticSeverity.Warning ? "WARNING" : "INFO";
    return `[${severity}] Line ${line + 1}: ${d.message}\n  Source: ${d.source || "unknown"}\n  Code:\n${code}`;
  });

  const fullFileContent = doc.getText();
  const prompt = `Fix the following ${relevantDiags.length} diagnostic(s) in \`${fileName}\`:

${errorDetails.join("\n\n---\n\n")}

Requirements:
- Provide the corrected code
- Explain what was wrong and why your fix works
- Ensure backward compatibility — don't change the function signatures or public API unless the error requires it
- If the fix might affect other files, mention which ones`;

  if (!ChatHost.current) {
    void vscode.commands.executeCommand("explicitAI.openChat");
    await new Promise((r) => setTimeout(r, 500));
  }

  if (ChatHost.current) {
    const context = `Full file for reference:\n\`\`\`${doc.languageId}\n// ${fileName}\n${fullFileContent}\n\`\`\``;
    void ChatHost.current.session.send(prompt, context, true);
  }
}
