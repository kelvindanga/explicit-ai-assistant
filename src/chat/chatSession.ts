import * as vscode from "vscode";
import { ContextBuilder } from "../core/contextBuilder";
import { AttachedFile, pickFiles, readFileFromPath, resolveAtMentions } from "../core/fileAttachments";
import { getConfig, getModelForCategory, ModelCategory } from "../core/config";
import { LLMClient, ChatMessage } from "../core/llmClient";
import { fetchAvailableModels, ModelInfo } from "../core/modelRegistry";
import { executeMcpTool, isToolEnabled } from "../mcp/mcpExecutor";
import { McpToolId, McpToolRequest } from "../mcp/types";
import { truncateConversation, getTokenStats, estimateMessagesTokens } from "../core/tokenBudget";
import { compactConversation, needsCompacting } from "../core/compactor";
import { agentRegistry } from "../agents/agentRegistry";
import { fileTracker } from "../core/fileTracker";
import { executeBuiltinTool, ToolCall, BUILTIN_TOOLS } from "../tools/builtinTools";

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  timestamp: number;
  model?: string;
}

export interface WebviewBridge {
  post(message: unknown): void;
}

export class ChatSession {
  private history: ChatMessageRecord[] = [];
  private conversation: ChatMessage[] = [];
  private attachedFiles: AttachedFile[] = [];
  private mcpOutputs: string[] = [];
  private modelCategory: ModelCategory = "chat";
  private selectedModel = "";
  private models: ModelInfo[] = [];
  private llm = new LLMClient();
  private generating = false;
  private agentSystemPrompt: string | null = null;
  private chainDepth = 0;

  /** Called after each successful AI response — used for auto-saving threads */
  onResponseComplete: (() => void) | null = null;

  constructor(
    private readonly bridge: WebviewBridge
  ) {}

  async initialize(): Promise<void> {
    this.selectedModel = getModelForCategory(this.modelCategory);
    this.models = await fetchAvailableModels();
    this.conversation = [];
    this.postState();
  }

  async refreshModels(): Promise<void> {
    this.models = await fetchAvailableModels();
    this.bridge.post({ type: "models", models: this.models, selected: this.getSelectedModel() });
  }

  getSelectedModel(): string {
    if (this.selectedModel.trim()) {
      return this.selectedModel;
    }
    return getModelForCategory(this.modelCategory);
  }

  postState(): void {
    const cfg = getConfig();
    this.bridge.post({
      type: "init",
      settings: {
        streaming: cfg.streaming,
        enforceEnglish: cfg.enforceEnglish,
        showPayloadPreview: cfg.showPayloadPreview,
        mcpEnabled: cfg.mcpEnabled,
        mcpFilesystem: cfg.mcpFilesystem,
        mcpTerminal: cfg.mcpTerminal,
        mcpHttp: cfg.mcpHttp
      },
      models: this.models,
      modelCategory: this.modelCategory,
      selectedModel: this.getSelectedModel(),
      files: this.attachedFiles.map((f) => ({ id: f.id, name: f.name, path: f.fsPath })),
      messages: this.history
    });
  }

  setModel(category: ModelCategory, modelId?: string): void {
    this.modelCategory = category;
    // When switching category, use the category default if no specific model provided
    if (modelId?.trim()) {
      this.selectedModel = modelId.trim();
    } else {
      this.selectedModel = getModelForCategory(category);
    }
    this.bridge.post({
      type: "modelChanged",
      category,
      selectedModel: this.getSelectedModel(),
      models: this.models
    });
  }

