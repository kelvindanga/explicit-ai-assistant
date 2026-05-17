import * as fs from "fs/promises";
import * as path from "path";

/**
 * Planning system for agile workflow.
 * Allows creating task plans, tracking progress, and breaking work into steps.
 * Plans are persisted per-workspace so they survive across sessions.
 */

export interface PlanTask {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in-progress" | "done" | "blocked";
  priority: "high" | "medium" | "low";
  storyPoints?: number;
  acceptanceCriteria?: string[];
  dependsOn?: string[]; // task IDs this task depends on
  createdAt: number;
  completedAt?: number;
  notes: string[];
}

export interface Sprint {
  id: string;
  name: string;
  goal: string;
  taskIds: string[];
  startDate: number;
  endDate: number;
  status: "planning" | "active" | "completed" | "cancelled";
}

export interface Retrospective {
  id: string;
  planId: string;
  sprintId?: string;
  wentWell: string[];
  needsImprovement: string[];
  actionItems: string[];
  createdAt: number;
}

export interface Plan {
  id: string;
  title: string;
  goal: string;
  tasks: PlanTask[];
  sprints: Sprint[];
  retrospectives: Retrospective[];
  createdAt: number;
  updatedAt: number;
  status: "active" | "completed" | "archived";
}

export interface PlanStore {
  plans: Plan[];
  activePlanId: string | null;
}

const PLANS_FILE = ".explicitai/plans.json";

export class PlanManager {
  private store: PlanStore = { plans: [], activePlanId: null };

