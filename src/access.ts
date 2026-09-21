import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SkillLruState } from "./lru.js";

export const MANUAL_SELECTION = "dynamic-skill:manual-selection";
export interface ManualSelection { add: string[]; remove: string[] }
export const ACCESS_STATE = "dynamic-skill:access-state";
export const ACTIVE_CAPACITY = 20;
export interface AccessState extends SkillLruState {
  version: 1;
  active: readonly string[];
  pendingEviction: readonly string[];
  /** Last consumed native entry, independent of the snapshot's position. */
  cursor?: string | undefined;
  discovery?: { path: string; source: string; visibleAtAdmission?: boolean }[];
  /** Generation tokens distinguish a fresh overflow from an older notice. */
  pendingTokens?: Record<string, string>;
  announced?: string[];
  cycle?: string;
}

function restore(data: unknown): AccessState {
  if (!data || typeof data !== "object") throw new Error("Invalid dynamic-skill access state");
  const value = data as Partial<AccessState>;
  if (value.version !== 1 || !Array.isArray(value.active) || !Array.isArray(value.pendingEviction)
    || ![...value.active, ...value.pendingEviction].every((path) => typeof path === "string")
    || (value.cursor !== undefined && typeof value.cursor !== "string")
    || (value.cycle !== undefined && typeof value.cycle !== "string")
    || (value.discovery !== undefined && (!Array.isArray(value.discovery) || !value.discovery.every((item) =>
      item && typeof item.path === "string" && typeof item.source === "string"
      && (item.visibleAtAdmission === undefined || typeof item.visibleAtAdmission === "boolean"))))
    || (value.announced !== undefined && (!Array.isArray(value.announced) || !value.announced.every((path) => typeof path === "string")))
    || (value.pendingTokens !== undefined && (!value.pendingTokens || typeof value.pendingTokens !== "object"
      || Array.isArray(value.pendingTokens) || !Object.values(value.pendingTokens).every((token) => typeof token === "string")))) {
    throw new Error("Invalid dynamic-skill access state");
  }
  const paths = [...value.active, ...value.pendingEviction, ...(value.discovery ?? []).map((item) => item.path)];
  if (new Set(paths).size !== paths.length) throw new Error("Dynamic skill queues must be disjoint");
  return value as AccessState;
}

/** Latest session state, deliberately independent of the selected branch. */
export function latestAccessState(entries: SessionEntry[]): { id: string; state: AccessState } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "custom" || entry.customType !== ACCESS_STATE) continue;
    const state = restore(entry.data);
    if (state.pendingTokens) return { id: entry.id, state };
    // Read the old notice format once; do not keep a second settlement engine.
    const announced = entries.slice(i + 1).flatMap((notice) => {
      if (notice.type !== "custom" || notice.customType !== "dynamic-skill:eviction-notice") return [];
      const data = notice.data as { settlementId?: string; paths?: unknown } | undefined;
      return data?.settlementId === entry.id && Array.isArray(data.paths)
        ? data.paths.filter((path): path is string => typeof path === "string" && state.pendingEviction.includes(path)) : [];
    });
    return { id: entry.id, state: { ...state, announced: [...new Set(announced)] } };
  }
  return undefined;
}
