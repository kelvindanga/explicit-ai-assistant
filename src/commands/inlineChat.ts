import * as vscode from "vscode";
import { LLMClient, ChatMessage } from "../core/llmClient";
import { getConfig, getModelForCategory } from "../core/config";

/**
 * Inline Chat (Cmd+K) — edit code in place with a prompt.
 * Shows an input box, sends the selection + prompt to the AI,
 * then shows a diff preview before applying.
 */
export async function inlineChat(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("No active editor.");
    return;
  }

  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  const selectedText = hasSelection ? editor.document.getText(selection) : "";
  const fileName = vscode.workspace.asRelativePath(editor.document.uri);
  const languageId = editor.document.languageId;

  // Get the surrounding context (5 lines before and after selection)
  const startLine = Math.max(0, selection.start.line - 5);
  const endLine = Math.min(editor.document.lineCount - 1, selection.end.line + 5);
  const surroundingRange = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);
  const surroundingText = editor.document.getText(surroundingRange);

  const placeholder = hasSelection
    ? "What should I do with this code?"
    : "Describe what code to generate here...";

  const prompt = await vscode.window.showInputBox({
    prompt: placeholder,
    placeHolder: "e.g. add error handling, refactor to async, add types...",
    ignoreFocusOut: true
  });

  if (!prompt) return;

  // Show progress
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Generating...", cancellable: true },
    async (progress, token) => {
      const llm = new LLMClient();
      const cfg = getConfig();

      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `You are a code editor. Output ONLY the replacement code — no explanations, no markdown fences, no comments about what you changed. Just the raw code that should replace the selection.`
        },
        {
          role: "user",
          content: hasSelection
            ? `File: ${fileName} (${languageId})\n\nContext:\n\`\`\`${languageId}\n${surroundingText}\n\`\`\`\n\nSelected code to modify:\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\nInstruction: ${prompt}\n\nOutput only the replacement code:`
            : `File: ${fileName} (${languageId})\n\nContext (cursor is at line ${selection.start.line + 1}):\n\`\`\`${languageId}\n${surroundingText}\n\`\`\`\n\nInstruction: ${prompt}\n\nOutput only the new code to insert:`
        }
      ];

      if (token.isCancellationRequested) return;

      try {
        const result = await llm.complete({
          model: getModelForCategory("code"),
          messages,
          stream: false,
          temperature: 0.3,
          maxTokens: 2048
        });

        if (token.isCancellationRequested) return;

        // Clean up the result — strip markdown fences if the model added them
        let cleanResult = result.trim();
        const fenceMatch = cleanResult.match(/^```\w*\n([\s\S]*?)```$/);
        if (fenceMatch) cleanResult = fenceMatch[1].trim();

        // Show diff preview
        await showDiffPreview(editor, selection, hasSelection, cleanResult, fileName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Inline chat failed: ${msg}`);
      }
    }
  );
}

/**
 * Show a diff preview and let the user accept or reject.
 */
async function showDiffPreview(
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  hasSelection: boolean,
  newCode: string,
  fileName: string
): Promise<void> {
  const doc = editor.document;
  const originalText = hasSelection ? doc.getText(selection) : "";

  // Create a temporary document with the proposed change for diff view
  const originalUri = vscode.Uri.parse(`untitled:Original-${fileName}`);
  const proposedUri = vscode.Uri.parse(`untitled:Proposed-${fileName}`);

  // Use a quick pick for accept/reject since diff view is complex in extensions
  const choice = await vscode.window.showQuickPick(
    [
      { label: "✓ Accept", description: "Apply the change", value: "accept" },
      { label: "✕ Reject", description: "Discard the change", value: "reject" },
      { label: "👁 Preview", description: "See the proposed code first", value: "preview" }
    ],
    { placeHolder: `Replace ${hasSelection ? "selection" : "insert at cursor"}?` }
  );

  if (!choice || choice.value === "reject") return;

  if (choice.value === "preview") {
    // Show the proposed code in a preview document
    const previewDoc = await vscode.workspace.openTextDocument({
      content: `// PROPOSED CHANGE for ${fileName}\n// Accept with Ctrl+Shift+Enter, or close to reject\n\n${newCode}`,
      language: doc.languageId
    });
    await vscode.window.showTextDocument(previewDoc, { preview: true, viewColumn: vscode.ViewColumn.Beside });

    // Ask again after preview
    const confirm = await vscode.window.showQuickPick(
      [
        { label: "✓ Accept", value: "accept" },
        { label: "✕ Reject", value: "reject" }
      ],
      { placeHolder: "Apply this change?" }
    );
    if (!confirm || confirm.value === "reject") return;
  }

  // Apply the change
  await editor.edit((editBuilder) => {
    if (hasSelection) {
      editBuilder.replace(selection, newCode);
    } else {
      editBuilder.insert(selection.active, newCode);
    }
  });
}
