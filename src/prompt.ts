import { dirname } from "node:path";
import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { SkillLruState } from "./lru.js";
import { isManagedSkill } from "./tree.js";

export const DYNAMIC_CONTEXT = "dynamic-skill:context";
export const INSTRUCTIONS = `## Dynamic skills

Dynamic skills preserve reusable knowledge in a multi-level skill tree.
Create a child skill at \`./skills/<skill-name>/SKILL.md\` inside any skill
directory under dynamic-skill. Each child's name, description, and path
are automatically indexed in its parent's SKILL.md. Do not manually
create or edit these generated indexes.

Create a skill in the appropriate part of the tree when complex
exploration reveals new knowledge, repeated trial and error establishes
a reliable approach, important information should be remembered, or a
new tool or method is worth reusing.

Maintain both the tree and its contents. Avoid overcrowded levels,
near-duplicate skills, and outdated or incorrect information. Use file
operations to introduce grouping skills, move skills to suitable
locations, merge similar skills, and correct stale content. Parent
indexes are maintained automatically.

The skill list uses a binary-progressive LRU queue. Successful read,
write, and edit accesses are deduplicated per settlement interval.
At compaction or reload, accessed active skills move halfway toward the
front; new or re-accessed pending skills enter halfway into the active
queue. Overflow moves to the pending-eviction list.
Root skills are listed separately and do not occupy LRU capacity or expire.`;

export function formatDynamicSkills(state: SkillLruState, roots: string[]): { content: string; pendingPaths: string[] } {
  const load = (paths: readonly string[]): Skill[] => paths.flatMap((path) => {
    if (!isManagedSkill(roots, path)) return [];
    return loadSkillsFromDir({ dir: dirname(path), source: "dynamic-skill" }).skills.filter((skill) => skill.filePath === path);
  });
  const rootPaths = new Set(roots);
  const rootSkills = load([...rootPaths]);
  const active = load(state.active.filter((path) => !rootPaths.has(path)));
  const pending = load(state.pendingEviction.filter((path) => !rootPaths.has(path))).filter((skill) => !skill.disableModelInvocation);
  return { pendingPaths: pending.map((skill) => skill.filePath), content: `${INSTRUCTIONS}

### Root Skills
${formatSkillsForPrompt(rootSkills) || "\nNone."}

### Active skills
${formatSkillsForPrompt(active) || "\nNone."}

### Pending eviction

These skills will be evicted at the next compaction or reload unless
accessed again. Read a skill's SKILL.md to retain it.
${formatSkillsForPrompt(pending) || "\nNone."}` };
}
