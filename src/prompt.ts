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
  const sections = ["[dynamic-skill extention: ON]", "## Dynamic skills"];
  const appendSkills = (title: string, skills: Skill[], notice?: string) => {
    const formatted = formatSkillsForPrompt(skills);
    if (!formatted) return;
    // Keep Pi's native instructions once and its XML unchanged in each group.
    const start = formatted.indexOf("<available_skills>");
    if (start < 0) throw new Error("Unexpected Pi skill prompt format");
    if (sections.length === 2) sections.push(formatted.slice(0, start).trim());
    sections.push(`### ${title}`);
    if (notice) sections.push(notice);
    sections.push(formatted.slice(start));
  };
  appendSkills("Root Skills", rootSkills);
  appendSkills("Active skills", active);
  appendSkills("Pending eviction", pending,
    "These skills will be evicted at the next compaction or reload unless\naccessed again. Read a skill's SKILL.md to retain it.");
  return { pendingPaths: pending.map((skill) => skill.filePath), content: sections.join("\n\n") };
}
