import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as child_process from "child_process";
import * as util from "util";
import { fileTracker } from "../core/fileTracker";
import { showDiff, ProposedChange } from "../core/diffPreview";

const execAsync = util.promisify(child_process.exec);

/**
 * Built-in developer tools for the AI assistant.
 * These are workspace-scoped tools that the AI can invoke directly.
 * Read operations auto-execute; write operations require user approval via the chat UI.
 */

export type ToolCategory = "read" | "write" | "shell";

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, string>;
  category: ToolCategory;
  description: string;
}

export interface ToolResult {
  id: string;
  tool: string;
  success: boolean;
  output: string;
  truncated?: boolean;
}

function getRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
}

function resolvePath(filePath: string): string {
  const root = getRoot();
  if (!root) return filePath;
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(root, filePath);
}

/**
 * Ensure a path is within the workspace (security boundary).
 */
function isWithinWorkspace(filePath: string): boolean {
  const root = getRoot();
  if (!root) return false;
  const resolved = path.resolve(resolvePath(filePath));
  return resolved.startsWith(path.resolve(root));
}

// ─── READ TOOLS (auto-execute, no approval needed) ───

/**
 * Smart file reading — supports:
 * - Full file: readFile("src/main.ts")
 * - Line range: readFile("src/main.ts", "10-50")
 * - Symbol: readFile("src/main.ts", "className") or readFile("src/main.ts", "functionName")
 * 
 * For large files, automatically shows a summary with line numbers instead of dumping everything.
 */
export async function toolReadFile(filePath: string, rangeOrSymbol?: string): Promise<ToolResult> {
  const id = `tr_${Date.now()}`;
  try {
    if (!isWithinWorkspace(filePath)) {
      return { id, tool: "readFile", success: false, output: "Error: Path is outside workspace." };
    }
    const resolved = resolvePath(filePath);
    const content = await fs.readFile(resolved, "utf8");
    const lines = content.split("\n");

    // Line range: "10-50" or "10"
    if (rangeOrSymbol && /^\d+(-\d+)?$/.test(rangeOrSymbol)) {
      const parts = rangeOrSymbol.split("-");
      const start = Math.max(0, parseInt(parts[0], 10) - 1);
      const end = parts[1] ? Math.min(lines.length, parseInt(parts[1], 10)) : start + 1;
      const slice = lines.slice(start, end);
      const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join("\n");
      return { id, tool: "readFile", success: true, output: `Lines ${start + 1}-${end} of ${filePath} (${lines.length} total):\n\n${numbered}` };
    }

    // Symbol search: find a function/class/method by name
    if (rangeOrSymbol && !/^\d/.test(rangeOrSymbol)) {
      const symbol = rangeOrSymbol.trim();
      const symbolPatterns = [
        new RegExp(`^\\s*(export\\s+)?(async\\s+)?function\\s+${symbol}`, "m"),
        new RegExp(`^\\s*(export\\s+)?(abstract\\s+)?class\\s+${symbol}`, "m"),
        new RegExp(`^\\s*(export\\s+)?interface\\s+${symbol}`, "m"),
        new RegExp(`^\\s*(public|private|protected|static|async).*\\s+${symbol}\\s*\\(`, "m"),
        new RegExp(`^\\s*(export\\s+)?(const|let|var)\\s+${symbol}`, "m"),
      ];

      for (const pat of symbolPatterns) {
        const match = content.match(pat);
        if (match && match.index !== undefined) {
          const startLine = content.substring(0, match.index).split("\n").length - 1;
          // Find the end of the symbol (next function/class or end of file)
          const endLine = findSymbolEnd(lines, startLine);
          const slice = lines.slice(startLine, endLine);
          const numbered = slice.map((l, i) => `${startLine + i + 1}: ${l}`).join("\n");
          return { id, tool: "readFile", success: true, output: `Symbol "${symbol}" in ${filePath} (lines ${startLine + 1}-${endLine}):\n\n${numbered}` };
        }
      }
      return { id, tool: "readFile", success: false, output: `Symbol "${symbol}" not found in ${filePath}. Available symbols:\n${extractSymbols(lines).join("\n")}` };
    }

    // Full file — but smart: if large, show outline + first/last sections
    if (lines.length > 100) {
      const outline = extractSymbols(lines);
      const head = lines.slice(0, 40).map((l, i) => `${i + 1}: ${l}`).join("\n");
      const tail = lines.slice(-20).map((l, i) => `${lines.length - 20 + i + 1}: ${l}`).join("\n");
      return {
        id, tool: "readFile", success: true,
        output: `${filePath} (${lines.length} lines)\n\n` +
          `=== Outline ===\n${outline.join("\n")}\n\n` +
          `=== First 40 lines ===\n${head}\n\n` +
          `=== Last 20 lines ===\n${tail}\n\n` +
          `[Use readFile with line range (e.g. "50-100") or symbol name to see specific sections]`,
        truncated: true
      };
    }

    // Small file — return as-is with line numbers
    const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
    return { id, tool: "readFile", success: true, output: numbered };
  } catch (err) {
    return { id, tool: "readFile", success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Find where a symbol definition ends (heuristic: matching braces or next top-level definition) */
function findSymbolEnd(lines: string[], startLine: number): number {
  let braceDepth = 0;
  let started = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "{") { braceDepth++; started = true; }
      if (ch === "}") { braceDepth--; }
    }
    // Symbol ended when braces balance back to 0
    if (started && braceDepth <= 0) {
      return Math.min(i + 2, lines.length); // include closing brace + 1 blank line
    }
    // Safety: don't read more than 80 lines for one symbol
    if (i - startLine > 80) return i;
  }
  return Math.min(startLine + 40, lines.length);
}

