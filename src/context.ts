import type { ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ContextMessage = ContextEvent["messages"][number];
export const DYNAMIC_CONTEXT = "dynamic-skill:context";

export interface SkillContextService {
  start(ctx: ExtensionContext, reason: string, previousSessionFile?: string): void;
  state(ctx: ExtensionContext): import("./access.js").AccessState;
  project(ctx: ExtensionContext, messages: ContextMessage[]): ContextMessage[];
  reconcile(ctx: ExtensionContext): void;
  settle(ctx: ExtensionContext, full: boolean): void;
}
export interface SkillContextDetails {
  id: string;
  paths: string[];
  pendingPaths: string[];
  settlementId?: string;
  pendingTokens?: Record<string, string>;
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
