import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isManagedSkill, refreshWrittenSkill, synchronizeTrees } from "./tree.js";
import { ACCESS_NOTICE, ACCESS_STATE, ACTIVE_CAPACITY, latestAccessState, noticeWasShown, settleAccesses } from "./access.js";
import { DYNAMIC_CONTEXT, formatDynamicSkills } from "./prompt.js";

function resolveToolPath(path: string, cwd: string): string {
  const normalized = path.replace(/^@/, "").replace(/[\u00a0\u2007\u202f]/g, " ");
  return resolve(cwd, normalized === "~" ? homedir() : normalized.startsWith("~/") ? homedir() + normalized.slice(1) : normalized);
}

export default function dynamicSkill(pi: ExtensionAPI): void {
  let projection: { key: string; content: string; pendingPaths: string[] } | undefined;
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
        const count = (paths: readonly string[] = []) => paths.filter((path) => !roots.includes(path)).length;
        const message = ["Dynamic skills", "", "Root Skills",
          ...(roots.length ? roots.map((path) => dirname(path)) : ["None."]), "",
          `Active: ${count(state?.active)} / ${ACTIVE_CAPACITY}`,
          `Pending eviction: ${count(state?.pendingEviction)}`,
          "Counts reflect the last compact/reload settlement."].join("\n");
        if (ctx.hasUI) ctx.ui.notify(message, "info");
        else process.stderr.write(message + "\n");
      } catch (error) {
        warn(ctx, [error instanceof Error ? error.message : String(error)]);
      }
    },
  });
  const refresh = (ctx: ExtensionContext, roots: string[]) => {
    projection = undefined;
    try {
      warn(ctx, synchronizeTrees(roots).diagnostics);
    } catch (error) {
      warn(ctx, [error instanceof Error ? error.message : String(error)]);
    }
  };
  const settle = (ctx: ExtensionContext, roots: string[]) => {
    try {
      const rootPaths = new Set(roots);
      const state = settleAccesses(ctx.sessionManager.getBranch(), (path) => resolveToolPath(path, ctx.cwd), (path) => !rootPaths.has(path) && isManagedSkill(roots, path));
      pi.appendEntry(ACCESS_STATE, state);
    } catch (error) {
      const message = `[dynamic-skill] Access settlement failed: ${error instanceof Error ? error.message : String(error)}`;
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else process.stderr.write(message + "\n");
    }
  };
  pi.on("session_compact", (_event, ctx) => {
    const roots = discover();
    refresh(ctx, roots);
    settle(ctx, roots);
  });
  pi.on("context", (event, ctx) => {
    try {
      const branch = ctx.sessionManager.getBranch();
      const snapshot = latestAccessState(branch);
      const roots = discover();
      const key = JSON.stringify([ctx.sessionManager.getSessionId(), snapshot?.id, roots]);
      if (projection?.key !== key) {
        projection = { key, ...formatDynamicSkills(snapshot?.state ?? { active: [], pendingEviction: [] }, roots) };
      }
      if (snapshot?.state.pendingEviction.length && !noticeWasShown(branch, snapshot.id)) {
        pi.appendEntry(ACCESS_NOTICE, { settlementId: snapshot.id, paths: projection.pendingPaths });
      }
      return { messages: [{ role: "custom" as const, customType: DYNAMIC_CONTEXT,
        content: projection.content, display: false, timestamp: 0 },
      ...event.messages.filter((message) => message.role !== "custom" || message.customType !== DYNAMIC_CONTEXT)] };
    } catch (error) {
      const message = `[dynamic-skill] Context loading failed: ${error instanceof Error ? error.message : String(error)}`;
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else process.stderr.write(message + "\n");
    }
  });
  pi.on("resources_discover", async (_event, ctx) => {
    projection = undefined;
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
      if (_event.reason === "reload") settle(ctx, roots);
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
