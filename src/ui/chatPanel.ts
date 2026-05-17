import * as vscode from "vscode";
import { ChatHost } from "./chatHost";

export class ChatPanel {
  public static current: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly host: ChatHost;

  public static createOrShow(extensionUri: vscode.Uri, column?: vscode.ViewColumn): void {
    const col =
      column ??
      (vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One);

    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(col);
      ChatPanel.current.host.setHtml(extensionUri);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "explicitAI.panel",
      "Explicit AI",
      col,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")]
      }
    );

    ChatPanel.current = new ChatPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.host = new ChatHost(panel.webview);
    this.host.setHtml(extensionUri);

    panel.onDidDispose(() => {
      if (ChatPanel.current === this) {
        ChatPanel.current = undefined;
      }
      if (ChatHost.current === this.host) {
        ChatHost.current = undefined;
      }
    });
  }

  public static disposePanel(): void {
    ChatPanel.current?.panel.dispose();
    ChatPanel.current = undefined;
  }
}
