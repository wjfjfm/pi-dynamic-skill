import { Input, matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { SkillNode } from "./tree.js";

export interface SkillRow { path: string; name: string; description: string; depth: number; root: boolean }
export function skillRows(roots: SkillNode[]): SkillRow[] {
  const rows: SkillRow[] = [];
  const visit = (node: SkillNode, depth: number) => {
    rows.push({ path: node.filePath, name: node.name, description: node.description, depth, root: depth === 0 });
    node.children.forEach((child) => visit(child, depth + 1));
  };
  roots.forEach((root) => visit(root, 0));
  return rows;
}

/** Draft-only selector. No session state changes until Enter. */
export class SkillSelector {
  private input = new Input();
  private tab: "LRU" | "All" = "LRU";
  private cursor = 0;
  private selected: Set<string>;
  private lru: SkillRow[];
  private size = 10;
  get focused() { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  constructor(private rows: SkillRow[], active: string[], private theme: Theme,
    private keys: KeybindingsManager, private done: (value: string[] | undefined) => void,
    private redraw: () => void, private height: () => number = () => 24) {
    this.selected = new Set(active);
    this.lru = active.map((path) => rows.find((row) => row.path === path) ?? { path, name: path, description: "Unavailable", depth: 0, root: false });
  }
  private items() {
    const query = this.input.getValue().toLowerCase();
    return (this.tab === "LRU" ? this.lru : this.rows).filter((row) => !query || `${row.name} ${row.description} ${row.path}`.toLowerCase().includes(query));
  }
  handleInput(data: string) {
    const items = this.items();
    if (matchesKey(data, Key.tab)) { this.tab = this.tab === "LRU" ? "All" : "LRU"; this.cursor = 0; }
    else if (this.keys.matches(data, "tui.select.cancel")) { this.done(undefined); return; }
    else if (this.keys.matches(data, "tui.select.confirm")) { this.done([...this.selected]); return; }
    else if (this.keys.matches(data, "tui.select.up")) this.cursor = Math.max(0, this.cursor - 1);
    else if (this.keys.matches(data, "tui.select.down")) this.cursor = Math.min(items.length - 1, this.cursor + 1);
    else if (matchesKey(data, Key.pageUp)) this.cursor = Math.max(0, this.cursor - this.size);
    else if (matchesKey(data, Key.pageDown)) this.cursor = Math.min(items.length - 1, this.cursor + this.size);
    else if (data === " ") {
      const row = items[this.cursor];
      if (row && !row.root) { if (this.selected.has(row.path)) this.selected.delete(row.path); else this.selected.add(row.path); }
    } else { this.input.handleInput(data); this.cursor = 0; }
    this.redraw();
  }
  invalidate() { this.input.invalidate(); }
  render(width: number): string[] {
    const items = this.items();
    this.cursor = Math.max(0, Math.min(this.cursor, items.length - 1));
    this.size = Math.max(1, Math.min(16, this.height() - 9));
    const start = Math.max(0, Math.min(this.cursor - Math.floor(this.size / 2), items.length - this.size));
    const lines = [this.theme.fg("accent", `Dynamic skills   ${this.tab === "LRU" ? "[LRU]  All" : "LRU  [All]"}   (${this.selected.size} selected)`),
      ...this.input.render(width), ""];
    for (const [offset, row] of items.slice(start, start + this.size).entries()) {
      const marker = row.root ? "──" : this.selected.has(row.path) ? "[x]" : "[ ]";
      const line = `${start + offset === this.cursor ? ">" : " "} ${this.tab === "All" ? "  ".repeat(row.depth) : `${start + offset + 1}. `}${marker} ${row.name}${row.root ? ` (${row.path})` : ` — ${row.description}`}`;
      lines.push(start + offset === this.cursor ? this.theme.fg("accent", line) : line);
    }
    if (!items.length) lines.push("No skills. Tab: browse All");
    lines.push("", items[this.cursor]?.path ?? "", `${items.length ? this.cursor + 1 : 0}/${items.length} · Tab: LRU/All · Space: toggle · Enter: apply · Esc: cancel`,
      "LRU reflects last settlement + manual edits. Removals are silent; files are never deleted.");
    return lines.map((line) => truncateToWidth(line, width));
  }
}
