import * as vscode from "vscode";
import { LLMClient, ChatMessage } from "../core/llmClient";
import { getConfig, getModelForCategory } from "../core/config";

/**
 * Auto-fix loop — detects diagnostics, asks AI to fix, applies, re-checks.
 * Runs up to 3 iterations to resolve cascading errors.
 */
export async function autoFixLoop(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("No active editor.");
    return;
  }

  const doc = editor.document;
  const fileName = vscode.workspace.asRelativePath(doc.uri);
  const maxIterations = 3;
  let iteration = 0;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Auto-fixing...", cancellable: true },
    async (progress, token) => {
      while (iteration < maxIterations) {
        if (token.isCancellationRequested) break;

        // Get current diagnostics
        const diagnostics = vscode.languages.getDiagnostics(doc.uri)
          .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);

        if (diagnostics.length === 0) {
          void vscode.window.showInformationMessage(
            iteration === 0
              ? "No errors found in this file."
              : `✓ All errors fixed after ${iteration} iteration(s).`
          );
          return;
        }

        iteration++;
        progress.report({ message: `Iteration ${iteration}/${maxIterations} — ${diagnostics.length} error(s)` });

        // Build context with errors and surrounding code
        const errorDetails = diagnostics.slice(0, 5).map((d) => {
          const line = d.range.start.line;
          const startLine = Math.max(0, line - 2);
          const endLine = Math.min(doc.lineCount - 1, line + 2);
          const codeRange = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
          const code = doc.getText(codeRange);
          return `Line ${line + 1}: ${d.message} (${d.source || ""})\n\`\`\`\n${code}\n\`\`\``;
        }).join("\n\n");

        const fullContent = doc.getText();
        // Only send first 3000 chars of file to avoid context overflow
        const filePreview = fullContent.length > 3000
          ? fullContent.substring(0, 3000) + "\n... (file truncated)"
          : fullContent;

        const messages: ChatMessage[] = [
          {
            role: "system",
            content: `You are a code fixer. Output the COMPLETE fixed file content — no explanations, no markdown fences. Just the corrected source code. Fix ALL the errors listed below.`
          },
          {
            role: "user",
            content: `File: ${fileName} (${doc.languageId})\n\nErrors to fix:\n${errorDetails}\n\nFull file:\n\`\`\`${doc.languageId}\n${filePreview}\n\`\`\`\n\nOutput the complete fixed file:`
          }
        ];

        try {
          const llm = new LLMClient();
          const result = await llm.complete({
            model: getModelForCategory("code"),
            messages,
            stream: false,
            temperature: 0.2,
            maxTokens: 4096
          });

          if (token.isCancellationRequested) break;

          // Clean up result
          let fixedCode = result.trim();
          const fenceMatch = fixedCode.match(/^```\w*\n([\s\S]*?)```$/);
          if (fenceMatch) fixedCode = fenceMatch[1];

          // Apply the fix
          const fullRange = new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
          await editor.edit((editBuilder) => {
            editBuilder.replace(fullRange, fixedCode);
          });
          await doc.save();

          // Wait a moment for diagnostics to update
          await new Promise((r) => setTimeout(r, 1500));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Auto-fix failed: ${msg}`);
          return;
        }
      }

      // Check if errors remain after max iterations
      const remaining = vscode.languages.getDiagnostics(doc.uri)
        .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
      if (remaining.length > 0) {
        void vscode.window.showWarningMessage(
          `Auto-fix completed ${maxIterations} iterations but ${remaining.length} error(s) remain.`
        );
      }
    }
  );
}
