import * as vscode from "vscode";
import { ChatHost } from "../ui/chatHost";

/**
 * "Generate Documentation" command — adds JSDoc/TSDoc comments to all
 * exported functions, classes, and interfaces in the current file.
 * Essential for brownfield: document what exists before changing it.
 */
export async function generateDocs(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("No active editor.");
    return;
  }

  const doc = editor.document;
  const fileName = vscode.workspace.asRelativePath(doc.uri);
  const selection = editor.selection;
  const code = selection.isEmpty ? doc.getText() : doc.getText(selection);
  const scope = selection.isEmpty ? "all exports" : "the selected code";

  const prompt = `Generate documentation for ${scope} in \`${fileName}\`.

Requirements:
- Add JSDoc/TSDoc comments to every exported function, class, interface, and type
- Include @param, @returns, @throws, @example where appropriate
- Document non-obvious behavior, side effects, and assumptions
- For complex functions, add a brief "How it works" note
- Preserve the existing code exactly — only add documentation comments
- If a function has unclear naming, suggest a better name in a comment
- Output the complete file with documentation added (so I can use "Apply")

Style:
- Be concise but informative
- Focus on "why" not just "what" (the code shows what, docs should explain why)
- Note any backward compatibility concerns in @remarks`;

  if (!ChatHost.current) {
    void vscode.commands.executeCommand("explicitAI.openChat");
    await new Promise((r) => setTimeout(r, 500));
  }

  if (ChatHost.current) {
    const context = `\`\`\`${doc.languageId}\n// ${fileName}\n${code}\n\`\`\``;
    void ChatHost.current.session.send(prompt, context, true);
  }
}
