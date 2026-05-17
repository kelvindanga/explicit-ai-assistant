import * as vscode from "vscode";
import { ChatHost } from "../ui/chatHost";
import { getStackContext } from "../core/stackDetector";

/**
 * "Ask about workspace" command — lets you ask questions about the codebase.
 * Gathers relevant context (stack info, file structure) to help the AI
 * answer questions like "where is auth handled?" or "how does the payment flow work?"
 */
export async function askWorkspace(): Promise<void> {
  const question = await vscode.window.showInputBox({
    prompt: "Ask about your codebase",
    placeHolder: "e.g. Where is authentication handled? How does the API routing work?"
  });
  if (!question) return;

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showWarningMessage("No workspace folder open.");
    return;
  }

  // Gather context: stack info + workspace file structure
  const stackContext = await getStackContext();

  // Get a file tree (top-level + src structure)
  const fileTree = await getWorkspaceTree(root);

  const prompt = `${question}

I'm working in a brownfield project. Help me understand the codebase.

If you need to see specific files to answer accurately, tell me which ones to attach.
Be specific about file paths and function names in your answer.`;

  const context = [
    stackContext ? `Project stack:\n${stackContext}` : "",
    fileTree ? `File structure:\n${fileTree}` : ""
  ].filter(Boolean).join("\n\n");

  if (!ChatHost.current) {
    void vscode.commands.executeCommand("explicitAI.openChat");
    await new Promise((r) => setTimeout(r, 500));
  }

  if (ChatHost.current) {
    void ChatHost.current.session.send(prompt, context, true);
  }
}

async function getWorkspaceTree(root: string): Promise<string> {
  try {
    const rootUri = vscode.Uri.file(root);
    const entries = await vscode.workspace.fs.readDirectory(rootUri);

    const lines: string[] = [];
    const ignore = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".cache"]);

    for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
      if (ignore.has(name) || name.startsWith(".")) continue;
      if (type === vscode.FileType.Directory) {
        lines.push(`📁 ${name}/`);
        // One level deep for key directories
        if (["src", "app", "pages", "components", "lib", "api", "server", "services"].includes(name)) {
          try {
            const subUri = vscode.Uri.joinPath(rootUri, name);
            const subEntries = await vscode.workspace.fs.readDirectory(subUri);
            for (const [subName, subType] of subEntries.sort((a, b) => a[0].localeCompare(b[0]))) {
              const icon = subType === vscode.FileType.Directory ? "📁" : "📄";
              lines.push(`  ${icon} ${name}/${subName}`);
            }
          } catch { /* skip */ }
        }
      } else {
        lines.push(`📄 ${name}`);
      }
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}
