import * as vscode from "vscode";
import { ChatHost } from "../ui/chatHost";
import { detectStack } from "../core/stackDetector";

/**
 * "Generate tests" command — creates tests for the current file or selection.
 * Supports two modes:
 * - Standard: generate unit tests for the code
 * - Snapshot: capture current behavior (for brownfield refactoring safety)
 */
export async function generateTests(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("No active editor.");
    return;
  }

  const mode = await vscode.window.showQuickPick(
    [
      { label: "Unit Tests", description: "Generate standard unit tests", value: "unit" },
      { label: "Behavior Snapshot", description: "Capture current behavior before refactoring", value: "snapshot" }
    ],
    { placeHolder: "What kind of tests?" }
  );
  if (!mode) return;

  const doc = editor.document;
  const fileName = vscode.workspace.asRelativePath(doc.uri);
  const selection = editor.selection;
  const code = selection.isEmpty ? doc.getText() : doc.getText(selection);

  const stack = await detectStack();
  const testFramework = stack?.testFramework || "Jest";
  const language = stack?.language || "TypeScript";

  let prompt: string;

  if (mode.value === "snapshot") {
    prompt = `Generate behavior snapshot tests for the following code from \`${fileName}\`.

Purpose: Capture the CURRENT behavior exactly as-is, so I can safely refactor without breaking anything.

Requirements:
- Use ${testFramework} with ${language}
- Test every exported function/class/method
- Cover edge cases and current quirks (even if they seem like bugs — they might be relied upon)
- Use descriptive test names that document what the code currently does
- Include comments like "// Current behavior: ..." to document potentially surprising behavior
- Do NOT fix bugs in tests — capture them as "this is what it does now"
- Suggest a file path for the test file following project conventions`;
  } else {
    prompt = `Generate comprehensive unit tests for the following code from \`${fileName}\`.

Requirements:
- Use ${testFramework} with ${language}
- Test happy paths, edge cases, and error conditions
- Mock external dependencies appropriately
- Use descriptive test names
- Group related tests with describe blocks
- Aim for high coverage of the logic branches
- Suggest a file path for the test file following project conventions`;
  }

  if (!ChatHost.current) {
    void vscode.commands.executeCommand("explicitAI.openChat");
    await new Promise((r) => setTimeout(r, 500));
  }

  if (ChatHost.current) {
    const context = `\`\`\`${doc.languageId}\n// ${fileName}\n${code}\n\`\`\``;
    void ChatHost.current.session.send(prompt, context, true);
  }
}
