import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Sibling of Pi's agent directory, outside native skill discovery. */
export function storagePaths(agentDir: string) {
  const directory = join(dirname(agentDir), "dynamic-skill");
  return { directory, config: join(directory, "dynamic-skill.json"),
    skills: join(directory, "skills"), root: join(directory, "skills", "dynamic-skill", "SKILL.md") };
}

async function createIfMissing(path: string, content: string): Promise<void> {
  try { await writeFile(path, content, { flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
}

export async function initializeStorage(agentDir: string) {
  const paths = storagePaths(agentDir);
  await mkdir(dirname(paths.root), { recursive: true });
  await createIfMissing(paths.config, await readFile(new URL("../templates/dynamic-skill.json", import.meta.url), "utf8"));
  await createIfMissing(paths.root, await readFile(new URL("../templates/dynamic-skill/SKILL.md", import.meta.url), "utf8"));
  return paths;
}
