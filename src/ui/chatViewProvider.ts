import * as vscode from "vscode";
import { ChatHost } from "./chatHost";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "explicitAI.chatView";
  private host: ChatHost | undefined;
  private view: vscode.WebviewView | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      enableForms: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };

    this.host = new ChatHost(webviewView.webview);
    this.host.setHtml(this.extensionUri);

    // Handle drops from VS Code explorer via the view's onDropFiles
    // VS Code 1.78+ supports drop into webview views
    if (typeof (webviewView as unknown as Record<string, unknown>).onDidReceiveDrop !== "undefined") {
      // Future API — not yet stable
    }

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.host?.session.refreshModels();
      }
    });
  }

  public refresh(): void {
    if (!this.host) {
      return;
    }
    this.host.setHtml(this.extensionUri);
  }

  public getHost(): ChatHost | undefined {
    return this.host;
  }
}
