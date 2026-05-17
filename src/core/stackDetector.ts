import * as vscode from "vscode";
import * as path from "path";

export interface ProjectStack {
  runtime: string;
  framework: string | null;
  language: string;
  testFramework: string | null;
  buildTool: string | null;
  cssFramework: string | null;
  stateManagement: string | null;
  packageManager: string;
  summary: string;
}

/**
 * Auto-detect the project's tech stack from package.json and config files.
 * Provides context so the AI can tailor suggestions to the actual stack.
 */
export async function detectStack(): Promise<ProjectStack | null> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return null;
  }

  let pkg: Record<string, unknown> = {};
  try {
    const uri = vscode.Uri.file(path.join(root, "package.json"));
    const data = await vscode.workspace.fs.readFile(uri);
    pkg = JSON.parse(Buffer.from(data).toString("utf8"));
  } catch {
    return null;
  }

  const allDeps = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {})
  };
  const has = (name: string) => name in allDeps;

  // Runtime
  const runtime = has("@types/node") || has("ts-node") || has("express") || has("fastify")
    ? "Node.js" : "Browser/Node.js";

  // Language
  const language = has("typescript") || has("@types/node") ? "TypeScript" : "JavaScript";

  // Framework detection
  let framework: string | null = null;
  if (has("next")) framework = "Next.js";
  else if (has("nuxt")) framework = "Nuxt";
  else if (has("@angular/core")) framework = "Angular";
  else if (has("svelte") || has("@sveltejs/kit")) framework = "Svelte/SvelteKit";
  else if (has("vue")) framework = "Vue";
  else if (has("react") || has("react-dom")) framework = "React";
  else if (has("express")) framework = "Express";
  else if (has("fastify")) framework = "Fastify";
  else if (has("hono")) framework = "Hono";
  else if (has("@nestjs/core")) framework = "NestJS";

  // Test framework
  let testFramework: string | null = null;
  if (has("vitest")) testFramework = "Vitest";
  else if (has("jest") || has("@jest/core")) testFramework = "Jest";
  else if (has("mocha")) testFramework = "Mocha";
  else if (has("@playwright/test")) testFramework = "Playwright";
  else if (has("cypress")) testFramework = "Cypress";

  // Build tool
  let buildTool: string | null = null;
  if (has("vite")) buildTool = "Vite";
  else if (has("webpack") || has("webpack-cli")) buildTool = "Webpack";
  else if (has("esbuild")) buildTool = "esbuild";
  else if (has("rollup")) buildTool = "Rollup";
  else if (has("turbo")) buildTool = "Turborepo";
  else if (has("tsup")) buildTool = "tsup";

  // CSS
  let cssFramework: string | null = null;
  if (has("tailwindcss")) cssFramework = "Tailwind CSS";
  else if (has("@mui/material") || has("@material-ui/core")) cssFramework = "Material UI";
  else if (has("styled-components")) cssFramework = "styled-components";
  else if (has("@emotion/react")) cssFramework = "Emotion";
  else if (has("sass") || has("node-sass")) cssFramework = "Sass";
  else if (has("bootstrap")) cssFramework = "Bootstrap";

  // State management
  let stateManagement: string | null = null;
  if (has("zustand")) stateManagement = "Zustand";
  else if (has("@reduxjs/toolkit") || has("redux")) stateManagement = "Redux";
  else if (has("mobx")) stateManagement = "MobX";
  else if (has("pinia")) stateManagement = "Pinia";
  else if (has("recoil")) stateManagement = "Recoil";
  else if (has("jotai")) stateManagement = "Jotai";

  // Package manager
  let packageManager = "npm";
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, "pnpm-lock.yaml")));
    packageManager = "pnpm";
  } catch {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, "yarn.lock")));
      packageManager = "yarn";
    } catch {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, "bun.lockb")));
        packageManager = "bun";
      } catch { /* npm */ }
    }
  }

  const parts = [language, framework, buildTool, cssFramework, testFramework].filter(Boolean);
  const summary = parts.join(" + ") + ` (${packageManager})`;

  return {
    runtime,
    framework,
    language,
    testFramework,
    buildTool,
    cssFramework,
    stateManagement,
    packageManager,
    summary
  };
}

/**
 * Build a context string describing the project stack for the LLM.
 */
export async function getStackContext(): Promise<string> {
  const stack = await detectStack();
  if (!stack) {
    return "";
  }

  const lines = [
    `Project stack: ${stack.summary}`,
    `Runtime: ${stack.runtime}`,
    `Language: ${stack.language}`
  ];
  if (stack.framework) lines.push(`Framework: ${stack.framework}`);
  if (stack.buildTool) lines.push(`Build: ${stack.buildTool}`);
  if (stack.testFramework) lines.push(`Tests: ${stack.testFramework}`);
  if (stack.cssFramework) lines.push(`Styling: ${stack.cssFramework}`);
  if (stack.stateManagement) lines.push(`State: ${stack.stateManagement}`);
  lines.push(`Package manager: ${stack.packageManager}`);

  return lines.join("\n");
}
