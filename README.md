# Explicit AI Assistant

A VS Code extension for AI-driven agile development with explicit context control. No auto-indexing, no hidden magic — you control exactly what the AI sees.

## Features

### Dual Workflow Modes

- **Vibe Mode** — Chat first, then build. Explore ideas and iterate as you discover needs.
- **Agile Mode** — Plan enough to start, then build, test, and improve continuously in small cycles.

Switch modes anytime from the chat UI. Conversations auto-save as threads when you switch.

### AI-Powered Agile Planning

Full sprint-based agile workflow built into the chat:

#### Plans & Tasks

- Create plans with goals and break them into tasks
- Tasks support priority (high/medium/low), story points, acceptance criteria, and dependencies
- Auto-plan: describe a requirement and the AI suggests a task breakdown
- Dependency tracking: see which tasks are blocked vs ready to start

#### Sprints

- Create time-boxed sprints (default 14 days)
- Assign tasks to sprints
- Track velocity (story points completed per sprint)
- Sprint context automatically injected into AI prompts

#### Retrospectives

- Record what went well, what needs improvement, and action items
- Tied to sprints for historical tracking
- Inspect-and-adapt feedback loop

### Agents

Custom AI personas stored as JSON in `.explicitai/agents/`:

- Create agents with custom system prompts (e.g., "Code Reviewer", "Architect", "Test Writer")
- Switch agents on the fly — the system prompt changes accordingly
- Agents persist across sessions

Built-in agents (always available):

| Agent | Invoke with | Purpose |
|-------|-------------|---------|
| Planner | `@planner` | Breaks requirements into tasks with story points and acceptance criteria |
| Sprint Master | `@sprint-master` | Manages sprints, tracks velocity, suggests next work |
| Code Reviewer | `@reviewer` | Reviews code for bugs, security, and best practices |
| Retro Facilitator | `@retro` | Runs retrospectives — what went well, what to improve |
| Architect | `@architect` | System design, trade-offs, patterns |
| Test Strategist | `@tester` | Test strategies, what to test, test approaches |

Usage: type `@` in the chat input to see available agents, then write your message:

```
@planner Build a user authentication system with OAuth2 and email/password
@reviewer #src/auth/login.ts check this for security issues
@retro we just finished the sprint, let's reflect
```

### @ and # Syntax

- `@agentName message` — invoke a specific agent for this message (autocomplete on `@`)
- `#path/to/file` — attach a file to the conversation (autocomplete on `#`)
- `@filename.ts` — also attaches files (existing behavior)

Examples:
```
@planner I need a payment integration with Stripe
@reviewer #src/api/payments.ts #src/models/Order.ts review these
@tester #src/auth/login.ts what tests do I need?
How does #src/core/planner.ts work?
```

### Project Memory

The AI remembers across sessions:

- Decisions, preferences, patterns, warnings, and knowledge
- Keyword-based retrieval — relevant memories auto-injected into prompts
- Manual remember/forget from the chat UI

### Built-in Developer Tools

The AI can use workspace tools directly:

| Tool | Category | Approval |
|------|----------|----------|
| readFile | read | auto |
| listDir | read | auto |
| search | read | auto |
| findFiles | read | auto |
| writeFile | write | required |
| editFile | write | required |
| createDir | write | required |
| deleteFile | write | required |
| runCommand | shell | required |

Read tools execute immediately. Write/shell tools always require your approval.

### MCP Integration

Model Context Protocol support with manual approval for every action:

- Configure servers in `.explicitai/mcp.json`
- Toggle individual tools (filesystem, terminal, HTTP)
- Enable/disable servers from the UI

### Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| Open Chat | `Ctrl+Shift+A` | Open the AI chat |
| Ask About Selection | `Ctrl+Shift+E` | Ask about selected code |
| Ask (No Context) | `Ctrl+Shift+M` | Free-form question |
| Explain This Code | `Ctrl+Shift+H` | Explain current file/selection |
| Fix Errors in File | `Ctrl+Shift+F` | Fix diagnostics |
| Generate Tests | `Ctrl+Shift+T` | Unit tests or behavior snapshots |
| New Session | `Ctrl+Shift+N` | Save thread and start fresh |
| Stop Generation | `Ctrl+Shift+X` | Cancel current response |
| Generate PR Description | — | From git diff + commits |
| Generate Documentation | — | JSDoc/TSDoc for exports |
| Ask About Codebase | — | Workspace-aware questions |
| Export Conversation | — | Markdown or JSON |
| Check LM Studio Connection | — | Health check |

