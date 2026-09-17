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
