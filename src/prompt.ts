import { dirname } from "node:path";
import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { ACTIVE_CAPACITY } from "./access.js";
import type { SkillLruState } from "./lru.js";
import { isManagedSkill, listTopLevelSkills } from "./tree.js";

export const DYNAMIC_CONTEXT = "dynamic-skill:context";
export function formatDynamicSkills(state: SkillLruState, roots: string[], capacity = ACTIVE_CAPACITY): { content: string; pendingPaths: string[] } {
  const load = (paths: readonly string[]): Skill[] => paths.flatMap((path) => {
    if (!isManagedSkill(roots, path)) return [];
    return loadSkillsFromDir({ dir: dirname(path), source: "dynamic-skill" }).skills.filter((skill) => skill.filePath === path);
  });
  const topLevel = listTopLevelSkills(roots);
  const rootPaths = new Set([...roots, ...topLevel]);
  const rootSkills = load(topLevel).filter((skill) => !skill.disableModelInvocation);
  const activePaths = state.active.filter((path) => !rootPaths.has(path));
  const active = load(activePaths);
  const pending = load(state.pendingEviction.filter((path) => !rootPaths.has(path))).filter((skill) => !skill.disableModelInvocation);
  const sections = ["[dynamic-skill extention: ON]", "## Dynamic skills"];
  let guidance: string | undefined;
  const appendSkills = (title: string, skills: Skill[], notice?: string, keepEmpty = false) => {
    const formatted = formatSkillsForPrompt(skills);
    if (!formatted) {
      if (keepEmpty) sections.push(`### ${title}`);
      return;
    }
    // Keep Pi's native instructions once and its XML unchanged in each group.
    const start = formatted.indexOf("<available_skills>");
    if (start < 0) throw new Error("Unexpected Pi skill prompt format");
    guidance ??= formatted.slice(0, start).trim();
    sections.push(`### ${title}`);
    if (notice) sections.push(notice);
    sections.push(formatted.slice(start));
  };
  appendSkills("Root Skills", rootSkills);
  appendSkills(`Active skills (${activePaths.length}/${capacity})`, active, undefined, true);
  appendSkills("Pending eviction", pending,
    "These skills will be evicted at the next compaction or reload unless\naccessed again. Read a skill's SKILL.md to retain it.");
  if (guidance) sections.splice(2, 0, guidance);
  return { pendingPaths: pending.map((skill) => skill.filePath), content: sections.join("\n\n") };
}
