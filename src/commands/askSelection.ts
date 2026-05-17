import * as vscode from "vscode";
import { ContextBuilder } from "../core/contextBuilder";
import { LLMClient } from "../core/llmClient";
import { getModelForCategory } from "../core/config";
import { showAIResponse } from "../core/responseView";

export async function askSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open a file and select text first.");
    return;
  }

  const text = editor.document.getText(editor.selection).trim();
  if (!text) {
    vscode.window.showWarningMessage("Select some code or text first.");
    return;
  }

  const prompt = await vscode.window.showInputBox({
    prompt: "What do you want to ask about the selection?",
    placeHolder: "Explain, find bugs, refactor..."
  });
  if (!prompt) {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Explicit AI" },
    async () => {
      try {
        const built = ContextBuilder.build({
          userPrompt: prompt,
          pastedContext: text
        });
        const client = new LLMClient();
        const result = await client.completeWithEnglishGuard({
          model: getModelForCategory("code"),
          messages: built.messages,
          stream: false
        });
        await showAIResponse("Selection", result);
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
