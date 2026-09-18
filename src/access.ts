import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { accessSkill, accessSkillState, type SkillLruState } from "./lru.js";

export const MANUAL_SELECTION = "dynamic-skill:manual-selection";
export interface ManualSelection { add: string[]; remove: string[] }

/** Unsettled manual intent; deliberately separate from the access scan boundary. */
export function manualSelection(branch: SessionEntry[]): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === ACCESS_STATE) result.clear();
    if (entry.customType !== MANUAL_SELECTION) continue;
    const data = entry.data as ManualSelection;
    for (const [paths, selected] of [[data.add, true], [data.remove, false]] as const) {
      for (const path of paths) { result.delete(path); result.set(path, selected); }
    }
  }
  return result;
}

export function selectionState(branch: SessionEntry[]): AccessState {
  const snapshot = latestAccessState(branch)?.state ?? { version: 1 as const, active: [], pendingEviction: [] };
  let active = [...snapshot.active];
  let pendingEviction = [...snapshot.pendingEviction];
  for (const [path, selected] of manualSelection(branch)) {
    active = selected ? accessSkill(active, path) : active.filter((item) => item !== path);
    pendingEviction = pendingEviction.filter((item) => item !== path);
    // Manual removals are intentionally absent from the public pending list.
  }
  return { version: 1, active, pendingEviction };
}

export const ACCESS_STATE = "dynamic-skill:access-state";
export const ACCESS_NOTICE = "dynamic-skill:eviction-notice";
export const ACTIVE_CAPACITY = 20;
export interface AccessState extends SkillLruState { version: 1 }

function restore(data: unknown): AccessState {
  if (!data || typeof data !== "object") throw new Error("Invalid dynamic-skill access state");
  const value = data as Partial<AccessState>;
  if (value.version !== 1 || !Array.isArray(value.active) || !Array.isArray(value.pendingEviction)
    || ![...value.active, ...value.pendingEviction].every((path) => typeof path === "string")
    || new Set([...value.active, ...value.pendingEviction]).size !== value.active.length + value.pendingEviction.length) {
    throw new Error("Invalid dynamic-skill access state");
  }
  return value as AccessState;
}

export function latestAccessState(branch: SessionEntry[]): { id: string; state: AccessState } | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "custom" && entry.customType === ACCESS_STATE) return { id: entry.id, state: restore(entry.data) };
  }
  return undefined;
}

export function noticeWasShown(branch: SessionEntry[], settlementId: string): boolean {
  return branch.some((entry) => entry.type === "custom" && entry.customType === ACCESS_NOTICE
    && typeof entry.data === "object" && entry.data !== null && "settlementId" in entry.data
    && entry.data.settlementId === settlementId);
}

/** Settle only the current branch since its latest persisted settlement. */
export function settleAccesses(
  branch: SessionEntry[], resolvePath: (path: string) => string,
  eligible: (path: string) => boolean, capacity = ACTIVE_CAPACITY,
  protectedPaths: ReadonlySet<string> = new Set(),
): AccessState {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Active skill capacity must be a positive safe integer.");
  let state: SkillLruState = { active: [], pendingEviction: [] };
  let boundary = -1;
  let announced = new Set<string>();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "custom" && entry.customType === ACCESS_STATE) {
      state = restore(entry.data);
      boundary = i;
      for (const notice of branch.slice(i + 1)) {
        if (notice.type !== "custom" || notice.customType !== ACCESS_NOTICE) continue;
        const data = notice.data as { settlementId?: unknown; paths?: unknown } | undefined;
        if (data?.settlementId === entry.id && Array.isArray(data.paths)) {
          for (const path of data.paths) if (typeof path === "string") announced.add(path);
        }
      }
      break;
    }
  }
  const calls = new Map<string, { name: string; path: string }>();
  const accesses = new Map<string, boolean>();
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i]!;
    if (i > boundary && entry.type === "custom" && entry.customType === MANUAL_SELECTION) {
      const data = entry.data as ManualSelection;
      for (const [paths, selected] of [[data.add, true], [data.remove, false]] as const) {
        for (const path of paths) { accesses.delete(path); accesses.set(path, selected); }
      }
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        calls.delete(block.id);
        if (["read", "write", "edit"].includes(block.name) && typeof block.arguments.path === "string") {
          calls.set(block.id, { name: block.name, path: resolvePath(block.arguments.path) });
        }
      }
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      calls.delete(message.toolCallId);
      if (i <= boundary || message.isError || !call || call.name !== message.toolName) continue;
      // Reinsertion sorts distinct skills by their final successful access.
      accesses.delete(call.path);
      accesses.set(call.path, true);
    }
  }
  state = { active: state.active.filter(eligible), pendingEviction: state.pendingEviction.filter(eligible) };
  for (const [path, selected] of accesses) {
    if (!selected) state = { active: state.active.filter((item) => item !== path), pendingEviction: state.pendingEviction.filter((item) => item !== path) };
    else if (eligible(path)) state = accessSkillState(state, path, capacity, protectedPaths);
  }
  // Only previously announced, unaccessed candidates expire. New overflow gets
  // its own notice interval, even if an accessed candidate overflows again.
  const overflow = state.active.filter((path, index) => index >= capacity && !protectedPaths.has(path));
  return { version: 1, active: state.active.filter((path) => !overflow.includes(path)),
    pendingEviction: [...state.pendingEviction.filter((path) => !announced.has(path) || accesses.has(path)), ...overflow] };
}
