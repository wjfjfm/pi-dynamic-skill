import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { managedBlock, managedTarget, synchronizeTrees, validateChange } from "./tree.js";

const CONTEXT_TYPE = "dynamic-skill:roots";
function resolveToolPath(path: string, cwd: string): string {
  const normalized = path.replace(/^@/, "").replace(/[\u00a0\u2007\u202f]/g, " ");
  return resolve(cwd, normalized === "~" ? homedir() : normalized.startsWith("~/") ? homedir() + normalized.slice(1) : normalized);
}

/** Preview exact, disjoint edits against the original file, matching Pi's edit contract. */
function previewEdit(original: string, input: Record<string, unknown>): string {
  original = original.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const generated = managedBlock(original);
  const edits = Array.isArray(input.edits) ? input.edits : [{ oldText: input.oldText, newText: input.newText }];
  if (!edits.length) throw new Error("At least one edit is required.");
  const ranges = edits.map((edit: { oldText?: unknown; newText?: unknown }) => {
    if (typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string") throw new Error("Skill edits require nonempty oldText and string newText.");
    const oldText = edit.oldText.replace(/\r\n/g, "\n");
    const start = original.indexOf(oldText);
    if (start < 0 || original.indexOf(oldText, start + 1) >= 0) throw new Error("Skill edits must match exactly once; read the current SKILL.md first.");
    const end = start + oldText.length;
    if (generated && start < generated.end && end > generated.start) throw new Error("Do not edit the generated dynamic-skill block; edit the child metadata instead.");
    return { start, end, text: edit.newText.replace(/\r\n/g, "\n") };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]!.start < ranges[i - 1]!.end) throw new Error("Skill edits must not overlap.");
  let updated = original;
  for (const range of ranges.reverse()) updated = updated.slice(0, range.start) + range.text + updated.slice(range.end);
  return updated;
}

export default function dynamicSkill(pi: ExtensionAPI): void {
  let rootPaths: string[] = [];
  let lastDiagnostics = "";
  const pendingWrites = new Map<string, string>();
  const discover = () => pi.getCommands().filter((command) => command.source === "skill" && command.name === "skill:dynamic-skill").map((command) => command.sourceInfo.path);
  const sync = (ctx: ExtensionContext) => {
    const result = synchronizeTrees(rootPaths, new Set(pendingWrites.values()));
    const diagnostics = result.diagnostics.join("\n");
    if (diagnostics && diagnostics !== lastDiagnostics) ctx.ui.notify(diagnostics, "warning");
    lastDiagnostics = diagnostics;
    return result;
  };
  pi.on("resources_discover", async () => {
    // Reuse Pi's effective skill selection. Keep the fallback outside package installs
    // so package updates cannot remove skills written during normal use.
    if (discover().length) return;
    const directory = join(getAgentDir(), "skills");
    const root = join(directory, "dynamic-skill", "SKILL.md");
    if (!existsSync(root)) {
      try {
        await mkdir(dirname(root), { recursive: true });
        await writeFile(root, "---\nname: dynamic-skill\ndescription: Entry point for dynamically loaded skills. Follow child skill links when relevant to the task.\n---\n", { flag: "wx" });
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      }
    }
    return { skillPaths: [root] };
  });
  pi.on("agent_end", (_event, ctx) => {
    pendingWrites.clear();
    sync(ctx);
  });
  pi.on("session_start", (_event, ctx) => {
    rootPaths = discover();
    lastDiagnostics = "";
    pendingWrites.clear();
    sync(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
    rootPaths = (event.systemPromptOptions.skills ?? []).filter((skill) => skill.name === "dynamic-skill" && !skill.disableModelInvocation).map((skill) => skill.filePath);
    sync(ctx);
  });
  pi.on("context", (event, ctx) => {
    const { roots, diagnostics } = sync(ctx);
    const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === CONTEXT_TYPE));
    if (!roots.length && !diagnostics.length) return { messages };
    const content = [
      "Dynamic skills: the root skill below is automatically loaded. Use read to load child skills only when needed. Resolve each child link relative to its parent SKILL.md directory.",
      "Create child skills at skills/<name>/SKILL.md inside a parent skill. Each SKILL.md requires YAML name (matching its directory) and description; custom body may be empty. write creates directories automatically. Do not write or edit the generated dynamic-skill block; edit child metadata instead.",
      ...roots.map((root) => `Root skill: ${root.filePath}\nRelative paths are based on ${dirname(root.filePath)}.\n\n${root.body}`),
      ...(diagnostics.length ? [`Dynamic skill diagnostics:\n${diagnostics.join("\n")}`] : []),
    ].join("\n\n");
    return { messages: [...messages, { role: "custom" as const, customType: CONTEXT_TYPE, content, display: false, timestamp: 0 }] };
  });
  pi.on("tool_call", (event, ctx) => {
    const input: Record<string, unknown> = event.input;
    if (!["read", "write", "edit"].includes(event.toolName) || typeof input.path !== "string") return;
    try {
      const path = resolveToolPath(input.path, ctx.cwd);
      const name = managedTarget(rootPaths, path);
      if (!name) return;
      if (event.toolName === "read") {
        sync(ctx);
        return;
      }
      const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      const updated = event.toolName === "write" ? input.content : previewEdit(original ?? "", input);
      if (typeof updated !== "string") throw new Error("Skill content must be a string.");
      validateChange(original, updated, name);
      pendingWrites.set(event.toolCallId, path);
    } catch (error) {
      return { block: true, reason: `dynamic-skill: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  pi.on("tool_result", (event, ctx) => {
    pendingWrites.delete(event.toolCallId);
    if (event.isError || !["write", "edit"].includes(event.toolName) || typeof event.input.path !== "string") return;
    try {
      if (managedTarget(rootPaths, resolveToolPath(event.input.path, ctx.cwd))) sync(ctx);
    } catch (error) {
      ctx.ui.notify(`dynamic-skill: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });
}
