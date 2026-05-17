import * as vscode from "vscode";
import { ChatSession, WebviewBridge } from "../chat/chatSession";
import { ModelCategory } from "../core/config";
import { McpToolId } from "../mcp/types";
import { loadMcpConfig, saveMcpConfig, openMcpConfigInEditor } from "../mcp/mcpConfig";
import { agentRegistry, AgentConfig } from "../agents/agentRegistry";
import { threadManager } from "../threads/threadStore";
import { buildChatWebviewHtml } from "./webviewHtml";
import { getGitDiff } from "../core/gitContext";
import { exportAsMarkdown, exportAsJson } from "../core/exportConversation";
import { projectMemory } from "../core/memory";
import { planManager } from "../core/planner";

type WorkflowMode = "vibe" | "agile";

type Inbound =
  | { type: "ready" }
  | { type: "send"; prompt: string; context: string; skipPreview?: boolean }
  | { type: "confirmPayload"; prompt: string; context: string }
  | { type: "cancelPayload" }
  | { type: "clear" }
  | { type: "stop" }
  | { type: "regenerate" }
  | { type: "attachSelection" }
  | { type: "attachFiles" }
  | { type: "removeFile"; id: string }
  | { type: "setModel"; category: ModelCategory; modelId?: string }
  | { type: "refreshModels" }
  | { type: "openSettings" }
  | { type: "mcpRun"; tool: McpToolId; args: Record<string, string> }
  | { type: "dropPaths"; paths: string[] }
  | { type: "setMode"; mode: WorkflowMode }
  | { type: "getThreads" }
  | { type: "switchThread"; threadId: string }
  | { type: "revertThread"; threadId: string }
  | { type: "deleteThread"; threadId: string }
  | { type: "renameThread"; threadId: string; label: string }
  | { type: "getAgents" }
  | { type: "addAgent" }
  | { type: "selectAgent"; agentId: string }
  | { type: "removeAgent"; agentId: string }
  | { type: "openMcpConfig" }
  | { type: "toggleMcp"; key: string; value: boolean }
  | { type: "attachActiveFile" }
  | { type: "dropFiles" }
  | { type: "getMcpServers" }
  | { type: "toggleMcpServer"; serverName: string; disabled: boolean }
  | { type: "undo"; messageId?: string }
  | { type: "approveTool"; tool: string; args: Record<string, string> }
  | { type: "denyTool" }
  | { type: "applyCode"; filePath: string; code: string }
  | { type: "attachGitDiff" }
  | { type: "exportMarkdown" }
  | { type: "exportJson" }
  | { type: "newSession" }
  | { type: "compactNow" }
  | { type: "remember"; content: string; category: string; tags: string[] }
  | { type: "getMemories" }
  | { type: "forgetMemory"; id: string }
  | { type: "getPlan" }
  | { type: "createPlan"; title: string; goal: string }
  | { type: "setActivePlan"; planId: string }
  | { type: "addPlanTask"; title: string; description: string; priority: string }
  | { type: "addDetailedTask"; title: string; description: string; priority: string; storyPoints?: number; acceptanceCriteria?: string[]; dependsOn?: string[] }
  | { type: "updateTaskStatus"; taskId: string; status: string }
  | { type: "setAcceptanceCriteria"; taskId: string; criteria: string[] }
  | { type: "setStoryPoints"; taskId: string; points: number }
  | { type: "setDependencies"; taskId: string; dependsOn: string[] }
  | { type: "createSprint"; name: string; goal: string; durationDays?: number }
  | { type: "addTaskToSprint"; sprintId: string; taskId: string }
  | { type: "startSprint"; sprintId: string }
  | { type: "completeSprint"; sprintId: string }
  | { type: "addRetrospective"; wentWell: string[]; needsImprovement: string[]; actionItems: string[]; sprintId?: string }
  | { type: "getRetrospectives" }
  | { type: "autoPlan"; requirement: string }
  | { type: "approveBuiltinTool"; tool: string; args: Record<string, string> }
  | { type: "denyBuiltinTool" }
  | { type: "suggestFiles"; query: string };

export class ChatHost {
  static current: ChatHost | undefined;
  readonly session: ChatSession;
  private currentMode: WorkflowMode | null = null;
  private activeAgentId: string | null = null;

