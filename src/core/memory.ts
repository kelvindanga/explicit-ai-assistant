import * as fs from "fs/promises";
import * as path from "path";

/**
 * Persistent memory store for the AI assistant.
 * Remembers decisions, preferences, project knowledge, and learnings
 * across sessions. Stored as a simple JSON file in the workspace.
 */

export interface MemoryEntry {
  id: string;
  category: "decision" | "preference" | "knowledge" | "pattern" | "warning";
  content: string;
  source: string; // which conversation/command created this
  timestamp: number;
  tags: string[];
}

export interface MemoryStore {
  entries: MemoryEntry[];
  lastUpdated: number;
}

const MEMORY_FILE = ".explicitai/memory.json";
const MAX_ENTRIES = 200;

export class ProjectMemory {
  private store: MemoryStore = { entries: [], lastUpdated: 0 };

  async load(workspaceRoot: string): Promise<void> {
    const filePath = path.join(workspaceRoot, MEMORY_FILE);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      this.store = JSON.parse(raw);
    } catch {
      this.store = { entries: [], lastUpdated: 0 };
    }
  }

  async persist(workspaceRoot: string): Promise<void> {
    const dir = path.dirname(path.join(workspaceRoot, MEMORY_FILE));
    await fs.mkdir(dir, { recursive: true });
    this.store.lastUpdated = Date.now();
    await fs.writeFile(
      path.join(workspaceRoot, MEMORY_FILE),
      JSON.stringify(this.store, null, 2),
      "utf8"
    );
  }

  add(entry: Omit<MemoryEntry, "id" | "timestamp">): MemoryEntry {
    const full: MemoryEntry = {
      ...entry,
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now()
    };
    this.store.entries.push(full);

    // Evict oldest if over limit
    if (this.store.entries.length > MAX_ENTRIES) {
      this.store.entries = this.store.entries.slice(-MAX_ENTRIES);
    }

    return full;
  }

  remove(id: string): void {
    this.store.entries = this.store.entries.filter((e) => e.id !== id);
  }

  getAll(): MemoryEntry[] {
    return [...this.store.entries];
  }

  /**
   * Get relevant memories for a given prompt/context.
   * Simple keyword matching — not semantic search, but effective for local use.
   */
  getRelevant(query: string, limit = 10): MemoryEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (!words.length) {
      return this.store.entries.slice(-limit);
    }

    const scored = this.store.entries.map((entry) => {
      const text = (entry.content + " " + entry.tags.join(" ")).toLowerCase();
      let score = 0;
      for (const word of words) {
        if (text.includes(word)) score++;
      }
      // Boost recent entries
      const ageHours = (Date.now() - entry.timestamp) / (1000 * 60 * 60);
      if (ageHours < 24) score += 2;
      else if (ageHours < 168) score += 1; // within a week
      return { entry, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  /**
   * Build a context string from relevant memories for injection into prompts.
   */
  buildContext(query: string): string {
    const relevant = this.getRelevant(query);
    if (!relevant.length) {
      return "";
    }

    const lines = relevant.map((e) => {
      const icon = e.category === "decision" ? "📌"
        : e.category === "preference" ? "⚙️"
        : e.category === "warning" ? "⚠️"
        : e.category === "pattern" ? "🔄"
        : "💡";
      return `${icon} [${e.category}] ${e.content}`;
    });

    return "=== Project memory (remembered from previous sessions) ===\n" + lines.join("\n");
  }

  getCount(): number {
    return this.store.entries.length;
  }
}

export const projectMemory = new ProjectMemory();
