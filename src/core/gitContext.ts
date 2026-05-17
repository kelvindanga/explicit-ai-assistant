import * as vscode from "vscode";
import * as child_process from "child_process";
import * as util from "util";

const execAsync = util.promisify(child_process.exec);

/**
 * Get the current git diff (staged + unstaged) for the workspace.
 * Returns empty string if not a git repo or git is unavailable.
 */
export async function getGitDiff(): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return "";
  }

  try {
    // Get both staged and unstaged changes
    const [unstaged, staged] = await Promise.all([
      execAsync("git diff", { cwd: root, maxBuffer: 512 * 1024 }).catch(() => ({ stdout: "" })),
      execAsync("git diff --cached", { cwd: root, maxBuffer: 512 * 1024 }).catch(() => ({ stdout: "" }))
    ]);

    const parts: string[] = [];
    if (staged.stdout.trim()) {
      parts.push("=== Staged changes ===\n" + staged.stdout.trim());
    }
    if (unstaged.stdout.trim()) {
      parts.push("=== Unstaged changes ===\n" + unstaged.stdout.trim());
    }

    return parts.join("\n\n");
  } catch {
    return "";
  }
}

/**
 * Get a short summary of changed files.
 */
export async function getGitStatus(): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return "";
  }

  try {
    const { stdout } = await execAsync("git status --short", { cwd: root, maxBuffer: 64 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}