  constructor(
    private readonly webview: vscode.Webview
  ) {
    ChatHost.current = this;
    const bridge: WebviewBridge = {
      post: (msg) => void webview.postMessage(msg)
    };
    this.session = new ChatSession(bridge);
    this.session.onResponseComplete = () => this.autoSaveCurrentThread();
    webview.onDidReceiveMessage((msg: Inbound) => this.onMessage(msg));
  }

  setHtml(extensionUri: vscode.Uri): void {
    this.webview.html = buildChatWebviewHtml(this.webview, extensionUri);
  }

  /** Called by extension when active editor changes */
  notifyActiveFile(fsPath: string, relativeName: string): void {
    this.webview.postMessage({ type: "activeFile", path: fsPath, name: relativeName });
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async onMessage(msg: Inbound): Promise<void> {
    const s = this.session;
    switch (msg.type) {
      case "ready":
        void s.initialize();
        // Send current active file on ready
        this.sendCurrentActiveFile();
        // Send health status
        void this.checkAndReportHealth();
        // Send agents list for @ autocomplete
        void this.sendAgents();
        break;
      case "send":
        void s.send(msg.prompt, msg.context, msg.skipPreview);
        break;
      case "confirmPayload":
        void s.confirmPayload(msg.prompt, msg.context);
        break;
      case "clear":
        s.clear();
        this.currentMode = null;
        break;
      case "stop":
        s.stop();
        break;
      case "regenerate":
        void s.regenerate();
        break;
      case "attachSelection":
        void s.attachSelection();
        break;
      case "attachFiles":
        void s.attachFiles();
        break;
      case "removeFile":
        s.removeFile(msg.id);
        break;
      case "setModel":
        s.setModel(msg.category, msg.modelId);
        break;
      case "refreshModels":
        void s.refreshModels();
        break;
      case "openSettings":
        s.openSettings();
        break;
      case "mcpRun":
        void s.runMcpTool(msg.tool, msg.args);
        break;
      case "dropPaths":
        void this.resolveAndAttachPaths(msg.paths);
        break;
      case "dropFiles":
        // Webview can't get file paths from drag — use file picker as fallback
        void s.attachFiles();
        break;
      case "attachActiveFile":
        void this.attachCurrentActiveFile();
        break;
      case "setMode":
        this.currentMode = msg.mode;
        this.autoSaveThread();
        break;
      case "getThreads":
        await this.sendThreads();
        break;
      case "switchThread":
        await this.switchToThread(msg.threadId);
        break;
      case "revertThread":
        await this.revertToThread(msg.threadId);
        break;
      case "deleteThread":
        await this.deleteThread(msg.threadId);
        break;
      case "renameThread":
        await this.renameThread(msg.threadId, msg.label);
        break;
      case "getAgents":
        await this.sendAgents();
        break;
      case "addAgent":
        await this.promptAddAgent();
        break;
      case "selectAgent":
        this.activeAgentId = msg.agentId;
        await this.applyAgent(msg.agentId);
        break;
      case "removeAgent":
        await this.removeAgent(msg.agentId);
        break;
      case "openMcpConfig":
        await this.openMcpConfig();
        break;
      case "toggleMcp":
        await this.toggleMcpSetting(msg.key, msg.value);
        break;
      case "getMcpServers":
        await this.sendMcpServers();
        break;
      case "toggleMcpServer":
        await this.toggleMcpServer(msg.serverName, msg.disabled);
        break;
      case "undo":
        await this.session.undoFrom(msg.messageId);
        break;
      case "approveTool":
        void this.session.executeApprovedTool(msg.tool as McpToolId, msg.args);
        break;
      case "denyTool":
        this.webview.postMessage({ type: "toolDenied" });
        break;
      case "applyCode":
        await this.applyCodeToFile(msg.filePath, msg.code);
        break;
      case "attachGitDiff":
        await this.attachGitDiff();
        break;
      case "exportMarkdown":
        await exportAsMarkdown(this.session.getHistory());
        break;
      case "exportJson":
        await exportAsJson(this.session.getHistory());
        break;
      case "newSession":
        await this.startNewSession();
        break;
      case "compactNow":
        this.session.compactNow();
        break;
      case "remember":
        await this.rememberContext(msg.content, msg.category, msg.tags);
        break;
      case "getMemories":
        await this.sendMemories();
        break;
      case "forgetMemory":
        await this.forgetMemory(msg.id);
        break;
      case "getPlan":
        await this.sendPlan();
        break;
      case "createPlan":
        await this.createPlan(msg.title, msg.goal);
        break;
      case "setActivePlan":
        await this.setActivePlan(msg.planId);
        break;
      case "addPlanTask":
        await this.addPlanTask(msg.title, msg.description, msg.priority);
        break;
      case "addDetailedTask":
        await this.addDetailedTask(msg.title, msg.description, msg.priority, msg.storyPoints, msg.acceptanceCriteria, msg.dependsOn);
        break;
      case "updateTaskStatus":
        await this.updateTaskStatus(msg.taskId, msg.status);
        break;
      case "setAcceptanceCriteria":
        await this.setTaskAcceptanceCriteria(msg.taskId, msg.criteria);
        break;
      case "setStoryPoints":
        await this.setTaskStoryPoints(msg.taskId, msg.points);
        break;
      case "setDependencies":
        await this.setTaskDependencies(msg.taskId, msg.dependsOn);
        break;
      case "createSprint":
        await this.createSprint(msg.name, msg.goal, msg.durationDays);
        break;
      case "addTaskToSprint":
        await this.addTaskToSprint(msg.sprintId, msg.taskId);
        break;
      case "startSprint":
        await this.startSprint(msg.sprintId);
        break;
      case "completeSprint":
        await this.completeSprint(msg.sprintId);
        break;
      case "addRetrospective":
        await this.addRetrospective(msg.wentWell, msg.needsImprovement, msg.actionItems, msg.sprintId);
        break;
      case "getRetrospectives":
        await this.sendRetrospectives();
        break;
      case "autoPlan":
        await this.autoPlan(msg.requirement);
        break;
      case "approveBuiltinTool":
        void this.session.executeApprovedBuiltinTool(msg.tool, msg.args);
        break;
      case "denyBuiltinTool":
        this.webview.postMessage({ type: "builtinToolDenied" });
        break;
      case "suggestFiles":
        await this.suggestFiles(msg.query);
        break;
    }
  }

  private sendCurrentActiveFile(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const fsPath = editor.document.uri.fsPath;
      const name = vscode.workspace.asRelativePath(editor.document.uri);
      this.webview.postMessage({ type: "activeFile", path: fsPath, name });
    }
  }