/** Extract top-level symbols (functions, classes, interfaces) with line numbers */
function extractSymbols(lines: string[]): string[] {
  const symbols: string[] = [];
  const patterns = [
    /^\s*(export\s+)?(async\s+)?function\s+(\w+)/,
    /^\s*(export\s+)?(abstract\s+)?class\s+(\w+)/,
    /^\s*(export\s+)?interface\s+(\w+)/,
    /^\s*(export\s+)?(const|let|var)\s+(\w+)\s*[:=]/,
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const pat of patterns) {
      const m = lines[i].match(pat);
      if (m) {
        const name = m[m.length - 1] || m[3] || m[2];
        if (name && name.length > 1) {
          symbols.push(`  L${i + 1}: ${lines[i].trim().substring(0, 80)}`);
          break;
        }
      }
    }
  }
  return symbols.slice(0, 30); // cap at 30 symbols
}

export async function toolListDirectory(dirPath: string, depth = 2): Promise<ToolResult> {
  const id = `tr_${Date.now()}`;
  try {
    const resolved = resolvePath(dirPath || ".");
    if (!isWithinWorkspace(resolved)) {
      return { id, tool: "listDir", success: false, output: "Error: Path is outside workspace." };
    }
    const tree = await buildTree(resolved, depth, 0);
    return { id, tool: "listDir", success: true, output: tree };
  } catch (err) {
    return { id, tool: "listDir", success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function buildTree(dir: string, maxDepth: number, currentDepth: number): Promise<string> {
  if (currentDepth >= maxDepth) return "";
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const ignore = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__", ".cache"]);
  const lines: string[] = [];
  const indent = "  ".repeat(currentDepth);

  const sorted = entries
    .filter((e) => !ignore.has(e.name) && !e.name.startsWith("."))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  for (const entry of sorted) {
    if (entry.isDirectory()) {
      lines.push(`${indent}📁 ${entry.name}/`);
      const sub = await buildTree(path.join(dir, entry.name), maxDepth, currentDepth + 1);
      if (sub) lines.push(sub);
    } else {
      lines.push(`${indent}📄 ${entry.name}`);
    }
  }
  return lines.join("\n");
}

export async function toolSearch(query: string, filePattern?: string): Promise<ToolResult> {
  const id = `tr_${Date.now()}`;
  const root = getRoot();
  if (!root) {
    return { id, tool: "search", success: false, output: "Error: No workspace open." };
  }

  try {
    // Use ripgrep if available, fall back to grep/findstr
    const escapedQuery = query.replace(/"/g, '\\"');
    let cmd: string;

    // Try ripgrep first (fastest), then grep, then findstr (Windows)
    if (process.platform === "win32") {
      cmd = `findstr /s /n /i "${escapedQuery}" ${filePattern || "*.*"}`;
    } else {
      cmd = `grep -rn --include="${filePattern || "*"}" "${escapedQuery}" .`;
    }

    const { stdout } = await execAsync(cmd, {
      cwd: root,
      maxBuffer: 256_000,
      timeout: 15_000
    });

    const lines = stdout.trim().split("\n");
    const truncated = lines.length > 50;
    const output = truncated
      ? lines.slice(0, 50).join("\n") + `\n\n... (${lines.length} total matches, showing first 50)`
      : stdout.trim();

    return { id, tool: "search", success: true, output: output || "(no matches)", truncated };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    // grep returns exit code 1 for no matches
    if (e.code === 1 && !e.stdout) {
      return { id, tool: "search", success: true, output: "(no matches found)" };
    }
    return { id, tool: "search", success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function toolFindFiles(pattern: string): Promise<ToolResult> {
  const id = `tr_${Date.now()}`;
  const root = getRoot();
  if (!root) {
    return { id, tool: "findFiles", success: false, output: "Error: No workspace open." };
  }

  try {
    const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 50);
    const files = uris.map((u) => vscode.workspace.asRelativePath(u));
    return {
      id, tool: "findFiles", success: true,
      output: files.length ? files.join("\n") : "(no files found)"
    };
  } catch (err) {
    return { id, tool: "findFiles", success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── WRITE TOOLS (require approval) ───

export async function toolWriteFile(filePath: string, content: string): Promise<ToolResult> {
  const id = `tw_${Date.now()}`;
  try {
    if (!isWithinWorkspace(filePath)) {
      return { id, tool: "writeFile", success: false, output: "Error: Path is outside workspace." };
    }
    const resolved = resolvePath(filePath);
    const agenticMode = vscode.workspace.getConfiguration("explicitAI").get<boolean>("agenticMode", true);

    // In supervised mode, show diff preview
    if (!agenticMode) {
      let originalContent = "";
      try { originalContent = await fs.readFile(resolved, "utf8"); } catch { /* new file */ }
      const change: ProposedChange = {
        filePath: resolved,
        relativePath: filePath,
        originalContent,
        proposedContent: content,
        isNew: !originalContent
      };
      const accepted = await showDiff(change);
      if (!accepted) {
        return { id, tool: "writeFile", success: false, output: "Change rejected by user." };
      }
    }

    await fileTracker.recordChange(resolved, content);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
    await vscode.window.showTextDocument(doc, { preview: true });

    return { id, tool: "writeFile", success: true, output: `Written ${content.length} chars to ${filePath}` };
  } catch (err) {
    return { id, tool: "writeFile", success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function toolEditFile(filePath: string, oldText: string, newText: string): Promise<ToolResult> {
  const id = `tw_${Date.now()}`;
  try {
    // Reject empty oldText — it matches everywhere
    if (!oldText || !oldText.trim()) {
      return { id, tool: "editFile", success: false, output: "Error: oldText cannot be empty. To insert text, use the 'insertAt' tool instead, or provide the exact line(s) you want to replace." };
    }

    if (!isWithinWorkspace(filePath)) {
      return { id, tool: "editFile", success: false, output: "Error: Path is outside workspace." };
    }
    const resolved = resolvePath(filePath);
    const content = await fs.readFile(resolved, "utf8");

    if (!content.includes(oldText)) {
      // Provide helpful context: show nearby lines that partially match
      const firstLine = oldText.split("\n")[0].trim();
      const lines = content.split("\n");
      const partialMatches = lines
        .map((l, i) => ({ line: i + 1, text: l }))
        .filter((l) => l.text.includes(firstLine.substring(0, 20)))
        .slice(0, 3);
      const hint = partialMatches.length
        ? `\nPartial matches near: ${partialMatches.map((m) => `line ${m.line}`).join(", ")}`
        : "\nTip: Use 'readFile' first to see the exact content, then copy the exact text to replace.";
      return { id, tool: "editFile", success: false, output: `Error: Could not find the text to replace in the file.${hint}` };
    }

    const occurrences = content.split(oldText).length - 1;
    if (occurrences > 1) {
      return { id, tool: "editFile", success: false, output: `Error: Found ${occurrences} occurrences of the text. Include more surrounding lines to make it unique.` };
    }

    const updated = content.replace(oldText, newText);
    await fileTracker.recordChange(resolved, updated);
    await fs.writeFile(resolved, updated, "utf8");

    // Open and show the file
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
    await vscode.window.showTextDocument(doc, { preview: true });

    return { id, tool: "editFile", success: true, output: `Replaced text in ${filePath} (${oldText.length} → ${newText.length} chars)` };
  } catch (err) {
    return { id, tool: "editFile", success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Insert text at a specific line number. Line 0 = top of file.
 * This avoids the "empty oldText" problem entirely.
 */
export async function toolInsertAt(filePath: string, line: number, text: string, position: "before" | "after" = "before"): Promise<ToolResult> {
  const id = `tw_${Date.now()}`;
  try {
    if (!isWithinWorkspace(filePath)) {
      return { id, tool: "insertAt", success: false, output: "Error: Path is outside workspace." };
    }
    if (!text) {
      return { id, tool: "insertAt", success: false, output: "Error: text to insert cannot be empty." };
    }
    const resolved = resolvePath(filePath);
    const content = await fs.readFile(resolved, "utf8");
    const lines = content.split("\n");

    // Clamp line number to valid range
    const targetLine = Math.max(0, Math.min(line, lines.length));
    const insertIdx = position === "after" ? targetLine + 1 : targetLine;

    const textLines = text.split("\n");
    lines.splice(insertIdx, 0, ...textLines);

    const updated = lines.join("\n");
    await fileTracker.recordChange(resolved, updated);
    await fs.writeFile(resolved, updated, "utf8");

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
    await vscode.window.showTextDocument(doc, { preview: true });

    return { id, tool: "insertAt", success: true, output: `Inserted ${textLines.length} line(s) at line ${insertIdx + 1} in ${filePath}` };
  } catch (err) {
    return { id, tool: "insertAt", success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function toolCreateDirectory(dirPath: string): Promise<ToolResult> {
  const id = `tw_${Date.now()}`;
  try {
    if (!isWithinWorkspace(dirPath)) {
      return { id, tool: "createDir", success: false, output: "Error: Path is outside workspace." };
    }
    const resolved = resolvePath(dirPath);
    await fs.mkdir(resolved, { recursive: true });
    return { id, tool: "createDir", success: true, output: `Created directory: ${dirPath}` };
  } catch (err) {
    return { id, tool: "createDir", success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function toolDeleteFile(filePath: string): Promise<ToolResult> {
  const id = `tw_${Date.now()}`;
  try {
    if (!isWithinWorkspace(filePath)) {
      return { id, tool: "deleteFile", success: false, output: "Error: Path is outside workspace." };
    }
    const resolved = resolvePath(filePath);
    await fileTracker.recordDeletion(resolved);
    await fs.unlink(resolved);
    return { id, tool: "deleteFile", success: true, output: `Deleted: ${filePath}` };
  } catch (err) {
    return { id, tool: "deleteFile", success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── SHELL TOOLS (require approval) ───

export async function toolRunCommand(command: string, cwd?: string): Promise<ToolResult> {
  const id = `ts_${Date.now()}`;
  const root = getRoot();
  const workDir = cwd ? resolvePath(cwd) : root;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workDir,
      timeout: 60_000,
      maxBuffer: 512_000
    });
    const output = [
      stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
      stderr.trim() ? `stderr:\n${stderr.trim()}` : ""
    ].filter(Boolean).join("\n\n");
    return { id, tool: "runCommand", success: true, output: output || "(no output)" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [
      e.stdout?.trim() ? `stdout:\n${e.stdout.trim()}` : "",
      e.stderr?.trim() ? `stderr:\n${e.stderr.trim()}` : "",
      `exit error: ${e.message ?? String(err)}`
    ].filter(Boolean).join("\n\n");
    return { id, tool: "runCommand", success: false, output };
  }
}

// ─── TOOL REGISTRY ───

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: Record<string, { type: string; description: string; required: boolean }>;
}

export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: "readFile",
    description: "Read file contents. For large files shows outline + key sections. Use 'range' for specific lines or symbol name.",
    category: "read",
    parameters: {
      path: { type: "string", description: "Relative path to the file", required: true },
      range: { type: "string", description: "Line range (e.g. '10-50') or symbol name (e.g. 'MyClass', 'handleLogin')", required: false }
    }
  },
  {
    name: "listDir",
    description: "List directory contents with tree structure",
    category: "read",
    parameters: {
      path: { type: "string", description: "Relative path to directory (default: root)", required: false },
      depth: { type: "number", description: "Max depth (default: 2)", required: false }
    }
  },
  {
    name: "search",
    description: "Search for text across workspace files (grep)",
    category: "read",
    parameters: {
      query: { type: "string", description: "Text or regex to search for", required: true },
      filePattern: { type: "string", description: "File glob pattern (e.g. *.ts)", required: false }
    }
  },
  {
    name: "findFiles",
    description: "Find files matching a glob pattern",
    category: "read",
    parameters: {
      pattern: { type: "string", description: "Glob pattern (e.g. **/*.test.ts)", required: true }
    }
  },
  {
    name: "writeFile",
    description: "Create or overwrite a file with content",
    category: "write",
    parameters: {
      path: { type: "string", description: "Relative path for the file", required: true },
      content: { type: "string", description: "File content to write", required: true }
    }
  },
  {
    name: "editFile",
    description: "Replace specific text in a file (find and replace)",
    category: "write",
    parameters: {
      path: { type: "string", description: "Relative path to the file", required: true },
      oldText: { type: "string", description: "Exact text to find (must be unique in file)", required: true },
      newText: { type: "string", description: "Replacement text", required: true }
    }
  },
  {
    name: "createDir",
    description: "Create a directory (and parent directories)",
    category: "write",
    parameters: {
      path: { type: "string", description: "Relative path for the directory", required: true }
    }
  },
  {
    name: "deleteFile",
    description: "Delete a file from the workspace",
    category: "write",
    parameters: {
      path: { type: "string", description: "Relative path to the file to delete", required: true }
    }
  },
  {
    name: "insertAt",
    description: "Insert text at a specific line number (use this instead of editFile when adding new code)",
    category: "write",
    parameters: {
      path: { type: "string", description: "Relative path to the file", required: true },
      line: { type: "number", description: "Line number to insert at (1-based, 0 = top of file)", required: true },
      text: { type: "string", description: "Text to insert", required: true },
      position: { type: "string", description: "'before' or 'after' the specified line (default: before)", required: false }
    }
  },
  {
    name: "runCommand",
    description: "Execute a shell command in the workspace",
    category: "shell",
    parameters: {
      command: { type: "string", description: "Shell command to run", required: true },
      cwd: { type: "string", description: "Working directory (relative, default: workspace root)", required: false }
    }
  }
];

/**
 * Execute a tool call by name.
 */
export async function executeBuiltinTool(call: ToolCall): Promise<ToolResult> {
  switch (call.tool) {
    case "readFile":
      return toolReadFile(call.args.path ?? "", call.args.range);
    case "listDir":
      return toolListDirectory(call.args.path, parseInt(call.args.depth ?? "2", 10));
    case "search":
      return toolSearch(call.args.query ?? "", call.args.filePattern);
    case "findFiles":
      return toolFindFiles(call.args.pattern ?? "");
    case "writeFile":
      return toolWriteFile(call.args.path ?? "", call.args.content ?? "");
    case "editFile":
      return toolEditFile(call.args.path ?? "", call.args.oldText ?? "", call.args.newText ?? "");
    case "createDir":
      return toolCreateDirectory(call.args.path ?? "");
    case "deleteFile":
      return toolDeleteFile(call.args.path ?? "");
    case "insertAt":
      return toolInsertAt(
        call.args.path ?? "",
        parseInt(call.args.line ?? "0", 10),
        call.args.text ?? "",
        (call.args.position as "before" | "after") ?? "before"
      );
    case "runCommand":
      return toolRunCommand(call.args.command ?? "", call.args.cwd);
    default:
      return { id: call.id, tool: call.tool, success: false, output: `Unknown tool: ${call.tool}` };
  }
}

/**
 * Build a description of available tools for the system prompt.
 */
export function buildToolsSystemPrompt(): string {
  return `You have built-in tools to read, write, and search files in the user's workspace.

HOW TO USE TOOLS:
When you need to read a file, search code, or modify files, use this format:

\`\`\`tool
{"tool": "readFile", "args": {"path": "src/main.ts"}}
\`\`\`

Or simply say "Let me read src/main.ts" and the tool will execute automatically.

AVAILABLE TOOLS:

READ (auto-execute, no approval needed):
- readFile: Read file contents. Args: path, range (optional: line range like "10-50" or symbol name like "MyClass")
- listDir: List directory tree. Args: path (default "."), depth (default 2)
- search: Search text in files (grep). Args: query, filePattern (optional, e.g. "*.ts")
- findFiles: Find files by glob. Args: pattern (e.g. "**/*.test.ts")

WRITE (requires user approval):
- writeFile: Create/overwrite file. Args: path, content
- editFile: Replace specific text in file. Args: path, oldText (MUST be exact, non-empty, unique text copied from the file), newText
- insertAt: Insert text at a line number (use this to ADD new code without replacing). Args: path, line (number), text, position ("before" or "after", default "before")
- createDir: Create directory. Args: path
- deleteFile: Delete file. Args: path

SHELL (requires user approval):
- runCommand: Run shell command. Args: command, cwd (optional)

RULES:
- Always use relative paths from workspace root (e.g. "src/main.ts" not "C:\\\\...")
- Read tools execute immediately — you'll get the result and can continue
- Write/shell tools need user approval before executing
- When the user asks about a file, READ IT FIRST before saying you can't see it
- You can chain tools: read a file, then edit it based on what you found
- NEVER use editFile with empty oldText — it will fail. Use insertAt to add new text instead.
- For editFile: ALWAYS read the file first, then copy the EXACT text you want to replace. Include enough surrounding lines to make it unique.
- To add a comment or new code without replacing anything, use insertAt with the target line number.

EXAMPLES:
To read a file:
\`\`\`tool
{"tool": "readFile", "args": {"path": "src/controllers/UserController.ts"}}
\`\`\`

To search for something:
\`\`\`tool
{"tool": "search", "args": {"query": "KeycloakUserDto", "filePattern": "*.cs"}}
\`\`\`

To find files:
\`\`\`tool
{"tool": "findFiles", "args": {"pattern": "**/*Dto*.cs"}}
\`\`\`

To insert a comment above line 5:
\`\`\`tool
{"tool": "insertAt", "args": {"path": "src/Dtos/User.cs", "line": "5", "text": "/// <summary>Represents a user.</summary>", "position": "before"}}
\`\`\`

To replace existing text (read the file first to get exact text):
\`\`\`tool
{"tool": "editFile", "args": {"path": "src/models/User.ts", "oldText": "export interface User {\\n  id: string;\\n}", "newText": "export interface User {\\n  id: string;\\n  name: string;\\n}"}}
\`\`\`

To write a new file:
\`\`\`tool
{"tool": "writeFile", "args": {"path": "src/models/User.ts", "content": "export interface User {\\n  id: string;\\n}"}}
\`\`\``;
}

