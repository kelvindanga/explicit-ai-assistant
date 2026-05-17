import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chatDir = join(root, "media", "chat");
const errors = [];
const bad = /<motion|<\/motion>|createElement\("motion"\)/;

for (const file of ["chat.html", "chat.js"]) {
  const content = readFileSync(join(chatDir, file), "utf8");
  if (bad.test(content)) {
    errors.push(`${file}: invalid motion tags`);
  }
}

const html = readFileSync(join(chatDir, "chat.html"), "utf8");
if (!html.includes('id="thread"')) errors.push("missing thread");
if (!html.includes('id="modelSelect"')) errors.push("missing model selector");
if (!html.includes('id="payloadModal"')) errors.push("missing payload preview");

const js = readFileSync(join(chatDir, "chat.js"), "utf8");
if (!js.includes("acquireVsCodeApi")) errors.push("missing vscode api");
if (!js.includes("payloadPreview")) errors.push("missing payload handler");
if (!js.includes("streamDelta")) errors.push("missing streaming");

if (errors.length) {
  console.error("Validation failed:\n" + errors.map((e) => " - " + e).join("\n"));
  process.exit(1);
}
console.log("Chat UI validation passed.");