  private async checkAndReportHealth(): Promise<void> {
    // Reuse the health check module's logic — just report status to webview
    const { getConfig } = await import("../core/config");
    const cfg = getConfig();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(cfg.modelsUrl, { method: "GET", signal: controller.signal });
      clearTimeout(timeout);
      const status = res.ok ? "connected" : "disconnected";
      // Detect engine name from URL
      const url = cfg.lmStudioBaseUrl.toLowerCase();
      let engine = "AI Engine";
      if (url.includes("localhost:1234") || url.includes("127.0.0.1:1234")) engine = "LM Studio";
      else if (url.includes("localhost:11434") || url.includes("127.0.0.1:11434")) engine = "Ollama";
      else if (url.includes("openai.com")) engine = "OpenAI";
      else if (url.includes("api.groq.com")) engine = "Groq";
      else if (url.includes("api.together")) engine = "Together AI";
      else if (url.includes("localhost:8080")) engine = "llama.cpp";
      else { try { engine = new URL(cfg.lmStudioBaseUrl).hostname; } catch { /* */ } }
      this.webview.postMessage({ type: "healthStatus", status, engine });
    } catch {
      this.webview.postMessage({ type: "healthStatus", status: "disconnected", engine: "AI Engine" });
    }
  }

  private async attachCurrentActiveFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await this.session.attachPaths([editor.document.uri.fsPath]);
    }
  }

  /**
   * Resolve dropped paths — handles absolute paths, relative paths,
   * and bare filenames (from VS Code explorer drag which only gives the name).
   */
  private async resolveAndAttachPaths(paths: string[]): Promise<void> {
    const root = this.getWorkspaceRoot();
    const resolved: string[] = [];

    for (const p of paths) {
      const trimmed = p.trim();
      if (!trimmed) continue;

      // Already absolute
      if (trimmed.match(/^[A-Z]:\\/i) || trimmed.startsWith("/")) {
        resolved.push(trimmed);
        continue;
      }

      // Relative path — resolve from workspace root
      if (root && (trimmed.includes("/") || trimmed.includes("\\"))) {
        const path = await import("path");
        resolved.push(path.join(root, trimmed));
        continue;
      }

      // Bare filename (e.g. "chatSession.ts") — search workspace for it
      if (root && trimmed.includes(".")) {
        try {
          const uris = await vscode.workspace.findFiles(`**/${trimmed}`, "**/node_modules/**", 1);
          if (uris.length > 0) {
            resolved.push(uris[0].fsPath);
            continue;
          }
        } catch { /* fall through */ }
      }

      // Last resort: try as relative from root
      if (root) {
        const path = await import("path");
        resolved.push(path.join(root, trimmed));
      }
    }

    if (resolved.length > 0) {
      await this.session.attachPaths(resolved);
    }
  }

  private async attachGitDiff(): Promise<void> {
    const diff = await getGitDiff();
    if (!diff) {
      this.webview.postMessage({ type: "gitDiffEmpty" });
      return;
    }
    this.session.addMcpOutput("[git diff]\n" + diff);
    this.webview.postMessage({ type: "gitDiffAttached", preview: diff.substring(0, 200) });
  }

  private autoSaveThread(): void {
    const root = this.getWorkspaceRoot();
    if (!root || !this.currentMode) return;
    const history = this.session.getHistory();
    if (history.length > 0) {
      threadManager.saveSnapshot(history, this.currentMode, this.activeAgentId ?? undefined);
      void threadManager.persist(root);
    }
  }

  private async sendThreads(): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (root) await threadManager.load(root);
    const threads = threadManager.getAll();
    const active = threadManager.getActive();
    this.webview.postMessage({ type: "threads", threads, activeId: active?.id ?? null });
  }

  private async switchToThread(threadId: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await threadManager.load(root);
    const thread = threadManager.setActive(threadId);
    if (thread) {
      await threadManager.persist(root);
      this.session.restoreFromHistory(thread.messages);
      this.currentMode = thread.mode;
      this.webview.postMessage({ type: "threadRestored", messages: thread.messages, mode: thread.mode });
    }
  }

  private async revertToThread(threadId: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await threadManager.load(root);
    const messages = threadManager.revertTo(threadId);
    if (messages) {
      await threadManager.persist(root);
      const thread = threadManager.getActive();
      this.session.restoreFromHistory(messages);
      this.currentMode = thread?.mode ?? this.currentMode;
      this.webview.postMessage({ type: "threadRestored", messages, mode: thread?.mode ?? this.currentMode });
    }
  }

  private async deleteThread(threadId: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await threadManager.load(root);
    threadManager.deleteThread(threadId);
    await threadManager.persist(root);
    await this.sendThreads();
  }

  private async renameThread(threadId: string, label: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await threadManager.load(root);
    threadManager.renameThread(threadId, label);
    await threadManager.persist(root);
    await this.sendThreads();
  }

  private async sendAgents(): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (root) await agentRegistry.load(root);
    this.webview.postMessage({ type: "agents", agents: agentRegistry.getAll() });
  }

  private async promptAddAgent(): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: "Agent name", placeHolder: "e.g. Code Reviewer" });
    if (!name) return;
    const description = await vscode.window.showInputBox({ prompt: "Agent description", placeHolder: "What does this agent do?" }) ?? "";
    const systemPrompt = await vscode.window.showInputBox({ prompt: "System prompt for this agent", placeHolder: "You are a..." }) ?? "";

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const agent: AgentConfig = { id, name, description, systemPrompt };

    const root = this.getWorkspaceRoot();
    if (root) {
      await agentRegistry.save(root, agent);
      await this.sendAgents();
      void vscode.window.showInformationMessage(`Agent "${name}" added.`);
    }
  }

  private async applyAgent(agentId: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (root) await agentRegistry.load(root);
    const agent = agentRegistry.get(agentId);
    if (agent) {
      this.session.setAgentPrompt(agent.systemPrompt);
      void vscode.window.showInformationMessage(`Agent "${agent.name}" active.`);
    }
  }

  private async removeAgent(agentId: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await agentRegistry.remove(root, agentId);
    if (this.activeAgentId === agentId) {
      this.activeAgentId = null;
      this.session.setAgentPrompt(null);
    }
    await this.sendAgents();
  }

  private async openMcpConfig(): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (root) await openMcpConfigInEditor(root);
  }

  private async toggleMcpSetting(key: string, value: boolean): Promise<void> {
    const validKeys = ["mcpEnabled", "mcpFilesystem", "mcpTerminal", "mcpHttp"];
    if (!validKeys.includes(key)) return;
    const cfg = vscode.workspace.getConfiguration("explicitAI");
    await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
    const updated = {
      mcpEnabled: cfg.get<boolean>("mcpEnabled", false),
      mcpFilesystem: cfg.get<boolean>("mcpFilesystem", false),
      mcpTerminal: cfg.get<boolean>("mcpTerminal", false),
      mcpHttp: cfg.get<boolean>("mcpHttp", false)
    };
    (updated as Record<string, boolean>)[key] = value;
    this.webview.postMessage({ type: "mcpSettingsUpdated", settings: updated });
  }

  private async sendMcpServers(): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    const config = await loadMcpConfig(root);
    const servers = Object.entries(config.mcpServers).map(([name, srv]) => ({
      name,
      command: srv.command,
      args: srv.args || [],
      disabled: srv.disabled || false
    }));
    this.webview.postMessage({ type: "mcpServers", servers });
  }

  private async toggleMcpServer(serverName: string, disabled: boolean): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    const config = await loadMcpConfig(root);
    if (config.mcpServers[serverName]) {
      config.mcpServers[serverName].disabled = disabled;
      await saveMcpConfig(root, config);
      await this.sendMcpServers();
    }
  }

  private async applyCodeToFile(filePath: string, code: string): Promise<void> {
    try {
      const root = this.getWorkspaceRoot();
      let fullPath = filePath;
      if (root && !filePath.match(/^[A-Z]:\\/i) && !filePath.startsWith("/")) {
        const path = await import("path");
        fullPath = path.join(root, filePath);
      }
      const uri = vscode.Uri.file(fullPath);

      // Try to open the existing file and do a smart insert/replace
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        // File doesn't exist — create it with the code
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, encoder.encode(code));
        doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        this.webview.postMessage({ type: "codeApplied", filePath, success: true });
        void vscode.window.showInformationMessage(`Created ${filePath}`);
        return;
      }

      const editor = await vscode.window.showTextDocument(doc);
      const existingContent = doc.getText();

      // Strategy: Try to find a matching section to replace, otherwise insert at cursor
      const trimmedCode = code.trim();
      const firstLine = trimmedCode.split("\n")[0].trim();

      // Check if the code block contains something that already exists (partial match for replacement)
      const matchIdx = existingContent.indexOf(firstLine);
      if (matchIdx >= 0 && trimmedCode.split("\n").length > 1) {
        // Find the range of the existing block to replace
        const startPos = doc.positionAt(matchIdx);
        // Try to find the end of the existing block by matching closing braces or line count
        const codeLines = trimmedCode.split("\n");
        const endOffset = matchIdx + this.findBlockEnd(existingContent, matchIdx, codeLines.length);
        const endPos = doc.positionAt(endOffset);
        const range = new vscode.Range(startPos, endPos);

        await editor.edit((editBuilder) => {
          editBuilder.replace(range, trimmedCode);
        });
      } else {
        // Insert at current cursor position
        const position = editor.selection.active;
        await editor.edit((editBuilder) => {
          editBuilder.insert(position, "\n" + trimmedCode + "\n");
        });
      }

      await doc.save();
      this.webview.postMessage({ type: "codeApplied", filePath, success: true });
      void vscode.window.showInformationMessage(`Applied to ${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.webview.postMessage({ type: "codeApplied", filePath, success: false, error: msg });
      void vscode.window.showErrorMessage(`Failed to apply: ${msg}`);
    }
  }

  private findBlockEnd(content: string, startIdx: number, approxLines: number): number {
    // Find approximately where the block ends based on line count from start
    let pos = startIdx;
    let linesFound = 0;
    while (pos < content.length && linesFound < approxLines) {
      if (content[pos] === "\n") linesFound++;
      pos++;
    }
    return pos - startIdx;
  }

  // --- New Session ---
  private async startNewSession(): Promise<void> {
    const root = this.getWorkspaceRoot();
    // Save current conversation as a thread before clearing
    if (root && this.currentMode) {
      const history = this.session.getHistory();
      if (history.length > 0) {
        threadManager.saveSnapshot(history, this.currentMode, this.activeAgentId ?? undefined);
        await threadManager.persist(root);
      }
    }
    // Mark that we're starting fresh (next save creates a new thread)
    threadManager.startNewThread();
    this.session.newSession();
    this.currentMode = null;
    this.webview.postMessage({ type: "newSessionStarted" });
  }

  // --- Auto-save thread after each AI response ---
  private autoSaveCurrentThread(): void {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    const history = this.session.getHistory();
    if (history.length === 0) return;
    const mode = this.currentMode || "vibe";
    threadManager.saveSnapshot(history, mode, this.activeAgentId ?? undefined);
    void threadManager.persist(root);
  }

  // --- Memory ---
  private async rememberContext(content: string, category: string, tags: string[]): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await projectMemory.load(root);
    const validCategories = ["decision", "preference", "knowledge", "pattern", "warning"] as const;
    const cat = validCategories.includes(category as typeof validCategories[number])
      ? category as typeof validCategories[number]
      : "knowledge";
    projectMemory.add({ content, category: cat, source: "chat", tags });
    await projectMemory.persist(root);
    this.webview.postMessage({ type: "memoryAdded", count: projectMemory.getCount() });
  }

  private async sendMemories(): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      this.webview.postMessage({ type: "memories", entries: [] });
      return;
    }
    await projectMemory.load(root);
    this.webview.postMessage({ type: "memories", entries: projectMemory.getAll() });
  }

  private async forgetMemory(id: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await projectMemory.load(root);
    projectMemory.remove(id);
    await projectMemory.persist(root);
    this.webview.postMessage({ type: "memories", entries: projectMemory.getAll() });
  }

  // --- Planning ---
  private async sendPlan(): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      this.webview.postMessage({ type: "plan", activePlan: null, allPlans: [] });
      return;
    }
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    const allPlans = planManager.getAllPlans();
    this.webview.postMessage({ type: "plan", activePlan: plan ?? null, allPlans });
  }

  private async createPlan(title: string, goal: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.createPlan(title, goal);
    await planManager.persist(root);
    this.webview.postMessage({ type: "plan", activePlan: plan, allPlans: planManager.getAllPlans() });
  }

  private async setActivePlan(planId: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.setActivePlan(planId);
    await planManager.persist(root);
    this.webview.postMessage({ type: "plan", activePlan: plan ?? null, allPlans: planManager.getAllPlans() });
  }

  private async addPlanTask(title: string, description: string, priority: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    const validPriorities = ["high", "medium", "low"] as const;
    const prio = validPriorities.includes(priority as typeof validPriorities[number])
      ? priority as typeof validPriorities[number]
      : "medium";
    planManager.addTask(plan.id, title, description, prio);
    await planManager.persist(root);
    this.webview.postMessage({ type: "plan", activePlan: planManager.getActivePlan() ?? null, allPlans: planManager.getAllPlans() });
  }

  private async updateTaskStatus(taskId: string, status: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    const validStatuses = ["todo", "in-progress", "done", "blocked"] as const;
    const stat = validStatuses.includes(status as typeof validStatuses[number])
      ? status as typeof validStatuses[number]
      : "todo";
    planManager.updateTaskStatus(plan.id, taskId, stat);
    await planManager.persist(root);
    this.webview.postMessage({ type: "plan", activePlan: planManager.getActivePlan() ?? null, allPlans: planManager.getAllPlans() });
  }

  // --- File Suggestions for # autocomplete ---
  private async suggestFiles(query: string): Promise<void> {
    try {
      let pattern: string;
      if (!query || query === "*") {
        // No query — show common source files
        pattern = "**/*.{ts,tsx,js,jsx,py,cs,java,go,rs,vue,svelte,html,css,json,yaml,yml,md}";
      } else if (query.includes("/") || query.includes("\\")) {
        pattern = `**/${query}*`;
      } else {
        pattern = `**/*${query}*`;
      }
      const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 15);
      const files = uris.map((u) => vscode.workspace.asRelativePath(u)).sort((a, b) => a.length - b.length);
      this.webview.postMessage({ type: "fileSuggestions", files });
    } catch {
      this.webview.postMessage({ type: "fileSuggestions", files: [] });
    }
  }

  // --- Agile: Detailed Tasks ---
  private async addDetailedTask(
    title: string, description: string, priority: string,
    storyPoints?: number, acceptanceCriteria?: string[], dependsOn?: string[]
  ): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    const validPriorities = ["high", "medium", "low"] as const;
    const prio = validPriorities.includes(priority as typeof validPriorities[number])
      ? priority as typeof validPriorities[number]
      : "medium";
    planManager.addTaskWithDetails(plan.id, title, description, prio, storyPoints, acceptanceCriteria, dependsOn);
    await planManager.persist(root);
    this.webview.postMessage({ type: "plan", activePlan: planManager.getActivePlan() ?? null, allPlans: planManager.getAllPlans() });
  }

  // --- Agile: Acceptance Criteria ---
  private async setTaskAcceptanceCriteria(taskId: string, criteria: string[]): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    planManager.setAcceptanceCriteria(plan.id, taskId, criteria);
    await planManager.persist(root);
    this.webview.postMessage({ type: "plan", activePlan: planManager.getActivePlan() ?? null, allPlans: planManager.getAllPlans() });
  }

  // --- Agile: Story Points ---
  private async setTaskStoryPoints(taskId: string, points: number): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    planManager.setStoryPoints(plan.id, taskId, points);
    await planManager.persist(root);
    this.webview.postMessage({ type: "plan", activePlan: planManager.getActivePlan() ?? null, allPlans: planManager.getAllPlans() });
  }

  // --- Agile: Dependencies ---
  private async setTaskDependencies(taskId: string, dependsOn: string[]): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    planManager.setDependencies(plan.id, taskId, dependsOn);
    await planManager.persist(root);
    this.webview.postMessage({ type: "plan", activePlan: planManager.getActivePlan() ?? null, allPlans: planManager.getAllPlans() });
  }

  // --- Agile: Sprint Management ---
  private async createSprint(name: string, goal: string, durationDays?: number): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    const sprint = planManager.createSprint(plan.id, name, goal, durationDays);
    await planManager.persist(root);
    this.webview.postMessage({ type: "sprintCreated", sprint, plan: planManager.getActivePlan() ?? null });
  }

  private async addTaskToSprint(sprintId: string, taskId: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    planManager.addTaskToSprint(plan.id, sprintId, taskId);
    await planManager.persist(root);
    this.webview.postMessage({ type: "plan", activePlan: planManager.getActivePlan() ?? null, allPlans: planManager.getAllPlans() });
  }

  private async startSprint(sprintId: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    planManager.startSprint(plan.id, sprintId);
    await planManager.persist(root);
    this.webview.postMessage({ type: "sprintStarted", sprintId, plan: planManager.getActivePlan() ?? null });
  }

  private async completeSprint(sprintId: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    const velocity = planManager.getSprintVelocity(plan.id, sprintId);
    planManager.completeSprint(plan.id, sprintId);
    await planManager.persist(root);
    this.webview.postMessage({ type: "sprintCompleted", sprintId, velocity, plan: planManager.getActivePlan() ?? null });
  }

  // --- Agile: Retrospectives ---
  private async addRetrospective(wentWell: string[], needsImprovement: string[], actionItems: string[], sprintId?: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    const retro = planManager.addRetrospective(plan.id, wentWell, needsImprovement, actionItems, sprintId);
    await planManager.persist(root);
    this.webview.postMessage({ type: "retrospectiveAdded", retro });
  }

  private async sendRetrospectives(): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);
    const plan = planManager.getActivePlan();
    if (!plan) return;
    const retros = planManager.getRetrospectives(plan.id);
    this.webview.postMessage({ type: "retrospectives", entries: retros });
  }

  // --- Agile: Auto-Plan from Requirement ---
  private async autoPlan(requirement: string): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    await planManager.load(root);

    // Use the AI to generate a plan — send the requirement as a prompt
    const breakdown = planManager.generatePlanBreakdown(requirement);
    this.webview.postMessage({ type: "autoPlanSuggestion", requirement, suggestedTasks: breakdown.suggestedTasks });

    // Also send to the AI for a more intelligent breakdown
    const prompt = `Break down this requirement into agile tasks with story points and acceptance criteria:

"${requirement}"

For each task provide:
- Title (concise)
- Description
- Priority (high/medium/low)
- Story points (1-8, fibonacci-ish)
- Acceptance criteria (testable conditions)
- Dependencies (which tasks must be done first)

Format as a numbered list. Be specific and actionable.`;

    if (ChatHost.current) {
      void ChatHost.current.session.send(prompt, "", true);
    }
  }
}
