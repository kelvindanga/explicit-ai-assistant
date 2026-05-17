import * as vscode from "vscode";
import { ContextBuilder } from "../core/contextBuilder";
import { readFileFromPath } from "../core/fileAttachments";
import { LLMClient } from "../core/llmClient";
import { getModelForCategory } from "../core/config";
import { showAIResponse } from "../core/responseView";

export async function sendFile(): Promise<void> {
  const files = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Analyze with Explicit AI"
  });
  if (!files?.length) {
    return;
  }

  const prompt = await vscode.window.showInputBox({
    prompt: `Ask about: ${files[0].fsPath.split(/[/\\]/).pop()}`,
    placeHolder: "Summarize, review, explain..."
  });
  if (!prompt) {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Explicit AI" },
    async () => {
      try {
        const attached = await readFileFromPath(files[0].fsPath);
        const built = ContextBuilder.build({
          userPrompt: prompt,
          files: [attached]
        });
        const client = new LLMClient();
        const result = await client.completeWithEnglishGuard({
          model: getModelForCategory("code"),
          messages: built.messages,
          stream: false
        });
        await showAIResponse(attached.name, result);
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
