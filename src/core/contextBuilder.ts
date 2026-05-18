import { AttachedFile, formatFilesForContext } from "./fileAttachments";
import { ChatMessage } from "./llmClient";
import { buildSystemPrompt, buildSystemPromptWithMcpServers } from "./promptGuard";
import { getStackContext } from "./stackDetector";
import { projectMemory } from "./memory";
import { planManager } from "./planner";
import { estimateMessagesTokens, getContextLimit } from "./tokenBudget";
import { getConfig } from "./config";

export interface BuildPayloadInput {
  userPrompt: string;
  pastedContext?: string;
  files?: AttachedFile[];
  mcpOutputs?: string[];
  agentPrompt?: string | null;
}

export interface BuiltPayload {
  messages: ChatMessage[];
  displayPayload: PayloadPreview;
}

export interface PayloadPreview {
  systemPrompt: string;
  userPrompt: string;
  pastedContext: string;
  attachedFiles: Array<{ name: string; path: string; size: number }>;
  mcpOutputs: string[];
  finalUserMessage: string;
  messageCount: number;
}

export class ContextBuilder {
  static build(input: BuildPayloadInput): BuiltPayload {
    const systemPrompt = buildSystemPrompt(input.agentPrompt ?? undefined);
    return ContextBuilder.buildFromParts(input, systemPrompt);
  }

  static async buildAsync(input: BuildPayloadInput): Promise<BuiltPayload> {
    // Inject stack context so the AI knows the project's framework/tools
    const extras: string[] = [];
    if (input.agentPrompt) extras.push(input.agentPrompt);

    const stackCtx = await getStackContext();
    if (stackCtx) extras.push(`Project context:\n${stackCtx}`);

    // Inject relevant memories
    const memoryCtx = projectMemory.buildContext(input.userPrompt);
    if (memoryCtx) extras.push(memoryCtx);

    // Inject active plan
    const planCtx = planManager.buildContext();
    if (planCtx) extras.push(planCtx);

    const agentExtra = extras.length > 0 ? extras.join("\n\n") : undefined;
    const systemPrompt = await buildSystemPromptWithMcpServers(agentExtra);
    return ContextBuilder.buildFromParts(input, systemPrompt);
  }

  private static buildFromParts(input: BuildPayloadInput, systemPrompt: string): BuiltPayload {
    const pasted = (input.pastedContext ?? "").trim();
    const files = input.files ?? [];
    const mcpOutputs = input.mcpOutputs ?? [];
    const fileBlock = formatFilesForContext(files);
    const contextLimit = getContextLimit();
    const cfg = getConfig();

    const sections: string[] = [];
    if (fileBlock) {
      sections.push("=== Attached files ===\n" + fileBlock);
    }
    if (pasted) {
      sections.push("=== Context ===\n" + pasted);
    }
    if (mcpOutputs.length) {
      sections.push(
        "=== Tool outputs ===\n" + mcpOutputs.join("\n\n---\n\n")
      );
    }
    sections.push(input.userPrompt.trim());

    let finalUserMessage = sections.join("\n\n");

    let messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: finalUserMessage }
    ];

    // Token-aware trimming: if we're over budget, progressively strip context
    let tokens = estimateMessagesTokens(messages);
    if (tokens > contextLimit * 0.85) {
      // Step 1: Truncate attached file content
      if (fileBlock && fileBlock.length > 1000) {
        const trimmedFiles = files.map((f) => ({
          ...f,
          content: f.content.length > 500
            ? f.content.substring(0, 500) + `\n... (${f.content.length} chars total, truncated to fit context)`
            : f.content
        }));
        const trimmedFileBlock = formatFilesForContext(trimmedFiles);
        const trimmedSections = [];
        if (trimmedFileBlock) trimmedSections.push("=== Attached files (trimmed) ===\n" + trimmedFileBlock);
        if (pasted && pasted.length <= 500) trimmedSections.push(pasted);
        if (mcpOutputs.length) trimmedSections.push("=== Tool outputs ===\n" + mcpOutputs.map((o) => o.substring(0, 300)).join("\n---\n"));
        trimmedSections.push(input.userPrompt.trim());
        finalUserMessage = trimmedSections.join("\n\n");
        messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: finalUserMessage }
        ];
        tokens = estimateMessagesTokens(messages);
      }

      // Step 2: If still over, use a minimal system prompt
      if (tokens > contextLimit * 0.85) {
        const minimalSystem = cfg.systemPrompt.trim() + "\n\nYou have tools: readFile, listDir, search, findFiles, writeFile, editFile, insertAt, deleteFile, runCommand. Use ```tool JSON format to invoke them.";
        messages = [
          { role: "system", content: minimalSystem },
          { role: "user", content: input.userPrompt.trim() }
        ];
      }
    }

    return {
      messages,
      displayPayload: {
        systemPrompt: messages[0].content,
        userPrompt: input.userPrompt.trim(),
        pastedContext: pasted,
        attachedFiles: files.map((f) => ({
          name: f.name,
          path: f.fsPath,
          size: f.content.length
        })),
        mcpOutputs,
        finalUserMessage: messages[messages.length - 1].content,
        messageCount: messages.length
      }
    };
  }
}
