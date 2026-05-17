import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Tracks file changes made by the AI so they can be undone.
 * Each "turn" (user message → AI response → tool executions) creates a checkpoint.
 * Undoing reverts all file changes made during that turn.
 */

export interface FileSnapshot {
  fsPath: string;
  relativePath: string;
  previousContent: string | null; // null = file didn't exist before
  newContent: string;
  timestamp: number;
}

export interface ChangeCheckpoint {
  id: string; // matches the assistant message ID
  timestamp: number;
  changes: FileSnapshot[];
}

const MAX_CHECKPOINTS = 50;

export class FileChangeTracker {
  private checkpoints: ChangeCheckpoint[] = [];
  private pendingChanges: FileSnapshot[] = [];
  private currentCheckpointId: string | null = null;

  /** Start tracking changes for a new AI turn */
  startCheckpoint(messageId: string): void {
    this.currentCheckpointId = messageId;
    this.pendingChanges = [];
  }

  /** Record a file change (call BEFORE writing the file) */
  async recordChange(fsPath: string, newContent: string): Promise<void> {
    let previousContent: string | null = null;
    try {
      previousContent = await fs.readFile(fsPath, "utf8");
    } catch {
      // File doesn't exist yet — that's fine
      previousContent = null;
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const relativePath = root ? path.relative(root, fsPath) : fsPath;

    this.pendingChanges.push({
      fsPath,
      relativePath,
      previousContent,
      newContent,
      timestamp: Date.now()
    });
  }

  /** Record a file deletion (call BEFORE deleting) */
  async recordDeletion(fsPath: string): Promise<void> {
    let previousContent: string | null = null;
    try {
      previousContent = await fs.readFile(fsPath, "utf8");
    } catch {
      return; // File doesn't exist, nothing to track
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const relativePath = root ? path.relative(root, fsPath) : fsPath;

    this.pendingChanges.push({
      fsPath,
      relativePath,
      previousContent,
      newContent: "", // empty = deleted
      timestamp: Date.now()
    });
  }

  /** Commit the current checkpoint (call after AI turn completes) */
  commitCheckpoint(): ChangeCheckpoint | null {
    if (!this.currentCheckpointId || this.pendingChanges.length === 0) {
      this.currentCheckpointId = null;
      this.pendingChanges = [];
      return null;
    }

    const checkpoint: ChangeCheckpoint = {
      id: this.currentCheckpointId,
      timestamp: Date.now(),
      changes: [...this.pendingChanges]
    };

    this.checkpoints.push(checkpoint);
    if (this.checkpoints.length > MAX_CHECKPOINTS) {
      this.checkpoints.shift();
    }

    this.currentCheckpointId = null;
    this.pendingChanges = [];
    return checkpoint;
  }

  /** Undo all file changes from a specific checkpoint */
  async undoCheckpoint(messageId: string): Promise<{ reverted: string[]; errors: string[] }> {
    const idx = this.checkpoints.findIndex((c) => c.id === messageId);
    if (idx < 0) {
      return { reverted: [], errors: [] };
    }

    // Undo this checkpoint and all after it (in reverse order)
    const toUndo = this.checkpoints.splice(idx);
    const reverted: string[] = [];
    const errors: string[] = [];

    // Process in reverse — latest changes first
    for (const checkpoint of toUndo.reverse()) {
      for (const change of checkpoint.changes.reverse()) {
        try {
          if (change.previousContent === null) {
            // File was created by AI — delete it
            await fs.unlink(change.fsPath);
            reverted.push(`Deleted: ${change.relativePath}`);
          } else {
            // File was modified — restore previous content
            await fs.writeFile(change.fsPath, change.previousContent, "utf8");
            reverted.push(`Reverted: ${change.relativePath}`);
          }
        } catch (err) {
          errors.push(`Failed to revert ${change.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return { reverted, errors };
  }

  /** Undo all changes from the most recent checkpoint */
  async undoLast(): Promise<{ reverted: string[]; errors: string[] }> {
    if (this.checkpoints.length === 0) {
      return { reverted: [], errors: [] };
    }
    const last = this.checkpoints[this.checkpoints.length - 1];
    return this.undoCheckpoint(last.id);
  }

  /** Get list of checkpoints (for UI display) */
  getCheckpoints(): Array<{ id: string; timestamp: number; fileCount: number; files: string[] }> {
    return this.checkpoints.map((c) => ({
      id: c.id,
      timestamp: c.timestamp,
      fileCount: c.changes.length,
      files: c.changes.map((ch) => ch.relativePath)
    }));
  }

  /** Check if a message ID has associated file changes */
  hasChanges(messageId: string): boolean {
    return this.checkpoints.some((c) => c.id === messageId);
  }
}

export const fileTracker = new FileChangeTracker();
