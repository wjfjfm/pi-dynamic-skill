import type { ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ContextMessage = ContextEvent["messages"][number];
export const DYNAMIC_CONTEXT = "dynamic-skill:context";

export interface PreparedSkills {
  /** Native custom messages to enqueue after committing the settlement. */
  messages: ContextMessage[];
  /** Synchronous, idempotent persistence. No effect before this call. */
  commit(): void;
}
export interface SkillContextService {
  additions(ctx: ExtensionContext): ContextMessage[];
  reconcile(ctx: ExtensionContext): void;
  settle(ctx: ExtensionContext, full: boolean, transactionId?: string): void;
  prepare(ctx: ExtensionContext, retained: ContextMessage[], transactionId: string, full: boolean): PreparedSkills;
  shown(ctx: ExtensionContext, messages: ContextMessage[]): void;
  /** Idempotent for the current native compaction entry, in either hook order. */
  compact(ctx: ExtensionContext): void;
}
export interface SkillContextDetails {
  id: string;
  paths: string[];
  pendingPaths: string[];
  settlementId?: string;
}
export function skillDetails(message: ContextMessage): SkillContextDetails | undefined {
  if (message.role !== "custom" || message.customType !== DYNAMIC_CONTEXT) return;
  const data = message.details as Partial<SkillContextDetails> | undefined;
  if (typeof data?.id !== "string" || !Array.isArray(data.paths) || !Array.isArray(data.pendingPaths)) return;
  return data as SkillContextDetails;
}
export function visibleSkills(messages: readonly ContextMessage[]): Set<string> {
  return new Set(messages.flatMap((message) => skillDetails(message)?.paths ?? []));
}
