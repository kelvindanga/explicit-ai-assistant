import { getConfig } from "./config";
import { loadMcpConfig } from "../mcp/mcpConfig";
import { buildToolsSystemPrompt } from "../tools/builtinTools";
import * as vscode from "vscode";

const ENGLISH_RULE = `You must always respond in English.
Never switch languages unless the user explicitly requests another language.
If the user writes in another language, still respond in English unless they ask you to use that language.`;

export function buildSystemPrompt(extra?: string): string {
  const { systemPrompt, enforceEnglish } = getConfig();
  const parts = [systemPrompt.trim()];
  if (enforceEnglish) {
    parts.push(ENGLISH_RULE);
  }
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
  // Include built-in tool descriptions
  parts.push(buildToolsSystemPrompt());

  // List MCP servers from mcp.json so model knows what's configured
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    try {
      const config = await loadMcpConfig(root);
      const servers = Object.entries(config.mcpServers)
        .filter(([, srv]) => !srv.disabled)
        .map(([name, srv]) => {
          const cmd = srv.command + " " + (srv.args || []).join(" ");
          return `  - ${name}: ${cmd.trim()}`;
        })
        .join("\n");
      if (servers) {
        parts.push(`The following MCP servers are configured and available:\n${servers}\n\nThese servers provide additional capabilities. You can suggest using them when relevant.`);
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

