import { ChatMessage } from "./llmClient";
import { getConfig } from "./config";

/**
 * Approximate token counter using a simple heuristic:
 * ~4 characters per token for English text (GPT-style tokenization).
 * This avoids needing a full tokenizer dependency.
 */
export function estimateTokens(text: string): number {
  // Rough heuristic: 1 token ≈ 4 chars for English, 2-3 for code
  // We use 3.5 as a middle ground for mixed content
  return Math.ceil(text.length / 3.5);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // Each message has ~4 tokens overhead (role, formatting)
    total += 4 + estimateTokens(msg.content);
  }
  return total;
}

/**
 * Returns the max context window size based on configuration.
 * Users can set this to match their model's actual context window.
 */
export function getContextLimit(): number {
  const cfg = getConfig();
  const contextWindow = cfg.contextWindow || 32768;
  const reserved = cfg.maxTokens;
  return contextWindow - reserved;
}

/**
 * Truncates conversation history to fit within the token budget.
 * Strategy: Always keep the system message + most recent messages.
 * Older messages are dropped from the middle.
 */
export function truncateConversation(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  const limit = getContextLimit();
  const currentTokens = estimateMessagesTokens(messages);

  if (currentTokens <= limit) {
    return messages;
  }

  // Always keep: system message (first) + last 2 messages (most recent exchange)
  const system = messages[0]?.role === "system" ? messages[0] : null;
  const rest = system ? messages.slice(1) : [...messages];

  // Keep removing oldest messages until we fit
  const truncated: ChatMessage[] = [...rest];
  while (truncated.length > 2) {
    const candidate = system ? [system, ...truncated] : truncated;
    if (estimateMessagesTokens(candidate) <= limit) {
      break;
    }
    // Remove the oldest non-system message
    truncated.shift();
  }

  const result = system ? [system, ...truncated] : truncated;

  // If we truncated, prepend a note so the model knows context was lost
  if (result.length < messages.length && system) {
    const droppedCount = messages.length - result.length;
    result[0] = {
      role: "system",
      content: system.content + `\n\n[Note: ${droppedCount} earlier messages were truncated to fit context window.]`
    };
  }

  return result;
}

export interface TokenStats {
  inputTokens: number;
  limit: number;
  utilization: number; // 0-1
}

export function getTokenStats(messages: ChatMessage[]): TokenStats {
  const inputTokens = estimateMessagesTokens(messages);
  const limit = getContextLimit();
  return {
    inputTokens,
    limit,
    utilization: Math.min(1, inputTokens / limit)
  };
}
