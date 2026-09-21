---
name: dynamic-skill
description: "dynamic-skill is an LRU-managed dynamic skill loader. Use it only when the context contains [dynamic-skill extention: ON]. Read when saving exploration findings, trial-and-error experience, important information, or reusable methods as dynamic skills, or when creating, organizing, merging, or correcting the skill tree within dynamic-skill directories."
---

Dynamic skills preserve reusable knowledge in a multi-level skill tree.
Create a child skill at `./skills/<skill-name>/SKILL.md` inside any skill
directory under dynamic-skill. Reading a parent discovers its direct
children's descriptions dynamically. Skill files contain knowledge,
not generated child indexes; the extension never rewrites existing files.

Create a skill in the appropriate part of the tree when complex
exploration reveals new knowledge, repeated trial and error establishes
a reliable approach, important information should be remembered, or a
new tool or method is worth reusing.

Maintain both the tree and its contents. Avoid overcrowded levels,
near-duplicate skills, and outdated or incorrect information. Use file
operations to introduce grouping skills, move skills to suitable
locations, merge similar skills, and correct stale content.

Successful read, write, and edit accesses enter a binary-progressive LRU
queue after each complete tool batch, deduplicated within that batch.
Accessed active skills move halfway toward the front; new or re-accessed
pending skills enter halfway into the active queue. Overflow moves to
pending only when its description is no longer visible. Pending eviction
requires a displayed notice and a later compact, reload, or backtrack.
Only roots are exempt from LRU; all descendants follow the same rules.

Discovered children remain outside LRU until accessed or selected. Their
descriptions are not restored once removed from context. Write and edit
do not discover children. Context updates append only missing descriptions,
regardless of queue; existing descriptions and tool results stay unchanged.
Before backtracking, save useful findings here and confirm the writes
succeeded. Saving knowledge and backtracking are separate operations.

## Example

`/path/to/skills/dynamic-skill/skills/testing/SKILL.md`

```markdown
---
name: Keep the name as short as possible to minimize directory length.
description: Capture this skill's core distinguishing features so it can be precisely recalled when needed.
---

Include all information needed to solve similar problems again:
- The current state.
- Approaches tried that did not work.
- Approaches confirmed to work.
- Recommendations for when this skill is recalled.
```
