import { dirname } from "node:path";
import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { SkillLruState } from "./lru.js";
import { isManagedSkill, listTopLevelSkills } from "./tree.js";

export const DYNAMIC_CONTEXT = "dynamic-skill:context";
export function formatDynamicSkills(state: SkillLruState, roots: string[]): { content: string; pendingPaths: string[] } {
  const load = (paths: readonly string[]): Skill[] => paths.flatMap((path) => {
    if (!isManagedSkill(roots, path)) return [];
    return loadSkillsFromDir({ dir: dirname(path), source: "dynamic-skill" }).skills.filter((skill) => skill.filePath === path);
  });
  const topLevel = listTopLevelSkills(roots);
  const rootPaths = new Set([...roots, ...topLevel]);
  const rootSkills = load(topLevel).filter((skill) => !skill.disableModelInvocation);
  const active = load(state.active.filter((path) => !rootPaths.has(path)));
  const pending = load(state.pendingEviction.filter((path) => !rootPaths.has(path))).filter((skill) => !skill.disableModelInvocation);
  return { pendingPaths: pending.map((skill) => skill.filePath), content: `## Dynamic skills

### Root Skills
${formatSkillsForPrompt(rootSkills) || "\nNone."}

### Active skills
${formatSkillsForPrompt(active) || "\nNone."}

### Pending eviction

These skills will be evicted at the next compaction or reload unless
accessed again. Read a skill's SKILL.md to retain it.
${formatSkillsForPrompt(pending) || "\nNone."}` };
}
