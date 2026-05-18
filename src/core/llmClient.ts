import { getConfig } from "./config";
import { isLikelyEnglish, shouldEnforceEnglish } from "./languageGuard";
import { ENGLISH_RETRY_INSTRUCTION } from "./promptGuard";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamCallbacks {
  onToken: (chunk: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

export interface CompletionOptions {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export class LLMClient {
  private activeAbort: AbortController | undefined;

  cancel(): void {
    this.activeAbort?.abort();
    this.activeAbort = undefined;
  }

  async completeWithEnglishGuard(
    options: CompletionOptions,
    callbacks?: StreamCallbacks
  ): Promise<string> {
    let text = await this.complete(options, callbacks);
    if (shouldEnforceEnglish() && !isLikelyEnglish(text)) {
      const retryMessages: ChatMessage[] = [
        ...options.messages,
        { role: "assistant", content: text },
        { role: "user", content: ENGLISH_RETRY_INSTRUCTION }
      ];
      text = await this.complete(
        { ...options, messages: retryMessages, stream: false },
        undefined
      );
    }
    return text;
  }

  async complete(options: CompletionOptions, callbacks?: StreamCallbacks): Promise<string> {
    const cfg = getConfig();
    const maxRetries = 2;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.doComplete(options, callbacks);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Don't retry if user cancelled or if it's a non-transient error
        if (lastError.message.includes("stopped") || lastError.message.includes("aborted")) {
          throw lastError;
        }
        // Don't retry on 4xx errors EXCEPT 429 (rate limit)
        if (lastError.message.includes("(4") && !lastError.message.includes("(429")) {
          throw lastError;
        }
        if (attempt < maxRetries) {
          // Rate limit: use longer backoff. Others: standard backoff.
          const isRateLimit = lastError.message.includes("429");
          const delay = isRateLimit
            ? 5000 * Math.pow(2, attempt) // 5s, 10s for rate limits
            : 1000 * Math.pow(2, attempt); // 1s, 2s for other errors
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError ?? new Error("LLM request failed after retries");
  }

  private async doComplete(options: CompletionOptions, callbacks?: StreamCallbacks): Promise<string> {
    const cfg = getConfig();
    const stream = options.stream ?? cfg.streaming;
    const controller = new AbortController();
    this.activeAbort = controller;
    const signal = options.signal ?? controller.signal;

    // Adaptive timeout: estimate based on token count
    // Local models: ~32 tok/sec prompt eval + ~7 tok/sec generation
    // Add generous buffer for slow hardware
    const inputChars = options.messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedInputTokens = Math.ceil(inputChars / 3.5);
    const estimatedPromptTime = (estimatedInputTokens / 20) * 1000; // assume 20 tok/sec (conservative)
    const estimatedGenTime = ((cfg.maxTokens || 4096) / 5) * 1000; // assume 5 tok/sec generation
    const adaptiveTimeout = Math.max(
      cfg.requestTimeoutMs,
      estimatedPromptTime + estimatedGenTime + 30000 // +30s buffer
    );
    const timeout = setTimeout(() => controller.abort(), adaptiveTimeout);

    try {
      const body = {
        model: options.model,
        messages: options.messages,
        stream,
        temperature: options.temperature ?? cfg.temperature,
        max_tokens: options.maxTokens ?? cfg.maxTokens
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (cfg.apiKey) {
        headers["Authorization"] = `Bearer ${cfg.apiKey}`;
      }
      // OpenRouter requires these additional headers
      if (cfg.apiUrl.includes("openrouter.ai")) {
        headers["HTTP-Referer"] = "https://github.com/kelvin-danga/explicit-ai-assistant";
        headers["X-Title"] = "Explicit AI Assistant";
      }

      const res = await fetch(cfg.apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`LLM request failed (${res.status}): ${errBody || res.statusText}`);
      }

      if (stream && res.body && callbacks) {
        return await this.readSSE(res, callbacks, signal);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (data.error?.message) {
        throw new Error(data.error.message);
      }
      const content = data.choices?.[0]?.message?.content ?? "";
      callbacks?.onDone(content);
      return content;
    } catch (err) {
      if (signal.aborted) {
        throw new Error("Generation stopped.");
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        msg.includes("fetch") || msg.includes("abort")
          ? `Could not reach LM Studio at ${cfg.apiUrl}. ${msg}`
          : msg
      );
    } finally {
      clearTimeout(timeout);
      if (this.activeAbort === controller) {
        this.activeAbort = undefined;
      }
    }
  }

  private async readSSE(
    res: Response,
    callbacks: StreamCallbacks,
    signal: AbortSignal
  ): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      if (signal.aborted) {
        reader.cancel();
        throw new Error("Generation stopped.");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          continue;
        }
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const chunk = json.choices?.[0]?.delta?.content ?? "";
          if (chunk) {
            full += chunk;
            callbacks.onToken(chunk);
          }
        } catch {
          /* skip malformed SSE */
        }
      }
    }

    callbacks.onDone(full);
    return full;
  }
}
