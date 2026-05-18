import { getConfig } from "./config";

export interface ModelInfo {
  id: string;
  name: string;
}

export async function fetchAvailableModels(): Promise<ModelInfo[]> {
  const { modelsUrl, apiKey } = getConfig();
  try {
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers: apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}
    });
    if (!res.ok) {
      return fallbackModels();
    }
    const data = (await res.json()) as {
      data?: Array<{ id?: string }>;
    };
    const list = data.data?.map((m) => m.id).filter((id): id is string => !!id) ?? [];
    if (!list.length) {
      return fallbackModels();
    }
    return list.map((id) => ({ id, name: id }));
  } catch {
    return fallbackModels();
  }
}

function fallbackModels(): ModelInfo[] {
  const { defaultModel, codeModel, chatModel, debugModel } = getConfig();
  const ids = new Set<string>();
  for (const m of [defaultModel, codeModel, chatModel, debugModel]) {
    if (m.trim()) {
      ids.add(m.trim());
    }
  }
  if (!ids.size) {
    ids.add("local-model");
  }
  return [...ids].map((id) => ({ id, name: id }));
}
