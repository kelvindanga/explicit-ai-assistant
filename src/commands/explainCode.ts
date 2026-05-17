import * as vscode from "vscode";
import { ChatHost } from "../ui/chatHost";

/**
 * "Explain this" command — sends the current selection or entire file
 * to the AI with a prompt asking for explanation.
 * Designed for brownfield: focuses on "what does this do and why?"
 */
export async function explainCode(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("No active editor.");
    return;
  }

  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  const text = hasSelection
    ? editor.document.getText(selection)
    : editor.document.getText();

  const fileName = vscode.workspace.asRelativePath(editor.document.uri);
  const scope = hasSelection ? "the selected code" : `the file \`${fileName}\``;

  const prompt = `Explain ${scope}. Focus on:
1. What it does (high-level purpose)
2. How it works (key logic flow)
3. Why it might be written this way (design decisions, patterns used)
4. Any potential issues or tech debt you notice

Be concise but thorough. If it's complex, break it into sections.`;

  if (!ChatHost.current) {
    void vscode.commands.executeCommand("explicitAI.openChat");
    // Wait for chat to initialize
    await new Promise((r) => setTimeout(r, 500));
  }

  if (ChatHost.current) {
    const context = `\`\`\`${getLanguageId(editor.document)}\n// ${fileName}\n${text}\n\`\`\``;
    void ChatHost.current.session.send(prompt, context, true);
  }
}

function getLanguageId(doc: vscode.TextDocument): string {
  return doc.languageId || "text";
}
