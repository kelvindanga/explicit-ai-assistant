import { ChatMessage } from "./llmClient";
import { estimateMessagesTokens, getContextLimit } from "./tokenBudget";

/**
 * Conversation compactor.
 * Instead of just dropping old messages when context is full,
 * this creates a summary of the dropped messages and prepends it.
 * This preserves important context while freeing up token budget.
 */

const COMPACT_PROMPT = `Summarize the conversation so far in a concise paragraph. Include:
- Key decisions made
- Important context established
- Current task/goal being worked on
- Any constraints or requirements mentioned
Keep it under 200 words. This summary will replace the older messages to free up context space.`;

/**
 * Check if the conversation needs compacting.
 * Returns true if we're over 80% of the context limit.
 */
export function needsCompacting(messages: ChatMessage[]): boolean {
  const tokens = estimateMessagesTokens(messages);
  const limit = getContextLimit();
  return tokens > limit * 0.8;
}

/**
 * Compact a conversation by replacing older messages with a summary.
 * The summary is generated locally (no LLM call) by extracting key info.
 * 
 * Strategy:
 * 1. Keep system message (first)
 * 2. Keep the last N messages (recent context)
 * 3. Replace middle messages with a generated summary
 */
export function compactConversation(messages: ChatMessage[]): {
  compacted: ChatMessage[];
  summary: string;
  droppedCount: number;
} {
  if (messages.length <= 4) {
    return { compacted: messages, summary: "", droppedCount: 0 };
  }

  const limit = getContextLimit();
  const system = messages[0]?.role === "system" ? messages[0] : null;
  const rest = system ? messages.slice(1) : [...messages];

  // Keep the last 4 messages (2 exchanges) always
  const keepCount = Math.min(4, rest.length);
  const recent = rest.slice(-keepCount);
  const older = rest.slice(0, -keepCount);

  if (older.length === 0) {
    return { compacted: messages, summary: "", droppedCount: 0 };
  }

  // Generate a local summary from the older messages
  const summary = generateLocalSummary(older);

  const summaryMessage: ChatMessage = {
    role: "user",
    content: `[Conversation summary — ${older.length} earlier messages compacted]\n\n${summary}\n\n[End of summary — recent messages follow]`
  };

  const compacted = system
    ? [system, summaryMessage, ...recent]
    : [summaryMessage, ...recent];

  // Verify we're under budget now
  const newTokens = estimateMessagesTokens(compacted);
  if (newTokens > limit) {
    // Still too big — drop more from recent
    const minimal = system
      ? [system, summaryMessage, recent[recent.length - 1]]
      : [summaryMessage, recent[recent.length - 1]];
    return { compacted: minimal, summary, droppedCount: older.length + keepCount - 1 };
  }

  return { compacted, summary, droppedCount: older.length };
}

/**
 * Generate a summary from messages without calling the LLM.
 * Extracts key information heuristically.
 */
function generateLocalSummary(messages: ChatMessage[]): string {
  const parts: string[] = [];

  // Extract user questions/requests
  const userMessages = messages.filter((m) => m.role === "user");
  const assistantMessages = messages.filter((m) => m.role === "assistant");

  if (userMessages.length > 0) {
    const topics = userMessages.map((m) => {
      // Get first line or first 100 chars as topic
      const firstLine = m.content.split("\n")[0].trim();
      return firstLine.length > 100 ? firstLine.substring(0, 100) + "..." : firstLine;
    });
    parts.push("Topics discussed: " + topics.join("; "));
  }

  // Extract key decisions/conclusions from assistant messages
  if (assistantMessages.length > 0) {
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    // Get the first paragraph as the most recent conclusion
    const firstPara = lastAssistant.content.split("\n\n")[0].trim();
    if (firstPara.length > 0) {
      const conclusion = firstPara.length > 300 ? firstPara.substring(0, 300) + "..." : firstPara;
      parts.push("Last conclusion: " + conclusion);
    }
  }

  // Count exchanges
  parts.push(`(${userMessages.length} user messages, ${assistantMessages.length} AI responses compacted)`);

  return parts.join("\n\n");
}

/**
 * Get the compaction prompt for LLM-based summarization.
 * Used when we want a higher-quality summary via the model itself.
 */
export function getCompactPrompt(): string {
  return COMPACT_PROMPT;
}
