import * as vscode from "vscode";
import { LLMClient, ChatMessage } from "../core/llmClient";
import { getConfig, getModelForCategory } from "../core/config";

/**
 * Inline completion provider — suggests code as you type.
 * Uses Fill-in-the-Middle (FIM) style prompting.
 * Debounced to avoid flooding the model with requests.
 */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRequest: AbortController | undefined;
  private enabled = true;

  constructor() {
    // Check if inline completions are enabled in settings
    this.enabled = vscode.workspace.getConfiguration("explicitAI").get<boolean>("inlineCompletions", true);
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("explicitAI.inlineCompletions")) {
        this.enabled = vscode.workspace.getConfiguration("explicitAI").get<boolean>("inlineCompletions", true);
      }
    });
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!this.enabled) return undefined;

    // Don't complete in certain contexts
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      // Only trigger after typing a character (not on every cursor move)
      const lineText = document.lineAt(position.line).text;
      const charBefore = lineText[position.character - 1];
      if (!charBefore || charBefore === " " && lineText.trim().length === 0) {
        return undefined; // Don't trigger on empty lines
      }
    }

    // Cancel previous request
    this.lastRequest?.abort();

    // Debounce — wait 1500ms after last keystroke (longer to avoid rate limits)
    return new Promise((resolve) => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) { resolve(undefined); return; }

        const result = await this.getCompletion(document, position, token);
        resolve(result);
      }, 1500);
    });
  }

  private async getCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = getConfig();
    const controller = new AbortController();
    this.lastRequest = controller;

    // Build prefix (code before cursor) and suffix (code after cursor)
    const maxPrefixLines = 30;
    const maxSuffixLines = 10;

    const prefixStart = Math.max(0, position.line - maxPrefixLines);
    const prefixRange = new vscode.Range(prefixStart, 0, position.line, position.character);
    const prefix = document.getText(prefixRange);

    const suffixEnd = Math.min(document.lineCount - 1, position.line + maxSuffixLines);
    const suffixRange = new vscode.Range(position.line, position.character, suffixEnd, document.lineAt(suffixEnd).text.length);
    const suffix = document.getText(suffixRange);

    const fileName = vscode.workspace.asRelativePath(document.uri);
    const languageId = document.languageId;

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `You are a code completion engine. Complete the code at the cursor position. Output ONLY the completion text — no explanations, no markdown, no repeating existing code. Just the new code that comes next. Keep it short (1-3 lines max).`
      },
      {
        role: "user",
        content: `File: ${fileName} (${languageId})\n\nCode before cursor:\n${prefix}\n\n[CURSOR - complete from here]\n\nCode after cursor:\n${suffix}`
      }
    ];

    try {
      const llm = new LLMClient();
      const result = await llm.complete({
        model: getModelForCategory("code"),
        messages,
        stream: false,
        temperature: 0.2,
        maxTokens: 128, // Keep completions short
        signal: controller.signal
      });

      if (token.isCancellationRequested) return undefined;

      const completion = result.trim();
      if (!completion || completion.length < 2) return undefined;

      // Don't suggest if it's just repeating what's already there
      const nextChars = suffix.substring(0, completion.length);
      if (completion === nextChars) return undefined;

      return [
        new vscode.InlineCompletionItem(
          completion,
          new vscode.Range(position, position)
        )
      ];
    } catch {
      return undefined;
    }
  }
}