### Thread History

- Conversations auto-save as threads
- Switch between threads or revert to a previous state
- Threads track mode (vibe/agile) and active agent

### Context Management

- Token budget tracking with visual utilization bar
- Automatic conversation compaction (summarizes old messages to free space)
- Manual compact button when you want to free context immediately
- Stack detection auto-injects project info (framework, language, test runner, etc.)

## Setup

1. Install [LM Studio](https://lmstudio.ai/) and load a model
2. Start the local server (default: `http://localhost:1234`)
3. Install this extension
4. Open the Explicit AI sidebar from the activity bar

### Configuration

All settings under `explicitAI.*` in VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `lmStudioBaseUrl` | `http://localhost:1234` | LM Studio server URL |
| `defaultModel` | `meta-llama-3.1-8b-instruct` | Fallback model |
| `codeModel` | `codeqwen1.5-7b-chat` | Model for code tasks |
| `streaming` | `true` | Stream tokens via SSE |
| `temperature` | `0.7` | Sampling temperature |
| `maxTokens` | `4096` | Max tokens per response |
| `enforceEnglish` | `true` | Auto-retry non-English responses |
| `mcpEnabled` | `false` | Enable MCP tools |

## Agile Workflow Guide

### Quick Start (Agent-Driven)

The fastest way to do agile development:

```
@planner Build a REST API for user management with CRUD operations
```

The planner agent breaks it into tasks with story points and acceptance criteria. Then:

```
@sprint-master create a sprint and pull in the high-priority tasks
@sprint-master what should I work on next?
@reviewer #src/controllers/UserController.ts
@retro we finished the sprint
```

### Manual Workflow

1. Switch to **Agile** mode in the chat
2. Create a plan: give it a title and goal
3. Use `@planner` with your requirement — the AI breaks it into tasks
4. Create a sprint and assign tasks
5. Start the sprint
6. Work through tasks, updating status as you go
7. Complete the sprint — check velocity
8. Run `@retro` for a retrospective

### Message API (for webview integration)

Plans:
```json
{ "type": "createPlan", "title": "Auth System", "goal": "Secure user authentication" }
{ "type": "getPlan" }
```

Tasks:
```json
{ "type": "addDetailedTask", "title": "Login endpoint", "description": "POST /auth/login", "priority": "high", "storyPoints": 5, "acceptanceCriteria": ["Returns JWT", "Rate limited"], "dependsOn": [] }
{ "type": "updateTaskStatus", "taskId": "task_xxx", "status": "done" }
{ "type": "setStoryPoints", "taskId": "task_xxx", "points": 3 }
{ "type": "setAcceptanceCriteria", "taskId": "task_xxx", "criteria": ["Passes tests"] }
{ "type": "setDependencies", "taskId": "task_xxx", "dependsOn": ["task_yyy"] }
```

Sprints:
```json
{ "type": "createSprint", "name": "Sprint 1", "goal": "Core auth", "durationDays": 7 }
{ "type": "addTaskToSprint", "sprintId": "sprint_xxx", "taskId": "task_xxx" }
{ "type": "startSprint", "sprintId": "sprint_xxx" }
{ "type": "completeSprint", "sprintId": "sprint_xxx" }
```

Retrospectives:
```json
{ "type": "addRetrospective", "wentWell": ["Fast delivery"], "needsImprovement": ["Test coverage"], "actionItems": ["Add CI checks"], "sprintId": "sprint_xxx" }
{ "type": "getRetrospectives" }
```

Auto-planning:
```json
{ "type": "autoPlan", "requirement": "Build OAuth2 login with Google and GitHub providers" }
```

## Architecture

```
src/
├── agents/          # Custom AI agent registry
├── chat/            # Chat session management
├── commands/        # VS Code command implementations
├── core/            # Core modules (planner, memory, context, LLM client, etc.)
├── mcp/             # Model Context Protocol integration
├── threads/         # Conversation thread persistence
├── tools/           # Built-in workspace tools
├── ui/              # Webview host, panel, provider
└── extension.ts     # Entry point
```

Data stored in workspace:
```
.explicitai/
├── agents/          # Agent JSON configs
├── threads/         # Conversation snapshots
├── plans.json       # Plans, tasks, sprints, retros
└── memory.json      # Persistent project memory
```

## Development

```bash
npm install
npm run build        # Compile TypeScript + validate HTML
npm run watch        # Watch mode for development
```

Press `F5` in VS Code to launch the extension in a development host.

## License

Local use only.
