import * as vscode from "vscode";
import { ChatMessageRecord } from "../chat/chatSession";

/**
 * Export conversation history as a markdown file.
 */
export async function exportAsMarkdown(messages: ChatMessageRecord[]): Promise<void> {
  if (!messages.length) {
    void vscode.window.showWarningMessage("No messages to export.");
    return;
  }

  const lines: string[] = [
    "# Explicit AI Conversation",
    "",
    `*Exported: ${new Date().toLocaleString()}*`,
    ""
  ];

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const role = msg.role === "user" ? "**You**" : msg.role === "assistant" ? "**AI**" : "**Error**";
    const model = msg.model ? ` *(${msg.model})*` : "";

    lines.push(`### ${role} — ${time}${model}`);
    lines.push("");
    lines.push(msg.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  const content = lines.join("\n");

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file("conversation.md"),
    filters: { Markdown: ["md"], "All files": ["*"] },
    saveLabel: "Export Conversation"
  });

  if (uri) {
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
    void vscode.window.showInformationMessage(`Conversation exported to ${uri.fsPath}`);
  }
}

/**
 * Export conversation as JSON (for re-import or programmatic use).
 */
export async function exportAsJson(messages: ChatMessageRecord[]): Promise<void> {
  if (!messages.length) {
    void vscode.window.showWarningMessage("No messages to export.");
    return;
  }

  const data = {
    exportedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages
  };

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file("conversation.json"),
    filters: { JSON: ["json"], "All files": ["*"] },
    saveLabel: "Export Conversation"
  });

  if (uri) {
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(JSON.stringify(data, null, 2)));
    void vscode.window.showInformationMessage(`Conversation exported to ${uri.fsPath}`);
  }
}
