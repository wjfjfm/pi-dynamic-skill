import { createHash } from "node:crypto";
import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { skillDetails, type ContextMessage } from "./context.js";

/** Persist descriptions once, not a copy of the request that made them visible. */
export interface DescriptionBlock {
  /** Null records delivery without authorizing replay at a guessed position. */
  anchor: string | null;
  /** Public session entry identity, when the anchor comes from raw context. */
  source?: string;
  message: ContextMessage;
}

/** Custom timestamps change on disk round trips; they are not message identity. */
export function anchorKey(message: ContextMessage): string {
  const value = message.role === "custom"
    ? { role: message.role, customType: message.customType, content: message.content,
      display: message.display, details: message.details }
    : message;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Request-local provenance; null means multiple raw entries could be the source. */
export function anchorSources(entries: readonly SessionEntry[]): Map<string, string | null> {
  const sources = new Map<string, string | null>();
  for (const entry of entries) for (const message of sessionEntryToContextMessages(entry)) {
    const key = anchorKey(message);
    sources.set(key, sources.has(key) ? null : entry.id);
  }
  return sources;
}

/**
 * Refuse ambiguous anchors rather than attach a removed description to an
 * identical surviving message. The caller can rebuild missing live skills.
 */
export function descriptionBlock(messages: readonly ContextMessage[], message: ContextMessage,
  sources?: ReadonlyMap<string, string | null>): DescriptionBlock {
  const tail = messages.at(-1);
  const key = tail ? anchorKey(tail) : null;
  const source = key === null ? undefined : sources?.get(key);
  const anchor = key !== null && source !== null && messages.filter(item => anchorKey(item) === key).length === 1 ? key : null;
  return { anchor, ...(anchor !== null && source ? { source } : {}), message: structuredClone(message) };
}

/** Replay in creation order: a later block may be anchored to an earlier one. */
export function projectDescriptions(input: readonly ContextMessage[], blocks: readonly DescriptionBlock[],
  sources?: ReadonlyMap<string, string | null>): ContextMessage[] {
  const messages = [...input];
  const visible = new Set(messages.flatMap(message => skillDetails(message)?.id ?? []));
  const preceding = new Set<string>();
  for (const block of blocks) {
    const id = skillDetails(block.message)?.id;
    if (!id) continue;
    if (visible.has(id)) { preceding.add(id); continue; }
    if (block.anchor === null || sources?.get(block.anchor) === null) continue;
    if (block.source && sources?.get(block.anchor) !== block.source) continue;
    const matches = messages.flatMap((message, index) => anchorKey(message) === block.anchor ? [index] : []);
    const at = matches[0];
    if (matches.length !== 1 || at === undefined) continue;
    // Shared anchors must not reverse creation order. Advance only over known
    // earlier descriptions, including their dependent blocks, never task text.
    let insertion = at + 1;
    while (insertion < messages.length) {
      const next = skillDetails(messages[insertion]!)?.id;
      if (!next || !preceding.has(next)) break;
      insertion++;
    }
    messages.splice(insertion, 0, structuredClone(block.message));
    visible.add(id);
    preceding.add(id);
  }
  return messages;
}
