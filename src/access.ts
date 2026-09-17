import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { accessSkillState, type SkillLruState } from "./lru.js";

export const ACCESS_STATE = "dynamic-skill:access-state";
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

/** Settle only the current branch since its latest persisted settlement. */
export function settleAccesses(
  branch: SessionEntry[], resolvePath: (path: string) => string,
  eligible: (path: string) => boolean, capacity = ACTIVE_CAPACITY,
): AccessState {
  let state: SkillLruState = { active: [], pendingEviction: [] };
  let boundary = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "custom" && entry.customType === ACCESS_STATE) {
      state = restore(entry.data);
      boundary = i;
      break;
    }
  }
  const calls = new Map<string, { name: string; path: string }>();
  const accesses = new Map<string, true>();
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i]!;
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
  for (const path of accesses.keys()) {
    if (eligible(path)) state = accessSkillState(state, path, capacity);
  }
  // Expiration is deferred until the notice/context presentation is connected.
  return { version: 1, ...state };
}
