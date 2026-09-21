import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCESS_NOTICE, ACCESS_STATE, latestAccessState, selectionState, settleAccesses } from "./access.js";
import { formatDynamicSkills } from "./prompt.js";
import { isManagedSkill } from "./tree.js";
import { DYNAMIC_CONTEXT, skillDetails, visibleSkills,
  type ContextMessage, type PreparedSkills, type SkillContextService } from "./context.js";

const TRANSACTION = "dynamic-skill:transaction:v2";

/** Native messages are the only loading ledger. Queue snapshots never imply visibility. */
export function createSkillContextRuntime(pi: ExtensionAPI, options: {
  roots(): string[]; capacity(): number; resolvePath(path: string, cwd: string): string;
  refresh(ctx: ExtensionContext, roots: string[]): void;
}): SkillContextService {
  // Invoke the running host's reducer, not a possibly older SDK copy bundled
  // with this extension. The experimental host exposes this existing read-only
  // method on ReadonlySessionManager; the published SDK type still omits it.
  const current = (ctx: ExtensionContext) => (ctx.sessionManager as typeof ctx.sessionManager & {
    buildSessionContext(): { messages: ContextMessage[] };
  }).buildSessionContext().messages;
  const makeMessage = (state: { active: readonly string[]; pendingEviction: readonly string[] },
    retained: ContextMessage[], id: string, settlementId?: string): ContextMessage[] => {
    const full = !retained.some((message) => skillDetails(message));
    const announced = new Set(retained.flatMap((message) => skillDetails(message)?.pendingPaths ?? []));
    const result = formatDynamicSkills(state, options.roots(), options.capacity(), visibleSkills(retained), full, announced);
    if (!result.content) return [];
    return [{ role: "custom", customType: DYNAMIC_CONTEXT, content: result.content, display: false, timestamp: 0,
      details: { id, paths: result.paths, pendingPaths: result.pendingPaths, ...(settlementId ? { settlementId } : {}) } }];
  };
  const send = (messages: ContextMessage[]) => {
    for (const message of messages) if (message.role === "custom") pi.sendMessage(message, { triggerTurn: false });
  };
  const service: SkillContextService = {
    additions(ctx) {
      const snapshot = latestAccessState(ctx.sessionManager.getBranch());
      return makeMessage(selectionState(ctx.sessionManager.getBranch()), current(ctx), randomUUID(), snapshot?.id);
    },
    reconcile(ctx) { send(service.additions(ctx)); },
    prepare(ctx, retained, transactionId, _full) {
      const branch = ctx.sessionManager.getBranch();
      const existing = branch.findLast((entry) => entry.type === "custom" && entry.customType === TRANSACTION
        && (entry.data as { id?: string })?.id === transactionId);
      if (existing) return { messages: [], commit() {} };
      options.refresh(ctx, options.roots());
      const roots = new Set(options.roots());
      const state = settleAccesses(branch, (path) => options.resolvePath(path, ctx.cwd),
        (path) => !roots.has(path) && isManagedSkill([...roots], path), options.capacity(), visibleSkills(retained));
      const messages = makeMessage(state, retained, transactionId);
      let committed = false;
      const prepared: PreparedSkills = { messages, commit() {
        if (committed) return;
        pi.appendEntry(ACCESS_STATE, state);
        const stateId = latestAccessState(ctx.sessionManager.getBranch())?.id;
        for (const message of messages) {
          const details = skillDetails(message);
          if (details && stateId) details.settlementId = stateId;
        }
        pi.appendEntry(TRANSACTION, { id: transactionId });
        committed = true;
      } };
      return prepared;
    },
    shown(ctx, messages) {
      for (const message of messages) {
        const details = skillDetails(message);
        if (!details?.settlementId || !details.pendingPaths.length) continue;
        const announced = new Set(ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === ACCESS_NOTICE
          && (entry.data as { settlementId?: string })?.settlementId === details.settlementId
          ? (entry.data as { paths: string[] }).paths : []));
        const paths = details.pendingPaths.filter((path) => !announced.has(path));
        if (paths.length) pi.appendEntry(ACCESS_NOTICE, { settlementId: details.settlementId, paths });
      }
    },
    compact(ctx) { service.settle(ctx, true); },
    settle(ctx, full, transactionId) {
      const branch = ctx.sessionManager.getBranch();
      const compactId = full ? branch.findLast((entry) => entry.type === "compaction")?.id : undefined;
      const prepared = service.prepare(ctx, current(ctx), transactionId ?? (compactId ? `compact:${compactId}` : randomUUID()), full);
      prepared.commit();
      send(prepared.messages);
    },
  };
  return service;
}
