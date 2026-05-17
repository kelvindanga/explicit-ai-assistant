export type McpToolId = "filesystem.readFile" | "terminal.runCommand" | "http.request";

export interface McpToolRequest {
  id: string;
  tool: McpToolId;
  args: Record<string, string>;
  description: string;
}

export interface McpToolResult {
  id: string;
  tool: McpToolId;
  output: string;
  approved: boolean;
}
