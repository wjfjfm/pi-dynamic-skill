import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listTopLevelSkills, refreshWrittenSkill, synchronizeTrees } from "./tree.js";
import { ACTIVE_CAPACITY, latestAccessState } from "./access.js";
import { contextOwner } from "./context.js";
import { createSkillContextRuntime } from "./runtime.js";
import { loadConfig } from "./config.js";

function resolveToolPath(path: string, cwd: string): string {
  const normalized = path.replace(/^@/, "").replace(/[\u00a0\u2007\u202f]/g, " ");
  return resolve(cwd, normalized === "~" ? homedir() : normalized.startsWith("~/") ? homedir() + normalized.slice(1) : normalized);
}

export default function dynamicSkill(pi: ExtensionAPI): void {
  let capacity = ACTIVE_CAPACITY;
  const discover = () => pi.getCommands().filter((command) => command.source === "skill" && command.name === "skill:dynamic-skill").map((command) => command.sourceInfo.path);
  const warn = (ctx: ExtensionContext, diagnostics: string[]) => {
    if (!diagnostics.length) return;
    const message = `[dynamic-skill] Skill warnings\n${diagnostics.map((line) => `  ${line}`).join("\n")}`;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else process.stderr.write(message + "\n");
  };
  pi.registerCommand("dynamic-skill", {
    description: "Show dynamic skill roots and session status",
    handler: async (_args, ctx) => {
      try {
        const roots = [...new Set(discover())];
        const state = latestAccessState(ctx.sessionManager.getBranch())?.state;
        const pinned = new Set([...roots, ...listTopLevelSkills(roots)]);
        const count = (paths: readonly string[] = []) => paths.filter((path) => !pinned.has(path)).length;
        const message = ["Dynamic skills", "", "Root Skills",
          ...(roots.length ? roots.map((path) => dirname(path)) : ["None."]), "",
          `Active: ${count(state?.active)} / ${capacity}`,
          `Pending eviction: ${count(state?.pendingEviction)}`,
          "Counts reflect the last compact/reload/backtrack settlement; active may exceed capacity while descriptions remain visible."].join("\n");
        if (ctx.hasUI) ctx.ui.notify(message, "info");
        else process.stderr.write(message + "\n");
      } catch (error) {
        warn(ctx, [error instanceof Error ? error.message : String(error)]);
      }
    },
  });
  const refresh = (ctx: ExtensionContext, roots: string[]) => {
    try {
      warn(ctx, synchronizeTrees(roots).diagnostics);
    } catch (error) {
      warn(ctx, [error instanceof Error ? error.message : String(error)]);
    }
  };
  const runtime = createSkillContextRuntime(pi, { roots: discover, capacity: () => capacity, resolvePath: resolveToolPath, refresh });
  pi.on("session_compact", (_event, ctx) => runtime.settle(ctx, true));
  pi.on("context", (event, ctx) => {
    // A context-transforming extension owns composition, not this extension's hook order.
    if (contextOwner(pi)) return;
    try {
      const messages = runtime.project(ctx, event.messages);
      runtime.shown(ctx, messages);
      return { messages };
    } catch (error) {
      warn(ctx, [`Context loading failed: ${error instanceof Error ? error.message : String(error)}`]);
    }
  });
  pi.on("resources_discover", async (_event, ctx) => {
    const config = loadConfig(join(getAgentDir(), "dynamic-skill.json"));
    capacity = config.capacity;
    warn(ctx, config.diagnostics);
    try {
      const roots = discover();
      let skillPaths: string[] | undefined;
      if (!roots.length) {
        const root = join(getAgentDir(), "skills", "dynamic-skill", "SKILL.md");
        if (!existsSync(root)) {
          try {
            await mkdir(dirname(root), { recursive: true });
            const template = await readFile(new URL("../templates/dynamic-skill/SKILL.md", import.meta.url), "utf8");
            await writeFile(root, template, { flag: "wx" });
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
          }
        }
        roots.push(root);
        skillPaths = [root];
      }
      refresh(ctx, roots);
      if (_event.reason === "reload") runtime.settle(ctx, false);
      if (skillPaths) return { skillPaths };
    } catch (error) {
      // Resource maintenance must never prevent the session from starting.
      warn(ctx, [error instanceof Error ? error.message : String(error)]);
    }
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.isError || !["write", "edit"].includes(event.toolName) || typeof event.input.path !== "string") return;
    let diagnostics: string[] | undefined;
    try {
      diagnostics = refreshWrittenSkill(discover(), resolveToolPath(event.input.path, ctx.cwd));
    } catch (error) {
      diagnostics = [error instanceof Error ? error.message : String(error)];
    }
    if (!diagnostics?.length) return;
    return {
      content: [...event.content, {
        type: "text" as const,
        text: `[dynamic-skill] The file operation succeeded, but skill validation or directory refresh reported problems. The write was not rolled back. Fix the following issues:\n${diagnostics.join("\n")}`,
      }],
    };
  });
}
