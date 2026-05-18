import * as vscode from "vscode";

export type ModelCategory = "code" | "chat" | "debug";
export type SidebarPlacement = "left" | "right" | "panel";

export interface ExplicitAIConfig {
  lmStudioBaseUrl: string;
  apiUrl: string;
  modelsUrl: string;
  apiKey: string;
  defaultModel: string;
  codeModel: string;
  chatModel: string;
  debugModel: string;
  systemPrompt: string;
  sidebarPlacement: SidebarPlacement;
  streaming: boolean;
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  enforceEnglish: boolean;
  requestTimeoutMs: number;
  showPayloadPreview: boolean;
  mcpEnabled: boolean;
  mcpFilesystem: boolean;
  mcpTerminal: boolean;
  mcpHttp: boolean;
}

export function getConfig(): ExplicitAIConfig {
  const cfg = vscode.workspace.getConfiguration("explicitAI");
  const base = cfg.get<string>("lmStudioBaseUrl", "http://localhost:1234").replace(/\/$/, "");
  return {
    lmStudioBaseUrl: base,
    apiUrl: cfg.get<string>("apiUrl", `${base}/v1/chat/completions`),
    modelsUrl: cfg.get<string>("modelsUrl", `${base}/v1/models`),
    apiKey: cfg.get<string>("apiKey", ""),
    defaultModel: cfg.get<string>("defaultModel", "meta-llama-3.1-8b-instruct"),
    codeModel: cfg.get<string>("codeModel", "codeqwen1.5-7b-chat"),
    chatModel: cfg.get<string>("chatModel", "meta-llama-3.1-8b-instruct"),
    debugModel: cfg.get<string>("debugModel", "meta-llama-3.1-8b-instruct"),
    systemPrompt: cfg.get<string>(
      "systemPrompt",
      "You are a helpful coding assistant. Answer using only the context the user explicitly provided."
    ),
    sidebarPlacement: cfg.get<SidebarPlacement>("sidebarPlacement", "left"),
    streaming: cfg.get<boolean>("streaming", true),
    temperature: cfg.get<number>("temperature", 0.7),
    maxTokens: cfg.get<number>("maxTokens", 4096),
    contextWindow: cfg.get<number>("contextWindow", 32768),
    enforceEnglish: cfg.get<boolean>("enforceEnglish", true),
    requestTimeoutMs: cfg.get<number>("requestTimeoutMs", 300000),
    showPayloadPreview: cfg.get<boolean>("showPayloadPreview", true),
    mcpEnabled: cfg.get<boolean>("mcpEnabled", false),
    mcpFilesystem: cfg.get<boolean>("mcpFilesystem", false),
    mcpTerminal: cfg.get<boolean>("mcpTerminal", false),
    mcpHttp: cfg.get<boolean>("mcpHttp", false)
  };
}

export function getModelForCategory(category: ModelCategory): string {
  const c = getConfig();
  const pick = (v: string) => (v.trim() ? v.trim() : c.defaultModel);
  switch (category) {
    case "code":
      return pick(c.codeModel);
    case "debug":
      return pick(c.debugModel);
    default:
      return pick(c.chatModel);
  }
}

export function onConfigChange(cb: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("explicitAI")) {
      cb();
    }
  });
}
