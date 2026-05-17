import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export function buildChatWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const chatDir = path.join(extensionUri.fsPath, "media", "chat");
  let html = fs.readFileSync(path.join(chatDir, "chat.html"), "utf8");
  const css = fs.readFileSync(path.join(chatDir, "chat.css"), "utf8");
  const js = fs.readFileSync(path.join(chatDir, "chat.js"), "utf8");
  const hlCss = fs.readFileSync(path.join(chatDir, "highlight.css"), "utf8");

  const nonce = getNonce();
  const cspSource = webview.cspSource;
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`
  ].join("; ");

  return html
    .replace("<!-- CSP -->", `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace("<!-- STYLES -->", `<style>${hlCss}\n${css}</style>`)
    .replace("<!-- SCRIPT -->", `<script nonce="${nonce}">${js}</script>`);
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
