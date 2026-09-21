import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSkillTrees, readChildren, isManagedSkill } from "./tree.js";
import { ACTIVE_CAPACITY, MANUAL_SELECTION } from "./access.js";
import { SkillSelector, skillRows } from "./selector.js";
import { createSkillContextRuntime, DISCOVERY_DETAILS } from "./runtime.js";
import { loadConfig } from "./config.js";
import { initializeStorage } from "./storage.js";

function resolveToolPath(path: string, cwd: string): string {
  const normalized = path.replace(/^@/, "").replace(/[\u00a0\u2007\u202f]/g, " ");
  return resolve(cwd, normalized === "~" ? homedir() : normalized.startsWith("~/") ? homedir() + normalized.slice(1) : normalized);
}

export default function dynamicSkill(pi: ExtensionAPI): void {
  let capacity = ACTIVE_CAPACITY;
  let registeredRoot: string | undefined;
  const discover = () => [...new Set([
    ...(registeredRoot ? [registeredRoot] : []),
    ...pi.getCommands().filter((command) => command.source === "skill" && command.name === "skill:dynamic-skill").map((command) => command.sourceInfo.path),
  ])];
  const warn = (ctx: ExtensionContext, diagnostics: string[]) => {
    if (!diagnostics.length) return;
    const message = `[dynamic-skill] Skill warnings\n${diagnostics.map((line) => `  ${line}`).join("\n")}`;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else process.stderr.write(message + "\n");
  };
  pi.registerCommand("dynamic-skill", {
    description: "Select dynamic skills: Queues / All skill tree",
    handler: async (_args, ctx) => {
      try {
        const roots = [...new Set(discover())];
        const state = runtime.state(ctx);
        const active = state.active.filter((path) => !roots.includes(path));
        if (ctx.mode === "tui") {
          const tree = readSkillTrees(roots);
          warn(ctx, tree.diagnostics);
          const selected = await ctx.ui.custom<string[] | undefined>((tui, theme, keys, done) =>
            new SkillSelector(skillRows(tree.roots), active, theme, keys, done, () => tui.requestRender(), () => tui.terminal.rows, state));
          if (selected) {
            const add = selected.filter((path) => !active.includes(path));
            const remove = active.filter((path) => !selected.includes(path));
            if (add.length || remove.length) {
              pi.appendEntry(MANUAL_SELECTION, { add, remove });
              runtime.reconcile(ctx);
            }
          }
          return;
        }
        const message = ["Dynamic skills (read-only; interactive selection requires TUI)", "", "Root directories",
          ...(roots.length ? roots.map((path) => dirname(path)) : ["None."]), "",
          `Active: ${active.length} / ${capacity} (LRU)`, ...active.map((path, i) => `${i + 1}. ${path}`),
          `Pending eviction: ${state.pendingEviction.length}`, ...state.pendingEviction,
          `Discovery: ${state.discovery?.length ?? 0}`, ...(state.discovery ?? []).map((item) => item.path),
          "Queues preserve current session intent."].join("\n");
        if (ctx.hasUI) ctx.ui.notify(message, "info");
        else process.stderr.write(message + "\n");
      } catch (error) {
        warn(ctx, [error instanceof Error ? error.message : String(error)]);
      }
    },
  });
  const refresh = (ctx: ExtensionContext, roots: string[]) => {
    try {
      warn(ctx, readSkillTrees(roots).diagnostics);
    } catch (error) {
      warn(ctx, [error instanceof Error ? error.message : String(error)]);
    }
  };
  const runtime = createSkillContextRuntime(pi, { roots: discover, capacity: () => capacity, resolvePath: resolveToolPath });
  pi.on("session_start", (event, ctx) => runtime.start(ctx, event.reason, event.previousSessionFile));
  pi.on("session_compact", (_event, ctx) => runtime.settle(ctx, true));
  // Structural declaration of the experimental host's public event. Remove
  // this bridge once the published SDK includes SessionBacktrackEvent. No
  // extension discovery, private event bus, or backtrack tool dependency.
  const lifecycle = pi as ExtensionAPI & {
    on(event: "session_backtrack", handler: (event: { backtrackEntry: { id: string } }, ctx: ExtensionContext) => void): void;
  };
  let pendingCycle: string | undefined;
  lifecycle.on("session_backtrack", (event) => { pendingCycle = `backtrack:${event.backtrackEntry.id}`; });
  pi.on("turn_end", (_event, ctx) => {
    if (pendingCycle) { runtime.settle(ctx, false, pendingCycle); pendingCycle = undefined; }
    else runtime.reconcile(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const message = runtime.additions(ctx)[0];
    if (message?.role === "custom") return { message };
  });
  pi.on("session_tree", (_event, ctx) => runtime.reconcile(ctx));
  pi.on("context", (event, ctx) => {
    // Observe the actual request. Context rebuilding and next-turn refresh
    // belong to the host; never restore or append messages in a context hook.
    runtime.shown(ctx, event.messages);
  });
  pi.on("resources_discover", async (_event, ctx) => {
    try {
      const paths = await initializeStorage(getAgentDir());
      registeredRoot = paths.root;
      const config = loadConfig(paths.config);
      capacity = config.capacity;
      warn(ctx, config.diagnostics);
      refresh(ctx, discover());
      if (_event.reason === "reload") runtime.settle(ctx, false);
      return { skillPaths: [paths.skills] };
    } catch (error) {
      // Resource maintenance must never prevent the session from starting.
      warn(ctx, [error instanceof Error ? error.message : String(error)]);
    }
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.isError || event.toolName !== "read" || typeof event.input.path !== "string") return;
    const parent = resolveToolPath(event.input.path, ctx.cwd);
    if (!isManagedSkill(discover(), parent)) return;
    try {
      const result = readChildren(discover(), parent);
      warn(ctx, result.diagnostics);
      return { details: { ...(event.details && typeof event.details === "object" ? event.details : {}),
        [DISCOVERY_DETAILS]: { parent, children: result.roots } } };
    } catch (error) {
      warn(ctx, [error instanceof Error ? error.message : String(error)]);
    }
  });
}
