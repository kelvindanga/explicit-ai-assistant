import * as vscode from "vscode";

/**
 * Terminal output watcher — monitors terminal for errors and notifies the chat.
 * Detects common error patterns from build tools, test runners, and dev servers.
 */

export interface TerminalError {
  terminal: string;
  error: string;
  timestamp: number;
}

const ERROR_PATTERNS = [
  // Build errors
  /error\s+TS\d+:/i,
  /error\s+CS\d+:/i,
  /SyntaxError:/i,
  /TypeError:/i,
  /ReferenceError:/i,
  /CompileError:/i,
  /Build FAILED/i,
  /FAILED\s+\d+\s+test/i,
  // Runtime errors
  /Unhandled\s+(?:promise\s+)?rejection/i,
  /ENOENT:/i,
  /ECONNREFUSED/i,
  /Cannot find module/i,
  /Module not found/i,
  // Test failures
  /FAIL\s+\w/,
  /✕|✗|FAILED/,
  /AssertionError/i,
  /Expected.*but.*received/i,
  // .NET
  /error\s+:/i,
  /Build succeeded\. 0 Error/i, // NOT an error — exclude
];

const EXCLUDE_PATTERNS = [
  /Build succeeded/i,
  /0 Error/i,
  /warning\s+/i, // warnings aren't errors
];

export class TerminalWatcher {
  private disposables: vscode.Disposable[] = [];
  private recentErrors: TerminalError[] = [];
  private onErrorCallbacks: Array<(error: TerminalError) => void> = [];
  private enabled = false;

  start(): void {
    this.enabled = vscode.workspace.getConfiguration("explicitAI").get<boolean>("terminalWatch", true);
    if (!this.enabled) return;

    // Watch for terminal data using the shell integration API
    // Note: onDidWriteTerminalData requires vscode.proposed API or terminal shell integration
    // Use onDidChangeTerminalShellIntegration as fallback
    try {
      // Use the terminal data write event if available (VS Code 1.93+)
      const writeEvent = (vscode.window as unknown as { onDidWriteTerminalData?: vscode.Event<{ terminal: vscode.Terminal; data: string }> }).onDidWriteTerminalData;
      if (writeEvent) {
        this.disposables.push(
          writeEvent((e: { terminal: vscode.Terminal; data: string }) => {
            this.processOutput(e.terminal.name, e.data);
          })
        );
      }
    } catch {
      // API not available — terminal watching disabled
    }

    // Watch for config changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("explicitAI.terminalWatch")) {
          this.enabled = vscode.workspace.getConfiguration("explicitAI").get<boolean>("terminalWatch", true);
        }
      })
    );
  }

  onError(callback: (error: TerminalError) => void): void {
    this.onErrorCallbacks.push(callback);
  }

  getRecentErrors(limit = 5): TerminalError[] {
    return this.recentErrors.slice(-limit);
  }

  clearErrors(): void {
    this.recentErrors = [];
  }

  private processOutput(terminalName: string, data: string): void {
    if (!this.enabled) return;

    // Check if output contains error patterns
    const lines = data.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 10) continue;

      // Skip excluded patterns
      if (EXCLUDE_PATTERNS.some((p) => p.test(trimmed))) continue;

      // Check error patterns
      if (ERROR_PATTERNS.some((p) => p.test(trimmed))) {
        const error: TerminalError = {
          terminal: terminalName,
          error: trimmed.substring(0, 200), // cap length
          timestamp: Date.now()
        };

        // Deduplicate — don't fire for the same error within 5 seconds
        const isDuplicate = this.recentErrors.some(
          (e) => e.error === error.error && Date.now() - e.timestamp < 5000
        );
        if (!isDuplicate) {
          this.recentErrors.push(error);
          if (this.recentErrors.length > 20) this.recentErrors.shift();
          this.onErrorCallbacks.forEach((cb) => cb(error));
        }
        break; // One error per output chunk is enough
      }
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}

export const terminalWatcher = new TerminalWatcher();
