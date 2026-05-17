import { AttachedFile, formatFilesForContext } from "./fileAttachments";
import { ChatMessage } from "./llmClient";
import { buildSystemPrompt, buildSystemPromptWithMcpServers } from "./promptGuard";
import { getStackContext } from "./stackDetector";
import { projectMemory } from "./memory";
import { planManager } from "./planner";

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

    const sections: string[] = [];
    if (fileBlock) {
      sections.push("=== Explicitly attached files (only these) ===\n" + fileBlock);
    }
    if (pasted) {
      sections.push("=== User-pasted context ===\n" + pasted);
    }
    if (mcpOutputs.length) {
      sections.push(
        "=== Approved MCP tool outputs ===\n" + mcpOutputs.join("\n\n---\n\n")
      );
    }
    sections.push("=== User message ===\n" + input.userPrompt.trim());

    const finalUserMessage = sections.join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: finalUserMessage }
    ];

    return {
      messages,
      displayPayload: {
        systemPrompt,
        userPrompt: input.userPrompt.trim(),
        pastedContext: pasted,
        attachedFiles: files.map((f) => ({
          name: f.name,
          path: f.fsPath,
          size: f.content.length
        })),
        mcpOutputs,
        finalUserMessage,
        messageCount: messages.length
      }
    };
  }
}
