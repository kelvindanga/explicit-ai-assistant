import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
}

export interface McpJsonConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** MCP config lives at workspace root as mcp.json */
const MCP_CONFIG_FILE = "mcp.json";

export async function loadMcpConfig(workspaceRoot: string): Promise<McpJsonConfig> {
  const filePath = path.join(workspaceRoot, MCP_CONFIG_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as McpJsonConfig;
  } catch {
    return { mcpServers: {} };
  }
}

export async function saveMcpConfig(workspaceRoot: string, config: McpJsonConfig): Promise<void> {
  await fs.writeFile(path.join(workspaceRoot, MCP_CONFIG_FILE), JSON.stringify(config, null, 2), "utf8");
}

export async function getEnabledMcpServers(workspaceRoot: string): Promise<Record<string, McpServerConfig>> {
  const config = await loadMcpConfig(workspaceRoot);
  const enabled: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (!server.disabled) {
      enabled[name] = server;
    }
  }
  return enabled;
}

export async function openMcpConfigInEditor(workspaceRoot: string): Promise<void> {
  const filePath = path.join(workspaceRoot, MCP_CONFIG_FILE);
  try {
    await fs.access(filePath);
  } catch {
    // Create default mcp.json if it doesn't exist
    const defaultConfig: McpJsonConfig = {
      mcpServers: {}
    };
    await saveMcpConfig(workspaceRoot, defaultConfig);
  }
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
}
