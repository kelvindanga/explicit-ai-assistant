import * as vscode from "vscode";
import { askSelection } from "./commands/askSelection";
import { askManual } from "./commands/askManual";
import { sendFile } from "./commands/sendFile";
import { explainCode } from "./commands/explainCode";
import { fixDiagnostic } from "./commands/fixDiagnostic";
import { generateTests } from "./commands/generateTests";
import { generatePrDescription } from "./commands/generatePrDescription";
import { generateDocs } from "./commands/generateDocs";
import { askWorkspace } from "./commands/askWorkspace";
import { inlineChat } from "./commands/inlineChat";
import { autoFixLoop } from "./commands/autoFix";
import { getConfig, onConfigChange, SidebarPlacement } from "./core/config";
import { ChatHost } from "./ui/chatHost";
import { ChatPanel } from "./ui/chatPanel";
import { ChatViewProvider } from "./ui/chatViewProvider";
import { agentRegistry } from "./agents/agentRegistry";
import { threadManager } from "./threads/threadStore";
import { openMcpConfigInEditor } from "./mcp/mcpConfig";
import { ModelHealthCheck } from "./core/healthCheck";
import { projectMemory } from "./core/memory";
import { planManager } from "./core/planner";
import { InlineCompletionProvider } from "./completions/inlineProvider";
import { terminalWatcher } from "./core/terminalWatcher";
import { registerDiffProvider } from "./core/diffPreview";
import { mcpManager } from "./mcp/mcpClient";

export function activate(context: vscode.ExtensionContext): void {
  const chatProvider = new ChatViewProvider(context.extensionUri);
  const healthCheck = new ModelHealthCheck();
  healthCheck.start();
  registerDiffProvider(context);

  // Initialize agents and threads from workspace
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    void agentRegistry.load(root);
    void threadManager.load(root);
    void projectMemory.load(root);
    void planManager.load(root);
    void mcpManager.loadAndConnect(root);
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("explicitAI.askSelection", askSelection),
    vscode.commands.registerCommand("explicitAI.askManual", askManual),
    vscode.commands.registerCommand("explicitAI.sendFile", sendFile),
    vscode.commands.registerCommand("explicitAI.openChat", () => openChat(context.extensionUri)),
    vscode.commands.registerCommand("explicitAI.openChatSidebar", () =>
      openChat(context.extensionUri, "left")
    ),
    vscode.commands.registerCommand("explicitAI.openChatPanel", () =>
      ChatPanel.createOrShow(context.extensionUri)
    ),
    vscode.commands.registerCommand("explicitAI.stopGeneration", () => {
      ChatHost.current?.session.stop();
    }),
    vscode.commands.registerCommand("explicitAI.openMcpConfig", () => {
      if (root) void openMcpConfigInEditor(root);
    }),
    vscode.commands.registerCommand("explicitAI.manageAgents", () => {
      void vscode.commands.executeCommand("explicitAI.chatView.focus");
    }),
    vscode.commands.registerCommand("explicitAI.checkHealth", () => {
      void healthCheck.check().then((status) => {
        const engine = healthCheck.getEngineInfo();
        if (status === "connected") {
          const modelHint = engine.models > 0 ? ` (${engine.models} models loaded)` : "";
          void vscode.window.showInformationMessage(`${engine.name} is connected and responding${modelHint}.`);
        } else {
          void vscode.window.showWarningMessage(
            `Cannot reach ${engine.name} at ${getConfig().lmStudioBaseUrl}. Is it running?`
          );
        }
      });
    }),
    vscode.commands.registerCommand("explicitAI.exportConversation", async () => {
      if (!ChatHost.current) return;
      const choice = await vscode.window.showQuickPick(
        [{ label: "Markdown", value: "md" }, { label: "JSON", value: "json" }],
        { placeHolder: "Export format" }
      );
      if (!choice) return;
      const { exportAsMarkdown, exportAsJson } = await import("./core/exportConversation");
      const history = ChatHost.current.session.getHistory();
      if (choice.value === "md") {
        await exportAsMarkdown(history);
      } else {
        await exportAsJson(history);
      }
    }),
    vscode.commands.registerCommand("explicitAI.explainCode", explainCode),
    vscode.commands.registerCommand("explicitAI.fixDiagnostic", fixDiagnostic),
    vscode.commands.registerCommand("explicitAI.generateTests", generateTests),
    vscode.commands.registerCommand("explicitAI.generatePrDescription", generatePrDescription),
    vscode.commands.registerCommand("explicitAI.generateDocs", generateDocs),
    vscode.commands.registerCommand("explicitAI.askWorkspace", askWorkspace),
    vscode.commands.registerCommand("explicitAI.inlineChat", inlineChat),
    vscode.commands.registerCommand("explicitAI.autoFix", autoFixLoop),
    vscode.commands.registerCommand("explicitAI.newSession", () => {
      if (ChatHost.current) {
        ChatHost.current.session.newSession();
      }
    }),
    { dispose: () => healthCheck.dispose() },
    onConfigChange(() => chatProvider.refresh()),
    // Track active editor changes and notify the chat
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && ChatHost.current) {
        const filePath = editor.document.uri.fsPath;
        const fileName = vscode.workspace.asRelativePath(editor.document.uri);
        ChatHost.current.notifyActiveFile(filePath, fileName);
      }
    })
  );

  // Register inline completion provider
  const inlineProvider = new InlineCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, inlineProvider)
  );

  // Start terminal watcher
  terminalWatcher.start();
  terminalWatcher.onError((error) => {
    // Notify the chat about terminal errors
    if (ChatHost.current) {
      ChatHost.current.notifyTerminalError(error.terminal, error.error);
    }
  });
  context.subscriptions.push({ dispose: () => terminalWatcher.dispose() });

  // Send initial active file on activation
  if (vscode.window.activeTextEditor && ChatHost.current) {
    const editor = vscode.window.activeTextEditor;
    const filePath = editor.document.uri.fsPath;
    const fileName = vscode.workspace.asRelativePath(editor.document.uri);
    ChatHost.current.notifyActiveFile(filePath, fileName);
  }
}

function openChat(extensionUri: vscode.Uri, force?: SidebarPlacement): void {
  const placement = force ?? getConfig().sidebarPlacement;
  if (placement === "panel") {
    ChatPanel.createOrShow(extensionUri);
    return;
  }
  if (placement === "right") {
    ChatPanel.createOrShow(extensionUri, vscode.ViewColumn.Two);
    return;
  }
  void vscode.commands.executeCommand("workbench.view.extension.explicit-ai");
  void vscode.commands.executeCommand("explicitAI.chatView.focus");
}

export function deactivate(): void {
  ChatPanel.disposePanel();
  mcpManager.stopAll();
}