  async load(workspaceRoot: string): Promise<void> {
    const filePath = path.join(workspaceRoot, PLANS_FILE);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      this.store = JSON.parse(raw);
    } catch {
      this.store = { plans: [], activePlanId: null };
    }
  }

  async persist(workspaceRoot: string): Promise<void> {
    const dir = path.dirname(path.join(workspaceRoot, PLANS_FILE));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, PLANS_FILE),
      JSON.stringify(this.store, null, 2),
      "utf8"
    );
  }

  createPlan(title: string, goal: string): Plan {
    const plan: Plan = {
      id: `plan_${Date.now()}`,
      title,
      goal,
      tasks: [],
      sprints: [],
      retrospectives: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "active"
    };
    this.store.plans.push(plan);
    this.store.activePlanId = plan.id;
    return plan;
  }

  getActivePlan(): Plan | undefined {
    return this.store.plans.find((p) => p.id === this.store.activePlanId);
  }

  getAllPlans(): Plan[] {
    return [...this.store.plans];
  }

  setActivePlan(planId: string): Plan | undefined {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (plan) {
      this.store.activePlanId = planId;
    }
    return plan;
  }

  addTask(planId: string, title: string, description = "", priority: PlanTask["priority"] = "medium"): PlanTask | undefined {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return undefined;

    const task: PlanTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      title,
      description,
      status: "todo",
      priority,
      createdAt: Date.now(),
      notes: []
    };
    plan.tasks.push(task);
    plan.updatedAt = Date.now();
    return task;
  }

  addTaskWithDetails(
    planId: string,
    title: string,
    description: string,
    priority: PlanTask["priority"],
    storyPoints?: number,
    acceptanceCriteria?: string[],
    dependsOn?: string[]
  ): PlanTask | undefined {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return undefined;

    const task: PlanTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      title,
      description,
      status: "todo",
      priority,
      storyPoints,
      acceptanceCriteria,
      dependsOn,
      createdAt: Date.now(),
      notes: []
    };
    plan.tasks.push(task);
    plan.updatedAt = Date.now();
    return task;
  }

  updateTaskStatus(planId: string, taskId: string, status: PlanTask["status"]): void {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return;
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.status = status;
    if (status === "done") {
      task.completedAt = Date.now();
    }
    plan.updatedAt = Date.now();

    // Auto-complete plan if all tasks done
    if (plan.tasks.length > 0 && plan.tasks.every((t) => t.status === "done")) {
      plan.status = "completed";
    }
  }

  addTaskNote(planId: string, taskId: string, note: string): void {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return;
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.notes.push(note);
    plan.updatedAt = Date.now();
  }

  deletePlan(planId: string): void {
    this.store.plans = this.store.plans.filter((p) => p.id !== planId);
    if (this.store.activePlanId === planId) {
      this.store.activePlanId = this.store.plans.find((p) => p.status === "active")?.id ?? null;
    }
  }

  // ─── SPRINT MANAGEMENT ───

  createSprint(planId: string, name: string, goal: string, durationDays = 14): Sprint | undefined {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return undefined;

    const sprint: Sprint = {
      id: `sprint_${Date.now()}`,
      name,
      goal,
      taskIds: [],
      startDate: Date.now(),
      endDate: Date.now() + durationDays * 24 * 60 * 60 * 1000,
      status: "planning"
    };
    plan.sprints.push(sprint);
    plan.updatedAt = Date.now();
    return sprint;
  }

  addTaskToSprint(planId: string, sprintId: string, taskId: string): void {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return;
    const sprint = plan.sprints.find((s) => s.id === sprintId);
    if (!sprint || sprint.taskIds.includes(taskId)) return;
    sprint.taskIds.push(taskId);
    plan.updatedAt = Date.now();
  }

  startSprint(planId: string, sprintId: string): void {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return;
    const sprint = plan.sprints.find((s) => s.id === sprintId);
    if (!sprint) return;
    sprint.status = "active";
    plan.updatedAt = Date.now();
  }

  completeSprint(planId: string, sprintId: string): void {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return;
    const sprint = plan.sprints.find((s) => s.id === sprintId);
    if (!sprint) return;
    sprint.status = "completed";
    plan.updatedAt = Date.now();
  }

  getActiveSprint(planId: string): Sprint | undefined {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return undefined;
    return plan.sprints.find((s) => s.status === "active");
  }

  getSprintVelocity(planId: string, sprintId: string): number {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return 0;
    const sprint = plan.sprints.find((s) => s.id === sprintId);
    if (!sprint) return 0;
    return sprint.taskIds.reduce((sum, tid) => {
      const task = plan.tasks.find((t) => t.id === tid);
      return sum + (task?.status === "done" ? (task.storyPoints ?? 1) : 0);
    }, 0);
  }

  // ─── ACCEPTANCE CRITERIA ───

  setAcceptanceCriteria(planId: string, taskId: string, criteria: string[]): void {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return;
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.acceptanceCriteria = criteria;
    plan.updatedAt = Date.now();
  }

  // ─── STORY POINTS ───

  setStoryPoints(planId: string, taskId: string, points: number): void {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return;
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.storyPoints = points;
    plan.updatedAt = Date.now();
  }

  getTotalPoints(planId: string): { total: number; done: number; remaining: number } {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return { total: 0, done: 0, remaining: 0 };
    let total = 0, done = 0;
    for (const t of plan.tasks) {
      const pts = t.storyPoints ?? 1;
      total += pts;
      if (t.status === "done") done += pts;
    }
    return { total, done, remaining: total - done };
  }

  // ─── DEPENDENCIES ───

  setDependencies(planId: string, taskId: string, dependsOn: string[]): void {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return;
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.dependsOn = dependsOn;
    plan.updatedAt = Date.now();
  }

  getBlockedTasks(planId: string): PlanTask[] {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return [];
    return plan.tasks.filter((t) => {
      if (!t.dependsOn?.length) return false;
      return t.dependsOn.some((depId) => {
        const dep = plan.tasks.find((d) => d.id === depId);
        return dep && dep.status !== "done";
      });
    });
  }

  getReadyTasks(planId: string): PlanTask[] {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return [];
    return plan.tasks.filter((t) => {
      if (t.status !== "todo") return false;
      if (!t.dependsOn?.length) return true;
      return t.dependsOn.every((depId) => {
        const dep = plan.tasks.find((d) => d.id === depId);
        return dep?.status === "done";
      });
    });
  }

  // ─── RETROSPECTIVES ───

  addRetrospective(
    planId: string,
    wentWell: string[],
    needsImprovement: string[],
    actionItems: string[],
    sprintId?: string
  ): Retrospective | undefined {
    const plan = this.store.plans.find((p) => p.id === planId);
    if (!plan) return undefined;

    const retro: Retrospective = {
      id: `retro_${Date.now()}`,
      planId,
      sprintId,
      wentWell,
      needsImprovement,
      actionItems,
      createdAt: Date.now()
    };
    plan.retrospectives.push(retro);
    plan.updatedAt = Date.now();
    return retro;
  }

  getRetrospectives(planId: string): Retrospective[] {
    const plan = this.store.plans.find((p) => p.id === planId);
    return plan?.retrospectives ?? [];
  }

  // ─── AUTO-PLAN GENERATION ───

  /**
   * Generate a plan structure from a requirement description.
   * Returns a suggested breakdown that can be reviewed and adjusted.
   */
  generatePlanBreakdown(requirement: string): { suggestedTasks: Array<{ title: string; description: string; priority: PlanTask["priority"]; storyPoints: number }> } {
    // Heuristic breakdown — the AI will refine this via chat
    const lines = requirement.split(/[.\n]/).filter((l) => l.trim().length > 10);
    const suggestedTasks = lines.slice(0, 10).map((line, i) => ({
      title: line.trim().substring(0, 80),
      description: line.trim(),
      priority: (i < 2 ? "high" : i < 5 ? "medium" : "low") as PlanTask["priority"],
      storyPoints: Math.ceil(line.trim().length / 30) // rough heuristic
    }));
    return { suggestedTasks };
  }

  /**
   * Build a context string showing the active plan for injection into prompts.
   * Includes sprint progress, story points, and dependency info.
   */
  buildContext(): string {
    const plan = this.getActivePlan();
    if (!plan || plan.tasks.length === 0) {
      return "";
    }

    const statusIcon = (s: PlanTask["status"]) =>
      s === "done" ? "✅" : s === "in-progress" ? "🔄" : s === "blocked" ? "🚫" : "⬜";

    const taskLines = plan.tasks.map((t) => {
      const pts = t.storyPoints ? ` (${t.storyPoints}pts)` : "";
      const deps = t.dependsOn?.length ? ` [depends: ${t.dependsOn.join(", ")}]` : "";
      return `  ${statusIcon(t.status)} [${t.priority}]${pts} ${t.title}${t.status === "in-progress" ? " ← CURRENT" : ""}${deps}`;
    });

    const { total, done, remaining } = this.getTotalPoints(plan.id);
    const activeSprint = this.getActiveSprint(plan.id);

    const lines = [
      `=== Active plan: ${plan.title} (${plan.tasks.filter(t => t.status === "done").length}/${plan.tasks.length} tasks, ${done}/${total} pts) ===`,
      `Goal: ${plan.goal}`,
    ];

    if (activeSprint) {
      const velocity = this.getSprintVelocity(plan.id, activeSprint.id);
      const daysLeft = Math.ceil((activeSprint.endDate - Date.now()) / (24 * 60 * 60 * 1000));
      lines.push(`Sprint: ${activeSprint.name} | ${daysLeft} days left | ${velocity} pts done`);
    }

    lines.push("", ...taskLines);

    const ready = this.getReadyTasks(plan.id);
    if (ready.length > 0 && ready.length < plan.tasks.length) {
      lines.push("", `Ready to start: ${ready.map(t => t.title).join(", ")}`);
    }

    return lines.join("\n");
  }
}

export const planManager = new PlanManager();
