import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export interface SkillNode { name: string; description: string; filePath: string; disableModelInvocation: boolean; children: SkillNode[] }
export interface TreeResult { roots: SkillNode[]; diagnostics: string[] }

export function validateSkill(text: string, expectedName: string) {
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) throw new Error("SKILL.md requires YAML frontmatter enclosed by --- lines.");
  const { frontmatter } = parseFrontmatter(text);
  const { name, description } = frontmatter;
  if (typeof name !== "string" || !slug.test(name) || name.length > 64 || name !== expectedName) throw new Error(`SKILL.md name must match its node name: ${expectedName}`);
  if (typeof description !== "string" || !description.trim() || description.length > 1024) throw new Error("SKILL.md requires a nonblank description of at most 1024 characters.");
  return { name, description, disableModelInvocation: frontmatter["disable-model-invocation"] === true };
}

function readNode(filePath: string, name: string): SkillNode {
  if (basename(dirname(filePath)) !== name) throw new Error(`Skill directory must be named ${name}`);
  for (const path of [dirname(filePath), filePath]) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (path === filePath ? !stat.isFile() : !stat.isDirectory())) throw new Error("Skill nodes must be real directories and regular files");
  }
  const directory = lstatSync(join(dirname(filePath), "skills"), { throwIfNoEntry: false });
  if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) throw new Error("skills must be a real directory");
  return { ...validateSkill(readFileSync(filePath, "utf8"), name), filePath, children: [] };
}

/** Validate the complete ancestor chain, without following tree-local symlinks. */
export function isManagedSkill(roots: string[], filePath: string): boolean {
  if (basename(filePath) !== "SKILL.md") return false;
  return roots.some((root) => {
    const parts = relative(dirname(root), filePath).split(sep);
    if (parts.length % 2 !== 1 || !parts.slice(0, -1).every((part, i) => i % 2 === 0 ? part === "skills" : slug.test(part) && part.length <= 64)) return false;
    try {
      readNode(root, "dynamic-skill");
      let directory = dirname(root);
      for (let i = 0; i < parts.length - 1; i += 2) {
        directory = join(directory, "skills", parts[i + 1]!);
        readNode(join(directory, "SKILL.md"), parts[i + 1]!);
      }
      return true;
    } catch { return false; }
  });
}

/** One level only; browsing and discovery share exactly the same validation. */
export function readChildren(roots: string[], filePath: string): TreeResult {
  const result: TreeResult = { roots: [], diagnostics: [] };
  if (!isManagedSkill(roots, filePath)) return result;
  const directory = join(dirname(filePath), "skills");
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name, "SKILL.md");
    try {
      if (!entry.isDirectory()) throw new Error("Expected a real skill directory");
      result.roots.push(readNode(path, entry.name));
    } catch (error) { result.diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return result;
}

export function readSkillTrees(rootPaths: string[]): TreeResult {
  const roots = [...new Set(rootPaths)];
  const diagnostics: string[] = [];
  const visit = (node: SkillNode): SkillNode => {
    const children = readChildren(roots, node.filePath);
    diagnostics.push(...children.diagnostics);
    return { ...node, children: children.roots.map(visit) };
  };
  return { roots: roots.flatMap((path) => {
    try { return [visit(readNode(path, "dynamic-skill"))]; }
    catch (error) { diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); return []; }
  }), diagnostics };
}
