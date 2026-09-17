---
name: dynamic-skill
description: Entry point for dynamically loaded skills.
---

Dynamic skills preserve reusable knowledge in a multi-level skill tree.
Create a child skill at `./skills/<skill-name>/SKILL.md` inside any skill
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
Root skills are listed separately and do not occupy LRU capacity or expire.

## Example

`/path/to/skills/dynamic-skill/skills/testing/SKILL.md`

```markdown
---
name: testing
description: Use when writing, running, or debugging project tests.
---

Run tests with `npm test`.

When a test fails, isolate the failing case, identify the cause,
and verify the fix before running the full suite.
```
