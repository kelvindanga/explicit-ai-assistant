import * as vscode from "vscode";
import { getConfig } from "./config";

export type HealthStatus = "connected" | "disconnected" | "checking";

export interface EngineInfo {
  name: string;
  models: number;
  baseUrl: string;
}

/**
 * Detects the AI engine/provider from the API response.
 * Supports any OpenAI-compatible API: LM Studio, Ollama, vLLM, LocalAI,
 * text-generation-webui, llama.cpp, OpenAI, Together, Groq, etc.
 */
function detectEngine(baseUrl: string, headers: Record<string, string>, body?: unknown): string {
  const url = baseUrl.toLowerCase();

  // Check response headers for known providers
  const server = headers["server"] || headers["x-powered-by"] || "";
  if (server.toLowerCase().includes("ollama")) return "Ollama";
  if (server.toLowerCase().includes("vllm")) return "vLLM";
  if (server.toLowerCase().includes("localai")) return "LocalAI";
  if (server.toLowerCase().includes("llama.cpp") || server.toLowerCase().includes("llamacpp")) return "llama.cpp";

  // Check URL patterns
  if (url.includes("openai.com")) return "OpenAI";
  if (url.includes("api.together")) return "Together AI";
  if (url.includes("api.groq.com")) return "Groq";
  if (url.includes("api.anthropic.com")) return "Anthropic";
  if (url.includes("api.mistral.ai")) return "Mistral";
  if (url.includes("api.deepseek.com")) return "DeepSeek";
  if (url.includes("api.fireworks.ai")) return "Fireworks";
  if (url.includes("api.perplexity.ai")) return "Perplexity";
  if (url.includes("generativelanguage.googleapis.com")) return "Google AI";
  if (url.includes("api.openrouter.ai")) return "OpenRouter";
  if (url.includes("localhost:11434") || url.includes("127.0.0.1:11434")) return "Ollama";
  if (url.includes("localhost:1234") || url.includes("127.0.0.1:1234")) return "LM Studio";
  if (url.includes("localhost:5000") || url.includes("127.0.0.1:5000")) return "LocalAI";
  if (url.includes("localhost:8080") || url.includes("127.0.0.1:8080")) return "llama.cpp";

  // Check response body for hints
  if (body && typeof body === "object") {
    const str = JSON.stringify(body).toLowerCase();
    if (str.includes("lmstudio") || str.includes("lm-studio") || str.includes("lm studio")) return "LM Studio";
    if (str.includes("ollama")) return "Ollama";
    if (str.includes("vllm")) return "vLLM";
    if (str.includes("localai")) return "LocalAI";
    if (str.includes("text-generation-webui") || str.includes("oobabooga")) return "text-gen-webui";
  }

  // Default: show the host
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return `Local (port ${parsed.port})`;
    }
    return parsed.hostname;
  } catch {
    return "AI Engine";
  }
}

export class ModelHealthCheck {
  private statusBar: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentStatus: HealthStatus = "checking";
  private engineInfo: EngineInfo = { name: "AI Engine", models: 0, baseUrl: "" };

  constructor() {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.statusBar.command = "explicitAI.checkHealth";
    this.statusBar.show();
    this.updateDisplay("checking");
  }

  start(intervalMs = 60_000): void {
    this.check();
    this.timer = setInterval(() => this.check(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stop();
    this.statusBar.dispose();
  }

  getStatus(): HealthStatus {
    return this.currentStatus;
  }

  getEngineInfo(): EngineInfo {
    return { ...this.engineInfo };
  }

  async check(): Promise<HealthStatus> {
    this.updateDisplay("checking");
    const cfg = getConfig();
    this.engineInfo.baseUrl = cfg.lmStudioBaseUrl;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(cfg.modelsUrl, {
        method: "GET",
        signal: controller.signal,
        headers: cfg.apiKey ? { "Authorization": `Bearer ${cfg.apiKey}` } : {}
      });
      clearTimeout(timeout);

      if (res.ok) {
        // Extract headers for engine detection
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

        // Parse body to count models and detect engine
        let body: unknown = null;
        let modelCount = 0;
        try {
          body = await res.json();
          if (body && typeof body === "object" && "data" in body && Array.isArray((body as { data: unknown[] }).data)) {
            modelCount = (body as { data: unknown[] }).data.length;
          }
        } catch { /* non-JSON response is fine */ }

        const engineName = detectEngine(cfg.lmStudioBaseUrl, headers, body);
        this.engineInfo = { name: engineName, models: modelCount, baseUrl: cfg.lmStudioBaseUrl };

        this.updateDisplay("connected");
        return "connected";
      }
      this.updateDisplay("disconnected");
      return "disconnected";
    } catch {
      // Try to detect engine from URL even when disconnected
      this.engineInfo.name = detectEngine(cfg.lmStudioBaseUrl, {});
      this.updateDisplay("disconnected");
      return "disconnected";
    }
  }

  private updateDisplay(status: HealthStatus): void {
    this.currentStatus = status;
    const name = this.engineInfo.name;
    const modelHint = this.engineInfo.models > 0 ? ` (${this.engineInfo.models} models)` : "";

    switch (status) {
      case "connected":
        this.statusBar.text = `$(check) ${name}`;
        this.statusBar.tooltip = `${name}: Connected${modelHint}\n${this.engineInfo.baseUrl}`;
        this.statusBar.backgroundColor = undefined;
        break;
      case "disconnected":
        this.statusBar.text = `$(error) ${name}`;
        this.statusBar.tooltip = `${name}: Disconnected — click to retry\n${this.engineInfo.baseUrl}`;
        this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
      case "checking":
        this.statusBar.text = `$(sync~spin) ${name}`;
        this.statusBar.tooltip = `Checking connection to ${this.engineInfo.baseUrl}...`;
        this.statusBar.backgroundColor = undefined;
        break;
    }
  }
}
