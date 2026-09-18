import { createHash } from "node:crypto";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ContextMessage = ContextEvent["messages"][number];
export const DYNAMIC_CONTEXT = "dynamic-skill:context";
export const SERVICE_CHANNEL = "dynamic-skill:context-service:v1";
export const OWNER_CHANNEL = "pi:context-owner:v1";

export interface PreparedSkills {
  /** Immutable blocks to append after the retained prefix. */
  messages: ContextMessage[];
  /** Synchronous, idempotent persistence. No effect before this call. */
  commit(): void;
}
export interface SkillContextService {
  project(ctx: ExtensionContext, messages: ContextMessage[]): ContextMessage[];
  prepare(ctx: ExtensionContext, retained: ContextMessage[], transactionId: string, full: boolean): PreparedSkills;
  shown(ctx: ExtensionContext, messages: ContextMessage[]): void;
  /** Idempotent for the current native compaction entry, in either hook order. */
  compact(ctx: ExtensionContext): void;
}
export interface ContextOwner {
  /** Current effective view without allocating checkpoints or generating a response. */
  current(ctx: ExtensionContext): ContextMessage[];
}

/** Request/reply is synchronous; the bus only discovers an explicitly versioned service.
 * Async operations must never be hidden inside an EventBus callback (Pi swallows errors).
 */
export function skillContextService(pi: Pick<ExtensionAPI, "events">): SkillContextService | undefined {
  let service: SkillContextService | undefined;
  pi.events?.emit(SERVICE_CHANNEL, { accept(value: SkillContextService) { service = value; } });
  return service;
}
export function contextOwner(pi: Pick<ExtensionAPI, "events">): ContextOwner | undefined {
  let owner: ContextOwner | undefined;
  pi.events?.emit(OWNER_CHANNEL, { accept(value: ContextOwner) { owner = value; } });
  return owner;
}
export function messageKey(message: ContextMessage): string {
  // Pi persists custom messages with the entry timestamp, not their original
  // in-memory timestamp. Compare their semantic fields in canonical order so
  // reload/compaction does not falsely report a rewritten prefix or lose anchors.
  const value = message.role === "custom" ? { role: message.role, customType: message.customType,
    content: message.content, display: message.display, details: message.details } : message;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
