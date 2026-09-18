import { dirname } from "node:path";
import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { ACTIVE_CAPACITY } from "./access.js";
import type { SkillLruState } from "./lru.js";
import { isManagedSkill, listTopLevelSkills } from "./tree.js";

export { DYNAMIC_CONTEXT } from "./context.js";
export function formatDynamicSkills(state: SkillLruState, roots: string[], capacity = ACTIVE_CAPACITY,
  visible: ReadonlySet<string> = new Set(), full = true,
): { content: string; paths: string[]; pendingPaths: string[] } {
  const load = (paths: readonly string[]): Skill[] => paths.flatMap((path) => {
    if (!isManagedSkill(roots, path)) return [];
    return loadSkillsFromDir({ dir: dirname(path), source: "dynamic-skill" }).skills.filter((skill) => skill.filePath === path);
  });
  // Root indexes are read on demand; roots and direct children stay outside LRU lists.
  const rootPaths = new Set([...roots, ...listTopLevelSkills(roots)]);
  const activePaths = state.active.filter((path) => !rootPaths.has(path));
  const active = load(activePaths).filter((skill) => !skill.disableModelInvocation && !visible.has(skill.filePath));
  const pending = load(state.pendingEviction.filter((path) => !rootPaths.has(path))).filter((skill) => !skill.disableModelInvocation && !visible.has(skill.filePath));
  const sections = full ? ["[dynamic-skill extention: ON]", "## Dynamic skills"] : ["## Dynamic skill updates"];
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
  appendSkills(full ? `Active skills (${activePaths.length}/${capacity})` : "New active skills", active, undefined, full);
  appendSkills(full ? "Pending eviction" : "New pending eviction", pending,
    "These skills will be evicted at the next compaction, reload, or backtrack unless\naccessed again. Read a skill's SKILL.md to retain it.");
  if (guidance && full) sections.splice(2, 0, guidance);
  const paths = [...active, ...pending].map((skill) => skill.filePath);
  return { paths, pendingPaths: pending.map((skill) => skill.filePath), content: !full && !paths.length ? "" : sections.join("\n\n") };
}