  async attachSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("Select text in the editor first.");
      return;
    }
    const text = editor.document.getText(editor.selection).trim();
    if (!text) {
      return;
    }
    const name = `${vscode.workspace.asRelativePath(editor.document.uri)} (selection)`;
    this.attachedFiles.push({
      id: `sel_${Date.now()}`,
      name,
      fsPath: editor.document.uri.fsPath,
      content: text
    });
    this.postState();
  }

  async attachFiles(): Promise<void> {
    const picked = await pickFiles();
    this.attachedFiles.push(...picked);
    this.postState();
  }

  async attachPaths(paths: string[]): Promise<void> {
    for (const p of paths) {
      try {
        this.attachedFiles.push(await readFileFromPath(p));
      } catch {
        void vscode.window.showWarningMessage(`Could not attach: ${p}`);
      }
    }
    this.postState();
  }

  removeFile(id: string): void {
    this.attachedFiles = this.attachedFiles.filter((f) => f.id !== id);
    this.postState();
  }

  clear(): void {
    this.history = [];
    this.conversation = [];
    this.attachedFiles = [];
    this.mcpOutputs = [];
    this.bridge.post({ type: "cleared" });
    this.postState();
  }

  stop(): void {
    this.llm.cancel();
    this.generating = false;
    this.bridge.post({ type: "stopped" });
  }

  async runMcpTool(tool: McpToolId, args: Record<string, string>): Promise<void> {
    const req: McpToolRequest = {
      id: `mcp_${Date.now()}`,
      tool,
      args,
      description: tool
    };
    this.bridge.post({ type: "mcpRunning", tool });
    const result = await executeMcpTool(req);
    this.bridge.post({ type: "mcpDone", result });
    if (result.approved && result.output && !result.output.startsWith("(")) {
      this.mcpOutputs.push(`[${tool}]\n${result.output}`);
    }
    this.postState();
  }

  async send(prompt: string, pastedContext: string, _skipPreview?: boolean): Promise<void> {
    if (this.generating || !prompt.trim()) {
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // --- Parse @agent mentions (e.g. "@planner break this into tasks") ---
    let effectivePrompt = prompt;
    let inlineAgentPrompt: string | null = null;
    const agentMention = prompt.match(/^@([\w-]+)\s+/);
    if (agentMention) {
      const agent = agentRegistry.findByMention(agentMention[1]);
      if (agent) {
        inlineAgentPrompt = agent.systemPrompt;
        effectivePrompt = prompt.slice(agentMention[0].length); // strip the @agent prefix
        this.bridge.post({ type: "agentInvoked", agentId: agent.id, agentName: agent.name });
      }
    }

    // --- Parse #file references (e.g. "#src/main.ts" or "#package.json") ---
    const hashFiles: AttachedFile[] = [];
    const hashPattern = /#([\w.\/\\-]+\.\w+)/g;
    let hashMatch: RegExpExecArray | null;
    while ((hashMatch = hashPattern.exec(prompt)) !== null) {
      const rel = hashMatch[1].replace(/\\/g, "/");
      if (root) {
        try {
          // Try exact relative path first
          const fullPath = require("path").join(root, rel);
          hashFiles.push(await readFileFromPath(fullPath));
        } catch {
          // Try workspace search for bare filename
          try {
            const uris = await vscode.workspace.findFiles(`**/${rel}`, "**/node_modules/**", 1);
            if (uris.length > 0) {
              hashFiles.push(await readFileFromPath(uris[0].fsPath));
            }
          } catch { /* skip */ }
        }
      }
    }

    // --- Resolve @file mentions (existing behavior) ---
    const { files: atFiles } = await resolveAtMentions(prompt, root);
    const allFiles = [...this.attachedFiles, ...hashFiles];
    for (const f of atFiles) {
      if (!allFiles.some((x) => x.fsPath === f.fsPath)) {
        allFiles.push(f);
      }
    }

    // --- Parse @terminal mention (include recent terminal output) ---
    let extraContext = pastedContext;
    if (prompt.includes("@terminal")) {
      const { terminalWatcher } = await import("../core/terminalWatcher");
      const errors = terminalWatcher.getRecentErrors(5);
      if (errors.length > 0) {
        const terminalCtx = errors.map((e) => `[${e.terminal}] ${e.error}`).join("\n");
        extraContext += (extraContext ? "\n\n" : "") + "=== Recent terminal output ===\n" + terminalCtx;
      }
      effectivePrompt = effectivePrompt.replace(/@terminal/g, "").trim();
    }

    // --- Parse @workspace mention (include project structure) ---
    if (prompt.includes("@workspace") && root) {
      try {
        const { toolListDirectory } = await import("../tools/builtinTools");
        const tree = await toolListDirectory(".", 2);
        if (tree.success) {
          extraContext += (extraContext ? "\n\n" : "") + "=== Workspace structure ===\n" + tree.output.substring(0, 2000);
        }
      } catch { /* skip */ }
      effectivePrompt = effectivePrompt.replace(/@workspace/g, "").trim();
    }

    const built = await ContextBuilder.buildAsync({
      userPrompt: effectivePrompt,
      pastedContext: extraContext,
      files: allFiles,
      mcpOutputs: this.mcpOutputs,
      agentPrompt: inlineAgentPrompt ?? this.agentSystemPrompt
    });

    // Always send directly — no payload preview
    await this.executeGeneration(prompt, built.messages, allFiles);
  }

  async confirmPayload(prompt: string, pastedContext: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const { files: atFiles } = await resolveAtMentions(prompt, root);
    const allFiles = [...this.attachedFiles, ...atFiles];
    const built = ContextBuilder.build({
      userPrompt: prompt,
      pastedContext,
      files: allFiles,
      mcpOutputs: this.mcpOutputs,
      agentPrompt: this.agentSystemPrompt
    });
    await this.executeGeneration(prompt, built.messages, allFiles);
  }

  async regenerate(): Promise<void> {
    if (!this.conversation.length || this.generating) {
      return;
    }
    const lastAssistantIdx = this.history.map((m) => m.role).lastIndexOf("assistant");
    if (lastAssistantIdx >= 0) {
      this.history = this.history.slice(0, lastAssistantIdx);
    }
    if (this.conversation[this.conversation.length - 1]?.role === "assistant") {
      this.conversation.pop();
    }
    this.bridge.post({ type: "regenerateStart" });
    await this.runCompletion();
  }

  private async executeGeneration(
    displayPrompt: string,
    messages: ChatMessage[],
    files: AttachedFile[]
  ): Promise<void> {
    this.mcpOutputs = [];
    this.chainDepth = 0; // Reset chain depth for new user message
    const userMsg: ChatMessageRecord = {
      id: `u_${Date.now()}`,
      role: "user",
      content: displayPrompt,
      timestamp: Date.now()
    };
    this.history.push(userMsg);

    if (this.conversation.length === 0) {
      this.conversation = [...messages];
    } else {
      this.conversation[0] = messages[0];
      this.conversation.push(messages[messages.length - 1]);
    }
    this.attachedFiles = files;
    this.bridge.post({ type: "userMessage", message: userMsg, files: files.map((f) => f.name) });
    await this.runCompletion();
  }

  private async runCompletion(): Promise<void> {
    this.generating = true;
    const assistantId = `a_${Date.now()}`;
    const model = this.getSelectedModel();

    this.bridge.post({ type: "streamStart", id: assistantId, model });

    // Compact conversation if needed, then truncate as safety net
    let messages: ChatMessage[];
    if (needsCompacting([...this.conversation])) {
      const { compacted, droppedCount } = compactConversation([...this.conversation]);
      messages = compacted;
      if (droppedCount > 0) {
        this.bridge.post({ type: "compacted", droppedCount });
      }
    } else {
      messages = truncateConversation([...this.conversation]);
    }
    const stats = getTokenStats(messages);
    this.bridge.post({ type: "tokenStats", ...stats });

    let full = "";
    const inputTokens = estimateMessagesTokens(messages);
    let outputTokens = 0;
    const startTime = Date.now();

    // Send initial stats so the UI can show them
    this.bridge.post({ type: "streamStats", id: assistantId, inputTokens, outputTokens: 0, elapsed: 0 });

    try {
      full = await this.llm.completeWithEnglishGuard(
        {
          model,
          messages,
          stream: getConfig().streaming
        },
        getConfig().streaming
          ? {
              onToken: (chunk) => {
                full += chunk;
                outputTokens += Math.ceil(chunk.length / 3.5);
                this.bridge.post({ type: "streamDelta", id: assistantId, chunk });
                // Update token stats every ~10 tokens to avoid flooding
                if (outputTokens % 10 < 3) {
                  this.bridge.post({
                    type: "streamStats",
                    id: assistantId,
                    inputTokens,
                    outputTokens,
                    elapsed: Math.round((Date.now() - startTime) / 1000)
                  });
                }
              },
              onDone: (text) => {
                full = text;
              },
              onError: () => {}
            }
          : undefined
      );

      // Final stats
      outputTokens = Math.ceil(full.length / 3.5);
      this.bridge.post({
        type: "streamStats",
        id: assistantId,
        inputTokens,
        outputTokens,
        elapsed: Math.round((Date.now() - startTime) / 1000),
        done: true
      });

      const record: ChatMessageRecord = {
        id: assistantId,
        role: "assistant",
        content: full,
        timestamp: Date.now(),
        model
      };
      this.history.push(record);
      this.conversation.push({ role: "assistant", content: full });
      this.bridge.post({ type: "streamEnd", id: assistantId, message: record });

      // Notify host to auto-save thread
      this.onResponseComplete?.();

      // Detect and execute built-in tool calls from the response
      const toolCalls = this.detectBuiltinToolCalls(full);
      if (toolCalls.length > 0) {
        fileTracker.startCheckpoint(assistantId);
        await this.executeToolCalls(toolCalls);
        const checkpoint = fileTracker.commitCheckpoint();
        if (checkpoint && checkpoint.changes.length > 0) {
          this.bridge.post({
            type: "fileChangesTracked",
            messageId: assistantId,
            files: checkpoint.changes.map((c) => c.relativePath)
          });
        }
      } else {
        // Legacy MCP tool detection for terminal/http tools not covered by builtins
        const toolRequest = this.detectMcpToolRequest(full);
        if (toolRequest) {
          this.bridge.post({ type: "toolApproval", id: `tool_${Date.now()}`, tool: toolRequest.tool, args: toolRequest.args, description: toolRequest.description });
        }
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      const isTimeout = text.includes("stopped") || text.includes("abort") || text.includes("timeout");

      // Save partial content if we received any tokens before the error
      if (full.trim()) {
        const partialRecord: ChatMessageRecord = {
          id: assistantId,
          role: "assistant",
          content: full + "\n\n⚠️ _(response interrupted: " + (isTimeout ? "timeout" : "error") + ")_",
          timestamp: Date.now(),
          model
        };
        this.history.push(partialRecord);
        this.conversation.push({ role: "assistant", content: full });
        this.bridge.post({ type: "streamEnd", id: assistantId, message: partialRecord });

        // Auto-save thread with partial content so nothing is lost
        this.onResponseComplete?.();
      } else {
        // No content received at all — show error
        this.history.push({
          id: assistantId,
          role: "error",
          content: text,
          timestamp: Date.now()
        });
        this.bridge.post({ type: "error", id: assistantId, text });
      }
    } finally {
      this.generating = false;
    }
  }

  getHistory(): ChatMessageRecord[] {
    return [...this.history];
  }

  async undo(): Promise<void> {
    if (this.history.length === 0) return;
    const lastRole = this.history[this.history.length - 1]?.role;
    let removedAssistantId: string | undefined;
    let removedUserPrompt = "";
    if (lastRole === "assistant" || lastRole === "error") {
      const removed = this.history.pop();
      if (removed?.role === "assistant") removedAssistantId = removed.id;
      if (this.history.length && this.history[this.history.length - 1].role === "user") {
        const userMsg = this.history.pop();
        removedUserPrompt = userMsg?.content ?? "";
      }
    } else {
      const userMsg = this.history.pop();
      removedUserPrompt = userMsg?.content ?? "";
    }
    this.conversation = this.history
      .filter((m) => m.role !== "error")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // Revert file changes associated with the undone message
    let revertResult: { reverted: string[]; errors: string[] } | undefined;
    if (removedAssistantId && fileTracker.hasChanges(removedAssistantId)) {
      revertResult = await fileTracker.undoCheckpoint(removedAssistantId);
    }

    this.bridge.post({ type: "undone", messages: this.history, reverted: revertResult?.reverted ?? [], lastPrompt: removedUserPrompt });
  }

  async undoFrom(messageId?: string): Promise<void> {
    if (!messageId) {
      await this.undo();
      return;
    }
    // Find the user message and remove it + everything after it
    const idx = this.history.findIndex((m) => m.id === messageId);
    if (idx < 0) {
      await this.undo();
      return;
    }

    // Collect all assistant message IDs being removed (to revert their file changes)
    const removed = this.history.slice(idx);
    const assistantIds = removed.filter((m) => m.role === "assistant").map((m) => m.id);

    // Capture the user prompt being undone (first removed message if it's a user message)
    const removedUserMsg = removed.find((m) => m.role === "user");
    const removedUserPrompt = removedUserMsg?.content ?? "";

    this.history = this.history.slice(0, idx);
    this.conversation = this.history
      .filter((m) => m.role !== "error")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // Revert file changes for all removed assistant messages
    const allReverted: string[] = [];
    for (const aid of assistantIds) {
      if (fileTracker.hasChanges(aid)) {
        const result = await fileTracker.undoCheckpoint(aid);
        allReverted.push(...result.reverted);
      }
    }

    this.bridge.post({ type: "undone", messages: this.history, reverted: allReverted, lastPrompt: removedUserPrompt });
  }

  restoreFromHistory(messages: ChatMessageRecord[]): void {
    this.history = [...messages];
    this.conversation = messages
      .filter((m) => m.role !== "error")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    this.attachedFiles = [];
    this.mcpOutputs = [];
  }

  setAgentPrompt(prompt: string | null): void {
    this.agentSystemPrompt = prompt;
  }

  openSettings(): void {
    void vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@ext:local.explicit-ai-assistant"
    );
  }

  getMcpToolsEnabled(): Record<McpToolId, boolean> {
    return {
      "filesystem.readFile": isToolEnabled("filesystem.readFile"),
      "terminal.runCommand": isToolEnabled("terminal.runCommand"),
      "http.request": isToolEnabled("http.request")
    };
  }

  addMcpOutput(output: string): void {
    this.mcpOutputs.push(output);
  }

  /**
   * Manually compact the conversation — summarizes older messages
   * to free up context space.
   */
  compactNow(): void {
    if (this.conversation.length <= 4) {
      this.bridge.post({ type: "compactSkipped", reason: "Conversation too short to compact." });
      return;
    }
    const beforeTokens = getTokenStats(this.conversation);
    const { compacted, droppedCount } = compactConversation([...this.conversation]);
    if (droppedCount === 0) {
      this.bridge.post({ type: "compactSkipped", reason: "Nothing to compact." });
      return;
    }
    this.conversation = compacted;
    const afterStats = getTokenStats(this.conversation);
    const freed = beforeTokens.inputTokens - afterStats.inputTokens;
    this.bridge.post({ type: "compacted", droppedCount, freedTokens: freed });
    this.bridge.post({ type: "tokenStats", ...afterStats });
  }

  /**
   * Start a new session. Saves the current conversation as a thread
   * and resets to a clean state. Memory persists across sessions.
   */
  newSession(): { savedThread: boolean } {
    const hadMessages = this.history.length > 0;
    // The caller (ChatHost) is responsible for saving the thread before calling this
    this.history = [];
    this.conversation = [];
    this.attachedFiles = [];
    this.mcpOutputs = [];
    this.bridge.post({ type: "cleared" });
    this.postState();
    return { savedThread: hadMessages };
  }

  /**
   * Truncate tool output to prevent flooding the context window.
   * Small local models (2B-7B) have limited context — we cap tool output
   * to ~2000 chars and summarize what was truncated.
   */
  private truncateToolOutput(output: string, tool: string): string {
    const maxChars = 2000; // ~570 tokens — leaves room for the model to respond
    if (output.length <= maxChars) return output;

    const lines = output.split("\n");
    const totalLines = lines.length;

    // For file reads: show first and last portions
    if (tool === "readFile") {
      const headLines = lines.slice(0, 40).join("\n");
      const tailLines = lines.slice(-10).join("\n");
      const truncated = headLines.length + tailLines.length > maxChars
        ? lines.slice(0, 30).join("\n")
        : headLines + "\n\n... (" + (totalLines - 50) + " lines omitted) ...\n\n" + tailLines;
      return truncated.substring(0, maxChars) + `\n\n[Truncated: file has ${totalLines} lines total. Use readFile with specific sections if needed.]`;
    }

    // For search/list: show first results
    if (tool === "search" || tool === "listDir" || tool === "findFiles") {
      const kept = output.substring(0, maxChars);
      const keptLines = kept.split("\n").length;
      return kept + `\n\n[Showing ${keptLines} of ${totalLines} results. Narrow your search for more specific results.]`;
    }

    // Default: hard truncate
    return output.substring(0, maxChars) + `\n\n[Output truncated at ${maxChars} chars. Total: ${output.length} chars.]`;
  }

  /**
   * Detect built-in tool calls in the AI response.
   * Supports multiple formats:
   * 1. Structured: ```tool {"tool":"name","args":{}} ```
   * 2. JSON block: ```json {"tool":"name","args":{}} ```
   * 3. Natural language: "I'll read the file at src/foo.ts"
   */
  private detectBuiltinToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];

    // 1. Structured ```tool or ```json blocks
    const toolPattern = /```(?:tool|json)\s*\n?([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = toolPattern.exec(text)) !== null) {
      this.tryParseToolCall(match[1].trim(), calls);
    }
    if (calls.length > 0) return calls;

    // 2. Unclosed tool block (model stopped after the JSON but before closing ```)
    const unclosedPattern = /```(?:tool|json)\s*\n?([\s\S]+?)$/;
    const unclosedMatch = text.match(unclosedPattern);
    if (unclosedMatch) {
      this.tryParseToolCall(unclosedMatch[1].trim(), calls);
    }
    if (calls.length > 0) return calls;

    // 3. Bare JSON object with "tool" key (model didn't use backticks)
    const bareJsonPattern = /\{\s*"tool"\s*:\s*"(\w+)"\s*,\s*"args"\s*:\s*(\{[^}]*\})\s*\}/g;
    while ((match = bareJsonPattern.exec(text)) !== null) {
      try {
        const fullJson = match[0];
        this.tryParseToolCall(fullJson, calls);
      } catch { /* skip */ }
    }
    if (calls.length > 0) return calls;

    // 4. Natural language detection (for models that don't produce structured output)
    const nlCalls = this.detectNaturalLanguageToolCalls(text);
    return nlCalls;
  }

  private tryParseToolCall(jsonStr: string, calls: ToolCall[]): void {
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.tool && typeof parsed.tool === "string") {
        // Normalize args to strings (models sometimes send numbers/booleans)
        const args: Record<string, string> = {};
        if (parsed.args && typeof parsed.args === "object") {
          for (const [k, v] of Object.entries(parsed.args)) {
            args[k] = String(v);
          }
        }

        // Check if it's an MCP tool (format: "serverName/toolName")
        if (parsed.tool.includes("/")) {
          calls.push({
            id: `tc_${Date.now()}_${calls.length}`,
            tool: parsed.tool, // keep the full "server/tool" format
            args,
            category: "read", // MCP tools auto-execute in agentic mode
            description: `MCP: ${parsed.tool}`
          });
          return;
        }

        const toolDef = BUILTIN_TOOLS.find((t) => t.name === parsed.tool);
        if (toolDef) {
          calls.push({
            id: `tc_${Date.now()}_${calls.length}`,
            tool: parsed.tool,
            args,
            category: toolDef.category,
            description: `${parsed.tool}: ${JSON.stringify(args)}`
          });
        }
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  /**
   * Detect tool calls from natural language patterns.
   * Handles cases where the model says things like:
   * - "Let me read src/main.ts"
   * - "I'll search for 'KeycloakUserDto'"
   * - "Let me look at the file structure"
   */
  private detectNaturalLanguageToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];

    // Detect file read requests
    const readPatterns = [
      /(?:let me|I'll|I will|going to|need to)\s+(?:read|open|look at|check|view|see)\s+(?:the\s+)?(?:file\s+)?(?:at\s+)?[`'"]*([^\s`'",\n]+\.\w+)[`'""]*/gi,
      /(?:read(?:ing)?|open(?:ing)?)\s+(?:the\s+)?(?:file\s+)?[`'"]*([^\s`'",\n]+\.\w+)[`'""]*/gi
    ];
    for (const pat of readPatterns) {
      let m: RegExpExecArray | null;
      while ((m = pat.exec(text)) !== null) {
        const filePath = m[1].trim();
        if (filePath.includes("/") || filePath.includes("\\") || filePath.match(/\.\w{1,10}$/)) {
          calls.push({
            id: `tc_${Date.now()}_${calls.length}`,
            tool: "readFile",
            args: { path: filePath },
            category: "read",
            description: `Read file: ${filePath}`
          });
        }
      }
      if (calls.length > 0) return calls;
    }

    // Detect search requests
    const searchPatterns = [
      /(?:let me|I'll|I will)\s+search\s+(?:for\s+)?[`'"]+([^`'"]+)[`'"]+/gi,
      /(?:searching|grep(?:ping)?)\s+(?:for\s+)?[`'"]+([^`'"]+)[`'"]+/gi
    ];
    for (const pat of searchPatterns) {
      let m: RegExpExecArray | null;
      while ((m = pat.exec(text)) !== null) {
        calls.push({
          id: `tc_${Date.now()}_${calls.length}`,
          tool: "search",
          args: { query: m[1].trim() },
          category: "read",
          description: `Search: ${m[1].trim()}`
        });
      }
      if (calls.length > 0) return calls;
    }

    // Detect list directory requests
    const listPatterns = [
      /(?:let me|I'll)\s+(?:list|show|look at)\s+(?:the\s+)?(?:directory|folder|structure)\s*(?:of\s+)?[`'"]*([^\s`'"}\n]*)[`'""]*/gi
    ];
    for (const pat of listPatterns) {
      let m: RegExpExecArray | null;
      while ((m = pat.exec(text)) !== null) {
        calls.push({
          id: `tc_${Date.now()}_${calls.length}`,
          tool: "listDir",
          args: { path: m[1]?.trim() || "." },
          category: "read",
          description: `List directory: ${m[1]?.trim() || "."}`
        });
      }
      if (calls.length > 0) return calls;
    }

    // Detect find files requests
    const findPatterns = [
      /(?:let me|I'll)\s+find\s+(?:files?\s+)?(?:matching|named|called)\s+[`'"]*([^\s`'"}\n]+)[`'""]*/gi,
      /(?:find(?:ing)?)\s+(?:all\s+)?(?:files?\s+)?(?:matching|named|like)\s+[`'"]*([^\s`'"}\n]+)[`'""]*/gi
    ];
    for (const pat of findPatterns) {
      let m: RegExpExecArray | null;
      while ((m = pat.exec(text)) !== null) {
        const pattern = m[1].trim();
        calls.push({
          id: `tc_${Date.now()}_${calls.length}`,
          tool: "findFiles",
          args: { pattern: pattern.includes("*") ? pattern : `**/*${pattern}*` },
          category: "read",
          description: `Find files: ${pattern}`
        });
      }
      if (calls.length > 0) return calls;
    }

    return calls;
  }

  /**
   * Execute detected tool calls.
   * In agentic mode: ALL tools auto-execute (reads + writes) with undo tracking.
   * In supervised mode: reads auto-execute, writes need approval.
   * After each tool, the AI auto-continues to chain actions.
   */
  private async executeToolCalls(calls: ToolCall[]): Promise<void> {
    const agenticMode = vscode.workspace.getConfiguration("explicitAI").get<boolean>("agenticMode", true);
    const maxChainDepth = 10; // prevent infinite loops

    for (const call of calls) {
      // Handle MCP tools (format: "serverName/toolName")
      if (call.tool.includes("/")) {
        const [serverName, toolName] = call.tool.split("/", 2);
        this.bridge.post({ type: "toolExecuting", tool: call.tool, args: call.args });
        try {
          const { mcpManager } = await import("../mcp/mcpClient");
          const output = await mcpManager.callTool(serverName, toolName, call.args);
          const truncatedOutput = this.truncateToolOutput(output, call.tool);
          this.bridge.post({ type: "builtinToolResult", result: { id: call.id, tool: call.tool, success: true, output: truncatedOutput } });
          this.conversation.push({ role: "user", content: `[MCP tool result: ${call.tool}]\n${truncatedOutput}` });
          this.mcpOutputs.push(`[${call.tool}]\n${truncatedOutput}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.bridge.post({ type: "builtinToolResult", result: { id: call.id, tool: call.tool, success: false, output: errMsg } });
          this.conversation.push({ role: "user", content: `[MCP tool error: ${call.tool}] ${errMsg}` });
        }
        continue;
      }

      if (call.category === "read" || (agenticMode && call.category === "write")) {
        // Auto-execute
        this.bridge.post({ type: "toolExecuting", tool: call.tool, args: call.args });
        const result = await executeBuiltinTool(call);
        this.bridge.post({ type: "builtinToolResult", result });

        // Add result to conversation
        const truncatedOutput = this.truncateToolOutput(result.output, call.tool);
        this.conversation.push({
          role: "user",
          content: `[Tool result: ${call.tool}]\n${truncatedOutput}`
        });
        this.mcpOutputs.push(`[${call.tool}]\n${truncatedOutput}`);
      } else {
        // Supervised mode: write/shell tools need approval
        this.bridge.post({
          type: "builtinToolApproval",
          id: call.id,
          tool: call.tool,
          args: call.args,
          category: call.category,
          description: call.description
        });
        return; // Stop chaining — wait for user approval
      }
    }

    // Auto-continue: let the AI chain more actions (with rate limit delay)
    if (this.chainDepth < maxChainDepth) {
      this.chainDepth++;
      // Add delay between chain steps to avoid rate limiting on cloud APIs
      await new Promise((r) => setTimeout(r, 1000));
      await this.runCompletion();
    } else {
      this.chainDepth = 0;
      this.bridge.post({ type: "chainLimitReached" });
    }
  }

  /**
   * Execute an approved built-in tool (called from UI after user approves).
   */
  async executeApprovedBuiltinTool(tool: string, args: Record<string, string>): Promise<void> {
    const toolDef = BUILTIN_TOOLS.find((t) => t.name === tool);
    if (!toolDef) return;

    const call: ToolCall = {
      id: `tc_${Date.now()}`,
      tool,
      args,
      category: toolDef.category,
      description: `${tool}: ${JSON.stringify(args)}`
    };

    // Track file changes for undo
    const lastAssistant = this.history.filter((m) => m.role === "assistant").pop();
    if (lastAssistant && toolDef.category === "write") {
      fileTracker.startCheckpoint(lastAssistant.id);
    }

    this.bridge.post({ type: "toolExecuting", tool, args });
    const result = await executeBuiltinTool(call);
    this.bridge.post({ type: "builtinToolResult", result });

    // Commit file change tracking
    if (lastAssistant && toolDef.category === "write") {
      const checkpoint = fileTracker.commitCheckpoint();
      if (checkpoint && checkpoint.changes.length > 0) {
        this.bridge.post({
          type: "fileChangesTracked",
          messageId: lastAssistant.id,
          files: checkpoint.changes.map((c) => c.relativePath)
        });
      }
    }

    // Add to conversation context — truncate for small models
    const truncatedOutput = this.truncateToolOutput(result.output, tool);
    this.conversation.push({
      role: "user",
      content: `[Tool result: ${tool}]\n${truncatedOutput}`
    });
    this.mcpOutputs.push(`[${tool}]\n${truncatedOutput}`);

    // Continue the conversation with the tool result
    await this.runCompletion();
  }

  /**
   * Detect MCP-specific tool requests (terminal, HTTP) from AI response.
   * File reads are handled by detectNaturalLanguageToolCalls via builtins.
   */
  private detectMcpToolRequest(text: string): { tool: McpToolId; args: Record<string, string>; description: string } | null {
    const lower = text.toLowerCase();

    // Detect terminal/command requests
    const cmdPatterns = [
      /(?:run|execute|terminal\.runcommand)[:\s]*[`'"]*([^`'"}\n]+)[`'""]*/i,
      /(?:I'll run|Let me run|Running)[:\s]*[`'"]*([^`'"}\n]+)[`'""]*/i,
      /command[:\s]*[`'"]*([^`'"}\n]+)[`'""]*/i
    ];
    for (const pat of cmdPatterns) {
      const m = text.match(pat);
      if (m && m[1] && (lower.includes("terminal") || lower.includes("run") || lower.includes("command") || lower.includes("execute"))) {
        return { tool: "terminal.runCommand", args: { command: m[1].trim() }, description: `Run command: ${m[1].trim()}` };
      }
    }

    // Detect HTTP requests
    const httpPatterns = [
      /(?:http\.request|make a (?:get|post|put|delete) request)[:\s]*[`'"]*([^\s`'"}\n]+)[`'""]*/i,
      /(?:fetch|request|GET|POST|PUT|DELETE)\s+(https?:\/\/[^\s`'"}\n]+)/i
    ];
    for (const pat of httpPatterns) {
      const m = text.match(pat);
      if (m && m[1]) {
        const url = m[1].trim();
        const methodMatch = text.match(/\b(GET|POST|PUT|DELETE|PATCH)\b/i);
        const method = methodMatch ? methodMatch[1].toUpperCase() : "GET";
        return { tool: "http.request", args: { url, method }, description: `HTTP ${method} ${url}` };
      }
    }

    return null;
  }

  async executeApprovedTool(tool: McpToolId, args: Record<string, string>): Promise<void> {
    const req: McpToolRequest = {
      id: `mcp_${Date.now()}`,
      tool,
      args,
      description: tool
    };
    // Execute directly (user already approved via the popup)
    let output: string;
    try {
      const result = await executeMcpTool(req);
      output = result.output;
      if (result.approved && output && !output.startsWith("(")) {
        this.mcpOutputs.push(`[${tool}]\n${output}`);
      }
    } catch (err) {
      output = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.bridge.post({ type: "toolResult", tool, output });
    this.postState();
  }
}
