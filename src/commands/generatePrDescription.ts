import * as vscode from "vscode";
import * as child_process from "child_process";
import * as util from "util";
import { ChatHost } from "../ui/chatHost";
import { getGitDiff } from "../core/gitContext";

const execAsync = util.promisify(child_process.exec);

/**
 * "Generate PR Description" command — creates a PR description from
 * the current git diff + recent commits. Includes breaking change detection.
 */
export async function generatePrDescription(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showWarningMessage("No workspace folder open.");
    return;
  }

  // Get the diff
  const diff = await getGitDiff();
  if (!diff) {
    void vscode.window.showWarningMessage("No git changes detected.");
    return;
  }

  // Get recent commit messages (for context on what branch is about)
  let recentCommits = "";
  try {
    const { stdout } = await execAsync(
      "git log --oneline -10 --no-merges",
      { cwd: root, maxBuffer: 64 * 1024 }
    );
    recentCommits = stdout.trim();
  } catch { /* ignore */ }

  // Get branch name
  let branchName = "";
  try {
    const { stdout } = await execAsync("git branch --show-current", { cwd: root });
    branchName = stdout.trim();
  } catch { /* ignore */ }

  const prompt = `Generate a pull request description for the following changes.

Branch: ${branchName || "(unknown)"}

Recent commits on this branch:
${recentCommits || "(no commits yet)"}

Requirements:
1. Write a clear, concise PR title (max 70 chars)
2. Write a description with:
   - **Summary**: What this PR does (2-3 sentences)
   - **Changes**: Bullet list of key changes
   - **Breaking Changes**: List any changes that could break existing consumers (changed function signatures, removed exports, altered API responses, changed behavior). If none, state "None"
   - **Backward Compatibility**: Note any deprecation wrappers or migration steps needed
   - **Testing**: What was tested or should be tested
3. Flag any risky changes that reviewers should pay extra attention to

Format the output as markdown ready to paste into a PR.`;

  if (!ChatHost.current) {
    void vscode.commands.executeCommand("explicitAI.openChat");
    await new Promise((r) => setTimeout(r, 500));
  }

  if (ChatHost.current) {
    // Truncate diff if too large (keep first 8000 chars)
    const truncatedDiff = diff.length > 8000
      ? diff.substring(0, 8000) + "\n\n... (diff truncated, " + diff.length + " chars total)"
      : diff;
    void ChatHost.current.session.send(prompt, truncatedDiff, true);
  }
}
