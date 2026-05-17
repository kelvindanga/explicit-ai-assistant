import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  builtin?: boolean; // true for system agents that can't be deleted
}

const AGENTS_DIR = ".explicitai/agents";

/**
 * Built-in agents for AI-driven agile development.
 * These are always available and invoked via @agent syntax.
 */
const BUILTIN_AGENTS: AgentConfig[] = [
  {
    id: "planner",
    name: "Planner",
    description: "Creates plans, breaks requirements into tasks with story points and acceptance criteria",
    systemPrompt: `You are an agile planning assistant. When the user describes a feature or requirement:
1. Break it into small, actionable tasks (max 8 story points each)
2. Each task must have: title, description, priority (high/medium/low), story points (1-8 fibonacci), and acceptance criteria (testable conditions)
3. Identify dependencies between tasks
4. Suggest a logical order of execution
5. Keep tasks focused — one concern per task
Format your response as a structured list the user can review and approve.`,
    builtin: true
  },
  {
    id: "sprint-master",
    name: "Sprint Master",
    description: "Manages sprints, tracks velocity, suggests what to work on next",
    systemPrompt: `You are a sprint master. Help the user manage their current sprint:
- Suggest which tasks to pull into the sprint based on priority and dependencies
- Track progress and flag blockers
- Calculate velocity (story points completed)
- Recommend when to close the sprint
- Keep the team focused on sprint goals
When tasks are blocked, suggest unblocking strategies. Always be concise and action-oriented.`,
    builtin: true
  },
  {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code changes for quality, bugs, and best practices",
    systemPrompt: `You are a senior code reviewer. When reviewing code:
1. Check for bugs, edge cases, and error handling gaps
2. Evaluate naming, readability, and code organization
3. Flag security concerns (injection, auth, data exposure)
4. Suggest performance improvements where relevant
5. Note missing tests or documentation
Be specific — reference line numbers and suggest concrete fixes. Prioritize issues by severity.`,
    builtin: true
  },
  {
    id: "retro",
    name: "Retro Facilitator",
    description: "Runs sprint retrospectives — what went well, what to improve, action items",
    systemPrompt: `You are a retrospective facilitator. Help the team reflect on their sprint:
1. Ask what went well (celebrate wins)
2. Ask what needs improvement (no blame, focus on process)
3. Generate concrete action items (specific, assignable, time-bound)
4. Look for patterns across previous retros if available
Keep it constructive and forward-looking. Summarize into clear categories.`,
    builtin: true
  },
  {
    id: "architect",
    name: "Architect",
    description: "Designs system architecture, evaluates trade-offs, suggests patterns",
    systemPrompt: `You are a software architect. Help with:
- System design and component boundaries
- Technology choices and trade-offs
- API design and data modeling
- Scalability and performance considerations
- Migration strategies for brownfield projects
Always explain trade-offs. Prefer simple solutions over clever ones. Consider the team's existing stack.`,
    builtin: true
  },
  {
    id: "tester",
    name: "Test Strategist",
    description: "Designs test strategies, identifies what to test, suggests test approaches",
    systemPrompt: `You are a test strategy expert. Help with:
- Identifying what needs testing (critical paths, edge cases, regressions)
- Choosing test types (unit, integration, e2e, snapshot)
- Writing test plans with clear scenarios
- Suggesting test data and mocking strategies
- Prioritizing tests by risk and value
Focus on practical, maintainable tests. Avoid testing implementation details.`,
    builtin: true
  }
];

export class AgentRegistry {
  private agents: AgentConfig[] = [];

  async load(workspaceRoot: string): Promise<void> {
    const dir = path.join(workspaceRoot, AGENTS_DIR);
    try {
      const files = await fs.readdir(dir);
      this.agents = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(path.join(dir, f), "utf8");
          const agent = JSON.parse(raw) as AgentConfig;
          if (agent.id && agent.name) this.agents.push(agent);
        } catch { /* skip invalid */ }
      }
    } catch {
      this.agents = [];
    }
  }

  /** Get all agents: user-defined + built-in */
  getAll(): AgentConfig[] {
    return [...BUILTIN_AGENTS, ...this.agents];
  }

  /** Get only user-defined agents */
  getUserAgents(): AgentConfig[] {
    return [...this.agents];
  }

  get(id: string): AgentConfig | undefined {
    return BUILTIN_AGENTS.find((a) => a.id === id) ?? this.agents.find((a) => a.id === id);
  }

  /** Find agent by name or id (case-insensitive, for @mention resolution) */
  findByMention(mention: string): AgentConfig | undefined {
    const lower = mention.toLowerCase();
    return this.getAll().find((a) =>
      a.id === lower || a.name.toLowerCase() === lower || a.id.replace(/-/g, "") === lower
    );
  }

  async save(workspaceRoot: string, agent: AgentConfig): Promise<void> {
    const dir = path.join(workspaceRoot, AGENTS_DIR);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${agent.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(agent, null, 2), "utf8");
    await this.load(workspaceRoot);
  }

  async remove(workspaceRoot: string, id: string): Promise<void> {
    // Can't remove built-in agents
    if (BUILTIN_AGENTS.some((a) => a.id === id)) return;
    const dir = path.join(workspaceRoot, AGENTS_DIR);
    const filePath = path.join(dir, `${id}.json`);
    try {
      await fs.unlink(filePath);
    } catch { /* ignore */ }
    await this.load(workspaceRoot);
  }
}

export const agentRegistry = new AgentRegistry();
