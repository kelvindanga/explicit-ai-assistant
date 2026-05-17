import * as path from "path";
import * as vscode from "vscode";

export interface AttachedFile {
  id: string;
  name: string;
  fsPath: string;
  content: string;
}

/** Maximum file size allowed for attachment (512 KB) */
const MAX_FILE_SIZE_BYTES = 512 * 1024;

/** File extensions considered binary and not suitable for text attachment */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".sqlite", ".db"
]);

function isBinaryFile(fsPath: string): boolean {
  const ext = path.extname(fsPath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function validateFileSize(data: Uint8Array, fsPath: string): void {
  if (data.byteLength > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (data.byteLength / (1024 * 1024)).toFixed(1);
    throw new Error(`File too large (${sizeMB} MB). Maximum is ${MAX_FILE_SIZE_BYTES / 1024} KB: ${path.basename(fsPath)}`);
  }
}

export function createFileId(): string {
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function readFileFromPath(fsPath: string): Promise<AttachedFile> {
  if (isBinaryFile(fsPath)) {
    throw new Error(`Cannot attach binary file: ${path.basename(fsPath)}`);
  }
  const uri = vscode.Uri.file(fsPath);
  const data = await vscode.workspace.fs.readFile(uri);
  validateFileSize(data, fsPath);
  const content = Buffer.from(data).toString("utf8");
  return {
    id: createFileId(),
    name: path.basename(fsPath),
    fsPath,
    content
  };
}

export async function pickFiles(): Promise<AttachedFile[]> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "Attach to chat"
  });
  if (!uris?.length) {
    return [];
  }
  const out: AttachedFile[] = [];
  for (const u of uris) {
    try {
      out.push(await readFileFromPath(u.fsPath));
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Could not read: ${u.fsPath}`;
      vscode.window.showWarningMessage(msg);
    }
  }
  return out;
}

/** Resolve @filename references from workspace (explicit only — no fuzzy discovery). */
export async function resolveAtMentions(
  prompt: string,
  workspaceRoot: string | undefined
): Promise<{ prompt: string; files: AttachedFile[] }> {
  if (!workspaceRoot) {
    return { prompt, files: [] };
  }
  const pattern = /@([\w./\\-]+\.\w+)/g;
  const files: AttachedFile[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(prompt)) !== null) {
    const rel = match[1].replace(/\\/g, "/");
    const full = path.join(workspaceRoot, rel);
    if (seen.has(full)) {
      continue;
    }
    seen.add(full);
    try {
      files.push(await readFileFromPath(full));
    } catch {
      /* explicit path only — skip if not found */
    }
  }
  return { prompt, files };
}

export function formatFilesForContext(files: AttachedFile[]): string {
  if (!files.length) {
    return "";
  }
  return files
    .map(
      (f) =>
        `--- File: ${f.name} (${f.fsPath}) ---\n${f.content}\n--- End file ---`
    )
    .join("\n\n");
}
