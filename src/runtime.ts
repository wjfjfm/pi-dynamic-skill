import { randomUUID } from "node:crypto";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ACCESS_NOTICE, ACCESS_STATE, latestAccessState, settleAccesses } from "./access.js";
import { formatDynamicSkills } from "./prompt.js";
import { isManagedSkill, listTopLevelSkills } from "./tree.js";
import { contextOwner, DYNAMIC_CONTEXT, messageKey, SERVICE_CHANNEL, skillDetails, visibleSkills,
  type ContextMessage, type PreparedSkills, type SkillContextService } from "./context.js";

const PROJECTION = "dynamic-skill:projection:v1";
const TRANSACTION = "dynamic-skill:transaction:v1";
interface Block { anchor: string | null; before: boolean; message: ContextMessage }
interface Projection { version: 1; base: string | null; blocks: Block[] }
function base(branch: SessionEntry[]): string | null {
  return branch.findLast((entry) => entry.type === "compaction")?.id ?? null;
}
function projection(branch: SessionEntry[]): Projection {
  const entry = branch.findLast((item) => item.type === "custom" && item.customType === PROJECTION);
  const data = entry?.type === "custom" ? entry.data as Projection : undefined;
  return data?.version === 1 && data.base === base(branch) ? structuredClone(data) : { version: 1, base: base(branch), blocks: [] };
}

export function createSkillContextRuntime(pi: ExtensionAPI, options: {
  roots(): string[]; capacity(): number; resolvePath(path: string, cwd: string): string;
  refresh(ctx: ExtensionContext, roots: string[]): void;
}): SkillContextService & { settle(ctx: ExtensionContext, full: boolean): void } {
  const save = (value: Projection) => pi.appendEntry(PROJECTION, value);
  const makeMessage = (state: { active: readonly string[]; pendingEviction: readonly string[] },
    roots: string[], visible: Set<string>, full: boolean, id: string, settlementId?: string): ContextMessage[] => {
    const result = formatDynamicSkills(state, roots, options.capacity(), visible, full);
    if (!result.content) return [];
    return [{ role: "custom", customType: DYNAMIC_CONTEXT, content: result.content, display: false, timestamp: 0,
      details: { id, paths: result.paths, pendingPaths: result.pendingPaths, ...(settlementId ? { settlementId } : {}) } }];
  };
  const apply = (messages: ContextMessage[], value: Projection) => {
    const result = [...messages];
    for (const block of value.blocks) {
      const id = skillDetails(block.message)?.id;
      if (result.some((message) => skillDetails(message)?.id === id)) continue;
      let index = block.anchor === null ? 0 : result.findIndex((message) => messageKey(message) === block.anchor);
      // Never migrate a block whose anchor has been removed by a context transformation.
      if (index !== -1) {
        if (!block.before) { index++; while (index < result.length && skillDetails(result[index]!)) index++; }
        result.splice(index, 0, block.message);
      }
    }
    return result;
  };
  const service: SkillContextService & { settle(ctx: ExtensionContext, full: boolean): void } = {
    project(ctx, messages) {
      if (!messages.length) return [];
      const branch = ctx.sessionManager.getBranch();
      const value = projection(branch);
      if (!value.blocks.length && !messages.some((m) => skillDetails(m))) {
        const snapshot = latestAccessState(branch);
        const block = makeMessage(snapshot?.state ?? { active: [], pendingEviction: [] }, options.roots(), new Set(), true,
          randomUUID(), snapshot?.id)[0]!;
        const user = messages.find((m) => m.role === "user");
        value.blocks.push({ anchor: user ? messageKey(user) : messages.length ? messageKey(messages[messages.length - 1]!) : null,
          before: !!user || !messages.length, message: block });
        save(value);
      }
      return apply(messages, value);
    },
    prepare(ctx, retained, transactionId, full) {
      const branch = ctx.sessionManager.getBranch();
      const existing = branch.findLast((e) => e.type === "custom" && e.customType === TRANSACTION
        && (e.data as { id?: string })?.id === transactionId);
      if (existing?.type === "custom") return { messages: structuredClone((existing.data as { messages: ContextMessage[] }).messages), commit() {} };
      const roots = options.roots();
      options.refresh(ctx, roots);
      const visible = full ? new Set<string>() : visibleSkills(retained);
      const pinned = new Set([...roots, ...listTopLevelSkills(roots)]);
      const state = settleAccesses(branch, (path) => options.resolvePath(path, ctx.cwd),
        (path) => !pinned.has(path) && isManagedSkill(roots, path), options.capacity(), visible);
      const messages = makeMessage(state, roots, visible, full, transactionId);
      let committed = false;
      const prepared: PreparedSkills = { messages, commit() {
        if (committed) return;
        pi.appendEntry(ACCESS_STATE, state);
        const stateId = latestAccessState(ctx.sessionManager.getBranch())?.id;
        for (const message of messages) {
          const details = skillDetails(message);
          if (details && stateId) details.settlementId = stateId;
        }
        // A full rebuild replaces the directory, including overlays whose anchors
        // (notably checkpoint 0 after compact) survive in the retained prefix.
        // Persist this inside the transaction so a duplicate compact hook cannot
        // clear a fresh projection created by the first hook.
        if (full) save({ version: 1, base: base(branch), blocks: [] });
        pi.appendEntry(TRANSACTION, { id: transactionId, messages });
        committed = true;
      } };
      return prepared;
    },
    shown(ctx, messages) {
      for (const message of messages) {
        const details = skillDetails(message);
        if (!details?.settlementId || !details.pendingPaths.length) continue;
        const branch = ctx.sessionManager.getBranch();
        const announced = new Set(branch.flatMap((entry) => entry.type === "custom" && entry.customType === ACCESS_NOTICE
          && (entry.data as { settlementId?: string })?.settlementId === details.settlementId
          ? (entry.data as { paths: string[] }).paths : []));
        const paths = details.pendingPaths.filter((path) => !announced.has(path));
        if (paths.length) pi.appendEntry(ACCESS_NOTICE, { settlementId: details.settlementId, paths });
      }
    },
    compact(ctx) { service.settle(ctx, true); },
    settle(ctx, full) {
      const raw = buildSessionContext(ctx.sessionManager.getBranch()).messages;
      const owner = contextOwner(pi);
      const retained = full ? [] : owner ? owner.current(ctx) : service.project(ctx, raw);
      const compactId = full ? base(ctx.sessionManager.getBranch()) : null;
      const prepared = service.prepare(ctx, retained, compactId ? `compact:${compactId}` : randomUUID(), full || !retained.some((m) => skillDetails(m)));
      prepared.commit();
      // Full rebuild already reset the overlay in commit; the next context pass
      // materializes it. Repeated compact notifications must not reset it again.
      if (full || !retained.length) return;
      const value = projection(ctx.sessionManager.getBranch());
      // The raw tail may have been folded away or excluded (e.g. an aborted
      // continuation). Append to the effective prefix, not an invisible node.
      const anchor = messageKey(retained[retained.length - 1]!);
      for (const message of prepared.messages) value.blocks.push({ anchor, before: false, message });
      save(value);
    },
  };
  const unsubscribe = pi.events?.on(SERVICE_CHANNEL, (request) => {
    const value = request as { accept?: (service: SkillContextService) => void } | undefined;
    value?.accept?.(service);
  });
  pi.on?.("session_shutdown", () => { unsubscribe?.(); });
  return service;
}
