import * as vscode from "vscode";
import { ContextBuilder } from "../core/contextBuilder";
import { LLMClient } from "../core/llmClient";
import { getModelForCategory } from "../core/config";
import { showAIResponse } from "../core/responseView";

export async function askManual(): Promise<void> {
  const prompt = await vscode.window.showInputBox({
    prompt: "Ask AI (no automatic context)",
    placeHolder: "Your question..."
  });
  if (!prompt) {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Explicit AI" },
    async () => {
      try {
        const built = ContextBuilder.build({ userPrompt: prompt });
        const client = new LLMClient();
        const result = await client.completeWithEnglishGuard({
          model: getModelForCategory("chat"),
          messages: built.messages,
          stream: false
        });
        await showAIResponse("Manual prompt", result);
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
