import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadSkillsFromDir, type LoadSkillsResult } from "@earendil-works/pi-coding-agent";

export interface SkillInput {
  name: string;
  description: string;
  content: string;
}

/** Lightweight reference; the full content lives only in SKILL.md. */
export interface SkillReference {
  name: string;
  description: string;
  filePath: string;
}

export class SkillExistsError extends Error {
  constructor(name: string) {
    super(`Skill already exists: ${name}`);
    this.name = "SkillExistsError";
  }
}

/** Create a skill without overwriting an existing name. Does not inject context. */
export async function createSkill(directory: string, input: SkillInput): Promise<SkillReference> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name) || input.name.length > 64) {
    throw new Error("Skill name must contain at most 64 lowercase letters, digits, and single hyphens.");
  }
  if (!input.description.trim() || input.description.length > 1024) {
    throw new Error("Skill description must contain 1–1024 characters and cannot be blank.");
  }

  const root = resolve(directory);
  const skillDirectory = join(root, input.name);
  const filePath = join(skillDirectory, "SKILL.md");
  // JSON strings are valid YAML scalars, including quotes and embedded newlines.
  const text = `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n---\n\n${input.content}`;
  await mkdir(root, { recursive: true });
  // Reserve the name exclusively, including against concurrent writers.
  try {
    await mkdir(skillDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new SkillExistsError(input.name);
    }
    throw error;
  }
  try {
    const temporaryPath = join(skillDirectory, ".SKILL.md.tmp");
    await writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(skillDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { name: input.name, description: input.description, filePath };
}

/** Read the current files on every call; callers decide when and where to inject. */
export function reloadSkills(directory: string): LoadSkillsResult {
  return loadSkillsFromDir({ dir: resolve(directory), source: "dynamic-skill" });
}
