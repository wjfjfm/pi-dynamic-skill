import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshWrittenSkill, synchronizeTrees } from "./tree.js";

function resolveToolPath(path: string, cwd: string): string {
  const normalized = path.replace(/^@/, "").replace(/[\u00a0\u2007\u202f]/g, " ");
  return resolve(cwd, normalized === "~" ? homedir() : normalized.startsWith("~/") ? homedir() + normalized.slice(1) : normalized);
}

export default function dynamicSkill(pi: ExtensionAPI): void {
  const discover = () => pi.getCommands().filter((command) => command.source === "skill" && command.name === "skill:dynamic-skill").map((command) => command.sourceInfo.path);
  pi.on("resources_discover", async (_event, ctx) => {
    const warn = (diagnostics: string[]) => {
      const message = `[dynamic-skill] Skill warnings\n${diagnostics.map((line) => `  ${line}`).join("\n")}`;
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else process.stderr.write(message + "\n");
    };
    try {
      const roots = discover();
      let skillPaths: string[] | undefined;
      if (!roots.length) {
        const root = join(getAgentDir(), "skills", "dynamic-skill", "SKILL.md");
        if (!existsSync(root)) {
          try {
            await mkdir(dirname(root), { recursive: true });
            await writeFile(root, "---\nname: dynamic-skill\ndescription: Entry point for dynamically loaded skills. Follow child skill links when relevant to the task.\n---\n", { flag: "wx" });
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
          }
        }
        roots.push(root);
        skillPaths = [root];
      }
      const { diagnostics } = synchronizeTrees(roots);
      if (diagnostics.length) warn(diagnostics);
      if (skillPaths) return { skillPaths };
    } catch (error) {
      // Resource maintenance must never prevent the session from starting.
      warn([error instanceof Error ? error.message : String(error)]);
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
