import * as vscode from "vscode";

export async function showAIResponse(title: string, content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content,
    language: "markdown"
  });
  await vscode.window.showTextDocument(doc, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside
  });
  vscode.window.setStatusBarMessage(`Explicit AI: ${title}`, 3000);
}
