import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSkill, reloadSkills, SkillExistsError } from "../dist/skills.js";

test("creates native Pi skills and reloads external replacements", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dynamic-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(reloadSkills(join(root, "missing")).skills, []);
  const input = { name: "review-typescript", description: 'When reviewing "TypeScript: changes"\n检查类型', content: "Review instructions\n\n---\nKeep this body." };
  const ref = await createSkill(root, input);
  const loaded = reloadSkills(root);
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.skills.length, 1);
  assert.equal(loaded.skills[0].description, input.description);
  assert.equal(loaded.skills[0].filePath, ref.filePath);
  const original = await readFile(ref.filePath, "utf8");
  assert.ok(original.endsWith(input.content));
  await assert.rejects(createSkill(root, { ...input, content: "overwrite" }), SkillExistsError);
  assert.equal(await readFile(ref.filePath, "utf8"), original);
  await writeFile(ref.filePath, '---\nname: review-typescript\ndescription: Updated description\n---\n\nUpdated content');
  assert.equal(reloadSkills(root).skills[0].description, "Updated description");
  for (const name of ["../escape", "a/b", "Bad-Name", "a--b"]) {
    await assert.rejects(createSkill(root, { ...input, name }), /Skill name/);
  }
});
