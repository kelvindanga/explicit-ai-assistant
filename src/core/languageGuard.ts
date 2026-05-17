import { getConfig } from "./config";
import { ENGLISH_RETRY_INSTRUCTION } from "./promptGuard";

/** Heuristic: non-Latin scripts or high non-ASCII ratio => not English. */
export function isLikelyEnglish(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }

  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0600-\u06ff\u0400-\u04ff]/.test(trimmed)) {
    return false;
  }

  const letters = trimmed.match(/[a-zA-Z]/g)?.length ?? 0;
  const allLetters = trimmed.match(/\p{L}/gu)?.length ?? 0;
  if (allLetters > 20 && letters / allLetters < 0.55) {
    return false;
  }

  return true;
}

export function shouldEnforceEnglish(): boolean {
  return getConfig().enforceEnglish;
}

export function getEnglishRetryInstruction(): string {
  return ENGLISH_RETRY_INSTRUCTION;
}
