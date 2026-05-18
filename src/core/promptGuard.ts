import { getConfig } from "./config";
import { loadMcpConfig } from "../mcp/mcpConfig";
import { buildToolsSystemPrompt } from "../tools/builtinTools";
import * as vscode from "vscode";

const ENGLISH_RULE = `You must always respond in English.
Never switch languages unless the user explicitly requests another language.
If the user writes in another language, still respond in English unless they ask you to use that language.`;

/**
 * Build workspace context so the AI knows what project is open.
 * This lets it scan, read, and navigate the project without the user specifying paths.
 */
function getWorkspaceContext(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) {
    return "WORKSPACE: No folder is open. Ask the user to open a project folder.";
  }
  const root = folders[0];
  const rootPath = root.uri.fsPath;
  const projectName = root.name;

  return `WORKSPACE CONTEXT:
You are working inside the project "${projectName}" located at: ${rootPath}
All file paths in your tools are relative to this root. You do NOT need the user to tell you the project path.
When the user says "scan the project", "look at the codebase", or "check the files" — use listDir and readFile tools directly.
You already have full access to read any file in this workspace. Just use the tools.`;
}

export function buildSystemPrompt(extra?: string): string {
  const { systemPrompt, enforceEnglish } = getConfig();
  const parts = [systemPrompt.trim()];
  if (enforceEnglish) {
    parts.push(ENGLISH_RULE);
  }
  // Include workspace context so the AI knows where it is
  parts.push(getWorkspaceContext());
  // Include built-in tool descriptions
  parts.push(buildToolsSystemPrompt());
  if (extra?.trim()) {
    parts.push(extra.trim());
  }
  return parts.filter(Boolean).join("\n\n");
}

export async function buildSystemPromptWithMcpServers(extra?: string): Promise<string> {
  const { systemPrompt, enforceEnglish } = getConfig();
  const parts = [systemPrompt.trim()];
  if (enforceEnglish) {
    parts.push(ENGLISH_RULE);
  }
  // Include workspace context
  parts.push(getWorkspaceContext());
  // Include built-in tool descriptions
  parts.push(buildToolsSystemPrompt());

  // List MCP tools from connected servers so the model can use them
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    try {
      const { mcpManager } = await import("../mcp/mcpClient");
      const mcpTools = mcpManager.getAllTools();
      if (mcpTools.length > 0) {
        const toolList = mcpTools.map((t) => {
          const params = t.inputSchema?.properties
            ? Object.entries(t.inputSchema.properties).map(([k, v]) => `${k}: ${v.description || v.type}`).join(", ")
            : "";
          return `  - ${t.serverName}/${t.name}: ${t.description || ""}${params ? ` (${params})` : ""}`;
        }).join("\n");
        parts.push(`MCP TOOLS (from connected servers — invoke with \`\`\`tool format using "server/tool" as the tool name):\n${toolList}`);
      }
    } catch { /* ignore */ }
  }

  if (extra?.trim()) {
    parts.push(extra.trim());
  }
  return parts.filter(Boolean).join("\n\n");
}

export const ENGLISH_RETRY_INSTRUCTION =
  "Your previous reply was not in English. Rewrite your entire answer in English only.";

