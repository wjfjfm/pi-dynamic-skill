import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { SessionManager, formatSkillsForPrompt, type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import { ACCESS_STATE, MANUAL_SELECTION, latestAccessState, type AccessState, type ManualSelection } from "./access.js";
import { accessSkillState } from "./lru.js";
import { formatDynamicSkills } from "./prompt.js";
import { isManagedSkill, type SkillNode } from "./tree.js";
import { DYNAMIC_CONTEXT, skillDetails, visibleSkills, type ContextMessage, type SkillContextService } from "./context.js";

export const DISCOVERY_DETAILS = "dynamicSkillChildren";
export interface DiscoverySnapshot { parent: string; children: SkillNode[] }
export function discoverySnapshot(details: unknown): DiscoverySnapshot | undefined {
  const value = (details as Record<string, unknown> | undefined)?.[DISCOVERY_DETAILS] as DiscoverySnapshot | undefined;
  if (!value || typeof value.parent !== "string" || !Array.isArray(value.children)
    || !value.children.every((child) => child && typeof child.filePath === "string" && typeof child.name === "string" && typeof child.description === "string")) return;
  return value;
}

/** A continuous session queue; native messages alone establish description visibility. */
export function createSkillContextRuntime(pi: ExtensionAPI, options: {
  roots(): string[]; capacity(): number; resolvePath(path: string, cwd: string): string;
}): SkillContextService {
  let state: AccessState | undefined;
  let session: string | undefined;
  const entries = (ctx: ExtensionContext) => ctx.sessionManager.getEntries();
  const current = (ctx: ExtensionContext) => (ctx.sessionManager as typeof ctx.sessionManager & {
    buildSessionContext(): { messages: ContextMessage[] };
  }).buildSessionContext().messages;
  const restore = (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    const history = entries(ctx);
    if (!state) {
      const saved = latestAccessState(history);
      state = saved ? { ...saved.state, cursor: saved.state.cursor ?? saved.id } : { version: 1, active: [], pendingEviction: [] };
    } else if (session !== id) {
      // Fork copies history, not queue time. Do not replay its historical tools.
      state = { ...state, cursor: history.at(-1)?.id };
    }
    session = id;
    return state!;
  };
  const persist = (ctx: ExtensionContext, next: AccessState) => {
    if (JSON.stringify(state) !== JSON.stringify(next)) {
      pi.appendEntry(ACCESS_STATE, next);
      state = next;
    }
  };
  const coordinate = (ctx: ExtensionContext, retained: ContextMessage[], cycle?: string) => {
    const previous = restore(ctx);
    const history = entries(ctx);
    const visible = visibleSkills(retained);
    const roots = options.roots();
    const eligible = (path: string) => !roots.includes(path) && isManagedSkill(roots, path);
    // An undelivered discovery survives a failed send. Once delivered, it lives
    // only as long as its description is visible; old reads cannot resurrect it.
    const delivered = (item: NonNullable<AccessState["discovery"]>[number]) => {
      if (item.visibleAtAdmission) return true;
      const source = history.findIndex((entry) => entry.id === item.source);
      if (source < 0) return true;
      return history.slice(source + 1).some((entry) => entry.type === "custom_message"
        && entry.customType === DYNAMIC_CONTEXT
        && (entry.details as { paths?: string[] } | undefined)?.paths?.includes(item.path));
    };
    let next: AccessState = { ...previous, active: previous.active.filter(eligible), pendingEviction: previous.pendingEviction.filter(eligible),
      discovery: (previous.discovery ?? []).filter((item) => eligible(item.path) && (visible.has(item.path) || !delivered(item))),
      announced: [...previous.announced ?? []], pendingTokens: { ...previous.pendingTokens } };
    const boundary = previous.cursor ? history.findIndex((entry) => entry.id === previous.cursor) : -1;
    const calls = new Map<string, { name: string; path: string }>();
    const accesses = new Map<string, boolean>();
    const discoveries: { path: string; source: string }[] = [];
    let cursor = previous.cursor;
    for (const [index, entry] of history.entries()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        for (const block of entry.message.content) if (block.type === "toolCall") {
          calls.delete(block.id);
          if (["read", "write", "edit"].includes(block.name) && typeof block.arguments.path === "string") calls.set(block.id, { name: block.name, path: options.resolvePath(block.arguments.path, ctx.cwd) });
        }
      }
      if (index <= boundary) continue;
      if (entry.type === "custom" && entry.customType === MANUAL_SELECTION) {
        const data = entry.data as ManualSelection;
        for (const [paths, selected] of [[data.add, true], [data.remove, false]] as const) for (const path of paths) {
          accesses.delete(path); accesses.set(path, selected);
        }
        cursor = entry.id;
      }
      if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
      const message = entry.message;
      const call = calls.get(message.toolCallId);
      calls.delete(message.toolCallId);
      if (!call) continue;
      cursor = entry.id; // Including failed/empty discoveries: never replay a source.
      if (message.isError || call.name !== message.toolName) continue;
      accesses.delete(call.path); accesses.set(call.path, true);
      if (call.name !== "read" || !isManagedSkill(roots, call.path)) continue;
      const snapshot = discoverySnapshot(message.details);
      if (snapshot?.parent !== call.path) continue;
      for (const child of snapshot.children) if (!child.disableModelInvocation && eligible(child.filePath)) discoveries.push({ path: child.filePath, source: entry.id });
    }
    for (const [path, selected] of accesses) {
      next.discovery = next.discovery!.filter((item) => item.path !== path);
      next.announced = next.announced!.filter((item) => item !== path);
      delete next.pendingTokens![path];
      if (!selected) next = { ...next, active: next.active.filter((item) => item !== path), pendingEviction: next.pendingEviction.filter((item) => item !== path) };
      else if (eligible(path)) next = { ...next, ...accessSkillState(next, path, options.capacity(), visible) };
    }
    if (cycle && cycle !== previous.cycle) {
      next.pendingEviction = next.pendingEviction.filter((path) => !next.announced!.includes(path));
    }
    const overflow = next.active.filter((path, index) => index >= options.capacity() && !visible.has(path));
    next.active = next.active.filter((path) => !overflow.includes(path));
    next.pendingEviction = [...next.pendingEviction, ...overflow];
    if (cycle && (previous.pendingEviction.length || next.pendingEviction.length)) next.cycle = cycle;
    next.announced = next.announced!.filter((path) => next.pendingEviction.includes(path));
    next.pendingTokens = Object.fromEntries(next.pendingEviction.map((path) => [path, next.pendingTokens![path] ?? randomUUID()]));
    for (const item of discoveries) {
      if (accesses.has(item.path) || next.active.includes(item.path) || next.pendingEviction.includes(item.path) || next.discovery!.some((old) => old.path === item.path)) continue;
      next.discovery!.push(visible.has(item.path) ? { ...item, visibleAtAdmission: true } : item);
    }
    next.cursor = cursor;
    return next;
  };
  const makeMessage = (ctx: ExtensionContext, next: AccessState, retained: ContextMessage[], id: string) => {
    const visible = visibleSkills(retained);
    const announced = new Set(retained.flatMap((message) => skillDetails(message)?.pendingPaths.filter((path) =>
      (skillDetails(message)?.pendingTokens ?? {})[path] === next.pendingTokens?.[path]) ?? []));
    const full = !retained.some((message) => skillDetails(message));
    const result = formatDynamicSkills(next, options.roots(), options.capacity(), visible, full, announced);
    const history = entries(ctx);
    const discovered: Skill[] = (next.discovery ?? []).flatMap((item) => {
      if (visible.has(item.path) || result.paths.includes(item.path)) return [];
      const source = history.find((entry) => entry.id === item.source);
      const child = source?.type === "message" && source.message.role === "toolResult"
        ? discoverySnapshot(source.message.details)?.children.find((node) => node.filePath === item.path) : undefined;
      return child ? [{ ...child, baseDir: dirname(child.filePath), source: "dynamic-skill",
        sourceInfo: { path: child.filePath, source: "dynamic-skill", scope: "temporary", origin: "top-level" } }] : [];
    });
    if (discovered.length) {
      const xml = formatSkillsForPrompt(discovered);
      result.content += `${result.content ? "\n\n" : ""}### Discovered skills\n\n${xml.slice(xml.indexOf("<available_skills>"))}`;
      result.paths.push(...discovered.map((skill) => skill.filePath));
    }
    if (!result.content) return [];
    return [{ role: "custom" as const, customType: DYNAMIC_CONTEXT, content: result.content, display: false, timestamp: 0,
      details: { id, paths: result.paths, pendingPaths: result.pendingPaths, pendingTokens: next.pendingTokens } }];
  };
  const send = (messages: ContextMessage[]) => {
    for (const message of messages) if (message.role === "custom") pi.sendMessage(message, { triggerTurn: false });
  };
  const service: SkillContextService = {
    start(ctx, reason, previousSessionFile) {
      if (reason === "new" || reason === "resume") { state = undefined; session = undefined; }
      if (reason === "fork") {
        const inherited = previousSessionFile
          ? latestAccessState(SessionManager.open(previousSessionFile).getEntries())?.state : state;
        if (inherited) {
          state = undefined;
          restore(ctx);
          persist(ctx, { ...inherited, cursor: entries(ctx).at(-1)?.id });
        }
        // Resources are discovered after session_start. Reconcile at the next
        // normal entry point, once roots are registered, not against an empty tree.
      }
    },
    state(ctx) { return restore(ctx); },
    additions(ctx) {
      const retained = current(ctx);
      const next = coordinate(ctx, retained);
      persist(ctx, next);
      return makeMessage(ctx, next, retained, randomUUID());
    },
    reconcile(ctx) { send(service.additions(ctx)); },
    prepare(ctx, retained, transactionId, full) {
      const next = coordinate(ctx, retained, full ? transactionId : undefined);
      const messages = makeMessage(ctx, next, retained, transactionId);
      return { messages, commit() { persist(ctx, next); } };
    },
    shown(ctx, messages) {
      const previous = restore(ctx);
      const announced = new Set(previous.announced);
      for (const message of messages) {
        const details = skillDetails(message);
        for (const path of details?.pendingPaths ?? []) if (previous.pendingTokens?.[path]
          && previous.pendingTokens[path] === details?.pendingTokens?.[path]) announced.add(path);
      }
      if (announced.size !== (previous.announced ?? []).length) persist(ctx, { ...previous, announced: [...announced] });
    },
    compact(ctx) { service.settle(ctx, true); },
    settle(ctx, full, transactionId) {
      const compactId = full ? ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.id : undefined;
      const prepared = service.prepare(ctx, current(ctx), transactionId ?? (compactId ? `compact:${compactId}` : `reload:${ctx.sessionManager.getLeafId()}`), true);
      prepared.commit(); send(prepared.messages);
    },
  };
  return service;
}
