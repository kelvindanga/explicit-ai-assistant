import * as child_process from "child_process";
import * as fs from "fs/promises";
import * as util from "util";
import * as vscode from "vscode";

const execAsync = util.promisify(child_process.exec);
import { getConfig } from "../core/config";
import { McpToolId, McpToolRequest, McpToolResult } from "./types";

export function isToolEnabled(tool: McpToolId): boolean {
  const c = getConfig();
  if (!c.mcpEnabled) {
    return false;
  }
  switch (tool) {
    case "filesystem.readFile":
      return c.mcpFilesystem;
    case "terminal.runCommand":
      return c.mcpTerminal;
    case "http.request":
      return c.mcpHttp;
    default:
      return false;
  }
}

export function describeRequest(req: McpToolRequest): string {
  switch (req.tool) {
    case "filesystem.readFile":
      return `Read file: ${req.args.path ?? "(no path)"}`;
    case "terminal.runCommand":
      return `Run command: ${req.args.command ?? "(empty)"}`;
    case "http.request":
      return `HTTP ${req.args.method ?? "GET"} ${req.args.url ?? "(no url)"}`;
    default:
      return req.tool;
  }
}

/** Always requires manual approval — never auto-runs. */
export async function requestMcpApproval(req: McpToolRequest): Promise<boolean> {
  if (!isToolEnabled(req.tool)) {
    void vscode.window.showErrorMessage(`MCP tool disabled: ${req.tool}. Enable it in Explicit AI settings.`);
    return false;
  }

  const preview = formatArgsPreview(req);
  const choice = await vscode.window.showWarningMessage(
    `Approve MCP action?\n\nTool: ${req.tool}\n${preview}`,
    { modal: true, detail: "No automatic execution. You must approve each action." },
    "Approve",
    "Deny"
  );
  return choice === "Approve";
}

function formatArgsPreview(req: McpToolRequest): string {
  return Object.entries(req.args)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export async function executeMcpTool(req: McpToolRequest): Promise<McpToolResult> {
  const approved = await requestMcpApproval(req);
  if (!approved) {
    return { id: req.id, tool: req.tool, output: "(denied by user)", approved: false };
  }

  let output: string;
  try {
    switch (req.tool) {
      case "filesystem.readFile":
        output = await readFile(req.args.path ?? "");
        break;
      case "terminal.runCommand":
        output = await runCommand(req.args.command ?? "");
        break;
      case "http.request":
        output = await httpRequest(req.args.url ?? "", req.args.method ?? "GET", req.args.body);
        break;
      default:
        output = "Unknown tool";
    }
  } catch (err) {
    output = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  const include = await vscode.window.showInformationMessage(
    "MCP completed. Include output in next AI message?",
    { modal: true, detail: output.slice(0, 2000) },
    "Include",
    "Discard"
  );

  return {
    id: req.id,
    tool: req.tool,
    output: include === "Include" ? output : "(output discarded)",
    approved: include === "Include"
  };
}

async function readFile(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath, "utf8");
  return data.slice(0, 100_000);
}

async function runCommand(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: 30_000,
      maxBuffer: 512_000
    });
    return `stdout:\n${stdout}\nstderr:\n${stderr}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `stderr:\n${e.stderr ?? ""}\nstdout:\n${e.stdout ?? ""}\nerror: ${e.message ?? String(err)}`;
  }
}

async function httpRequest(url: string, method: string, body?: string): Promise<string> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body || undefined
  });
  const text = await res.text();
  return `Status: ${res.status}\n${text.slice(0, 50_000)}`;
}
