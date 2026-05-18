import * as child_process from "child_process";
import * as vscode from "vscode";
import { loadMcpConfig, McpServerConfig } from "./mcpConfig";

/**
 * MCP Client — implements the Model Context Protocol client.
 * Spawns MCP servers as child processes and communicates via JSON-RPC over stdio.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpServerConnection {
  private process: child_process.ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private tools: McpTool[] = [];
  private initialized = false;

  constructor(
    public readonly name: string,
    private readonly config: McpServerConfig
  ) {}

  async start(): Promise<void> {
    if (this.process) return;

    const env = { ...process.env, ...(this.config.env || {}) };
    const args = this.config.args || [];

    this.process = child_process.spawn(this.config.command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.handleData(data.toString());
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      // Log stderr but don't crash
      const msg = data.toString().trim();
      if (msg) console.log(`[MCP ${this.name} stderr]: ${msg}`);
    });

    this.process.on("exit", (code) => {
      console.log(`[MCP ${this.name}] exited with code ${code}`);
      this.cleanup();
    });

    this.process.on("error", (err) => {
      console.error(`[MCP ${this.name}] spawn error:`, err.message);
      this.cleanup();
    });

    // Initialize the connection
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const response = await this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "explicit-ai-assistant", version: "2.0.0" }
      });

      if (response.result) {
        this.initialized = true;
        // Send initialized notification
        this.sendNotification("notifications/initialized", {});
        // Discover tools
        await this.discoverTools();
      }
    } catch (err) {
      console.error(`[MCP ${this.name}] init failed:`, err);
    }
  }

  private async discoverTools(): Promise<void> {
    try {
      const response = await this.sendRequest("tools/list", {});
      const result = response.result as { tools?: McpTool[] } | undefined;
      this.tools = result?.tools ?? [];
    } catch {
      this.tools = [];
    }
  }

  getTools(): McpTool[] {
    return [...this.tools];
  }

  isReady(): boolean {
    return this.initialized && this.process !== null;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!this.isReady()) {
      throw new Error(`MCP server "${this.name}" is not connected.`);
    }

    const response = await this.sendRequest("tools/call", {
      name: toolName,
      arguments: args
    });

    if (response.error) {
      throw new Error(`MCP tool error: ${response.error.message}`);
    }

    return response.result as McpToolCallResult;
  }

  private sendRequest(method: string, params: unknown): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error("MCP server not running"));
        return;
      }

      const id = ++this.requestId;
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      const message = JSON.stringify(request);
      const frame = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 30000);

      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(frame);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.process?.stdin?.writable) return;
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    const frame = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    this.process.stdin.write(frame);
  }

  private handleData(data: string): void {
    this.buffer += data;

    while (true) {
      // Parse Content-Length header
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;

      const header = this.buffer.substring(0, headerEnd);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        // Try parsing as raw JSON (some servers don't use Content-Length)
        const jsonStart = this.buffer.indexOf("{");
        if (jsonStart >= 0) {
          try {
            const parsed = JSON.parse(this.buffer.substring(jsonStart));
            this.handleMessage(parsed);
            this.buffer = "";
            break;
          } catch { /* incomplete JSON */ }
        }
        break;
      }

      const contentLength = parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.substring(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.substring(bodyStart + contentLength);

      try {
        const message = JSON.parse(body);
        this.handleMessage(message);
      } catch {
        // Malformed JSON, skip
      }
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
    // Notifications (no id) are ignored for now
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.cleanup();
    }
  }

  private cleanup(): void {
    this.process = null;
    this.initialized = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP server disconnected"));
    }
    this.pending.clear();
  }
}

/**
 * MCP Manager — manages all MCP server connections.
 */
export class McpManager {
  private connections = new Map<string, McpServerConnection>();

  async loadAndConnect(workspaceRoot: string): Promise<void> {
    const config = await loadMcpConfig(workspaceRoot);

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      if (serverConfig.disabled) continue;
      if (this.connections.has(name)) continue;

      const connection = new McpServerConnection(name, serverConfig);
      this.connections.set(name, connection);

      try {
        await connection.start();
      } catch (err) {
        console.error(`[MCP] Failed to start server "${name}":`, err);
        this.connections.delete(name);
      }
    }
  }

  /** Get all available tools across all connected servers */
  getAllTools(): Array<McpTool & { serverName: string }> {
    const tools: Array<McpTool & { serverName: string }> = [];
    for (const [name, conn] of this.connections) {
      if (!conn.isReady()) continue;
      for (const tool of conn.getTools()) {
        tools.push({ ...tool, serverName: name });
      }
    }
    return tools;
  }

  /** Call a tool on the appropriate server */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const conn = this.connections.get(serverName);
    if (!conn || !conn.isReady()) {
      throw new Error(`MCP server "${serverName}" is not connected.`);
    }

    const result = await conn.callTool(toolName, args);

    // Extract text content from the result
    const texts = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);

    if (result.isError) {
      throw new Error(texts.join("\n") || "MCP tool returned an error");
    }

    return texts.join("\n") || "(no output)";
  }

  /** Find which server has a specific tool */
  findToolServer(toolName: string): string | undefined {
    for (const [name, conn] of this.connections) {
      if (!conn.isReady()) continue;
      if (conn.getTools().some((t) => t.name === toolName)) {
        return name;
      }
    }
    return undefined;
  }

  getConnectedServers(): Array<{ name: string; tools: McpTool[]; ready: boolean }> {
    const servers: Array<{ name: string; tools: McpTool[]; ready: boolean }> = [];
    for (const [name, conn] of this.connections) {
      servers.push({ name, tools: conn.getTools(), ready: conn.isReady() });
    }
    return servers;
  }

  async reconnect(serverName: string, workspaceRoot: string): Promise<void> {
    const existing = this.connections.get(serverName);
    if (existing) {
      existing.stop();
      this.connections.delete(serverName);
    }

    const config = await loadMcpConfig(workspaceRoot);
    const serverConfig = config.mcpServers[serverName];
    if (!serverConfig || serverConfig.disabled) return;

    const connection = new McpServerConnection(serverName, serverConfig);
    this.connections.set(serverName, connection);
    await connection.start();
  }

  stopAll(): void {
    for (const [, conn] of this.connections) {
      conn.stop();
    }
    this.connections.clear();
  }
}

export const mcpManager = new McpManager();
