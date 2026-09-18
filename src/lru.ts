/**
 * Binary-progressive LRU, ordered from most protected to first to evict.
 * Entries are unique skill file paths; callers supply normalized absolute paths.
 * Returns a new ordering without mutating the session's previous snapshot.
 */
export function accessSkill(order: readonly string[], filePath: string): string[] {
  const index = order.indexOf(filePath);
  const position = Math.floor((index === -1 ? order.length : index) / 2);
  const updated = [...order];
  if (index !== -1) updated.splice(index, 1);
  updated.splice(position, 0, filePath);
  return updated;
}

/** Disjoint collections: pending skills do not count toward active capacity. */
export interface SkillLruState {
  readonly active: readonly string[];
  readonly pendingEviction: readonly string[];
}

/**
 * Re-accessing a pending skill admits it as a new active entry, then removes
 * its pending notice. Overflow moves to pending, without deleting any files.
 * Pending entries retain their order; newly displaced entries are appended.
 */
export function accessSkillState(state: SkillLruState, filePath: string, capacity: number, protectedPaths: ReadonlySet<string> = new Set()): SkillLruState {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("Active skill capacity must be a positive safe integer.");
  }
  const active = accessSkill(state.active, filePath);
  const overflow = active.filter((path, index) => index >= capacity && !protectedPaths.has(path));
  const pendingEviction = state.pendingEviction.filter((path) => path !== filePath);
  return { active: active.filter((path) => !overflow.includes(path)), pendingEviction: [...pendingEviction, ...overflow] };
}
