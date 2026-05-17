import * as fs from "fs/promises";
import * as path from "path";
import { ChatMessageRecord } from "../chat/chatSession";

export interface ThreadSnapshot {
  id: string;
  label: string;
  timestamp: number;
  lastActivity: number;
  messageCount: number;
  messages: ChatMessageRecord[];
  mode: "vibe" | "agile";
  agentId?: string;
}

export interface ThreadStore {
  threads: ThreadSnapshot[];
  activeThreadId: string | null;
}

const THREADS_DIR = ".explicitai/threads";
const MAX_THREADS = 100;

export class ThreadManager {
  private store: ThreadStore = { threads: [], activeThreadId: null };

  async load(workspaceRoot: string): Promise<void> {
    const indexPath = path.join(workspaceRoot, THREADS_DIR, "index.json");
    try {
      const raw = await fs.readFile(indexPath, "utf8");
      this.store = JSON.parse(raw);
    } catch {
      this.store = { threads: [], activeThreadId: null };
    }
  }

  async persist(workspaceRoot: string): Promise<void> {
    const dir = path.join(workspaceRoot, THREADS_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.json"), JSON.stringify(this.store, null, 2), "utf8");
  }

  getAll(): ThreadSnapshot[] {
    // Return sorted by last activity (most recent first)
    return [...this.store.threads].sort((a, b) => (b.lastActivity || b.timestamp) - (a.lastActivity || a.timestamp));
  }

  getActive(): ThreadSnapshot | undefined {
    return this.store.threads.find((t) => t.id === this.store.activeThreadId);
  }

  /**
   * Save or update the current conversation as a thread.
   * If there's an active thread, update it. Otherwise create a new one.
   */
  saveSnapshot(messages: ChatMessageRecord[], mode: "vibe" | "agile", agentId?: string): ThreadSnapshot {
    const active = this.getActive();

    // Update existing active thread if it exists
    if (active) {
      active.messages = [...messages];
      active.lastActivity = Date.now();
      active.messageCount = messages.length;
      active.mode = mode;
      if (agentId) active.agentId = agentId;
      // Update label from first user message if it was empty
      if (active.label.startsWith("Thread ")) {
        const firstMsg = messages.find((m) => m.role === "user");
        if (firstMsg) active.label = firstMsg.content.slice(0, 60).replace(/\n/g, " ");
      }
      return active;
    }

    // Create new thread
    const id = `thread_${Date.now()}`;
    const firstMsg = messages.find((m) => m.role === "user");
    const label = firstMsg ? firstMsg.content.slice(0, 60).replace(/\n/g, " ") : `Thread ${this.store.threads.length + 1}`;
    const snapshot: ThreadSnapshot = {
      id,
      label,
      timestamp: Date.now(),
      lastActivity: Date.now(),
      messageCount: messages.length,
      messages: [...messages],
      mode,
      agentId
    };
    this.store.threads.push(snapshot);
    this.store.activeThreadId = id;

    // Evict oldest threads if over limit
    if (this.store.threads.length > MAX_THREADS) {
      this.store.threads = this.store.threads
        .sort((a, b) => (b.lastActivity || b.timestamp) - (a.lastActivity || a.timestamp))
        .slice(0, MAX_THREADS);
    }

    return snapshot;
  }

  /**
   * Start a new thread (deactivates current, creates fresh).
   * Call this when user clicks "New Session".
   */
  startNewThread(): void {
    this.store.activeThreadId = null;
  }

  setActive(id: string): ThreadSnapshot | undefined {
    const thread = this.store.threads.find((t) => t.id === id);
    if (thread) this.store.activeThreadId = id;
    return thread;
  }

  revertTo(threadId: string): ChatMessageRecord[] | undefined {
    const thread = this.store.threads.find((t) => t.id === threadId);
    if (!thread) return undefined;
    this.store.activeThreadId = threadId;
    return [...thread.messages];
  }

  deleteThread(id: string): void {
    this.store.threads = this.store.threads.filter((t) => t.id !== id);
    if (this.store.activeThreadId === id) {
      this.store.activeThreadId = null;
    }
  }

  renameThread(id: string, newLabel: string): void {
    const thread = this.store.threads.find((t) => t.id === id);
    if (thread) thread.label = newLabel;
  }
}

export const threadManager = new ThreadManager();
