/**
 * The tree maths behind the variant switcher.
 *
 * `chat.thread` returns a flat list plus `activeLeafId`; the transcript needs the one
 * path that leaf belongs to, and every message on that path needs to know its sibling
 * set so it can render "2 / 3" and aim its arrows at the right id.
 *
 * Pure on purpose: the store keeps a flat list, and the branch shape is derived here
 * rather than being carried around in state that could disagree with the server.
 */

export interface VariantMessage {
  id: string;
  /** Absent and null both mean "root of the thread". */
  parentId?: string | null;
  /**
   * Sibling ids sharing this message's parent. Where the server sends only the
   * active path, this is the only evidence that other variants exist.
   */
  variants?: string[];
}

export interface VariantGroup {
  /** Every id in the sibling set, in display order, including this message. */
  ids: string[];
  /** Position of the active message within `ids`. */
  index: number;
}

export interface ThreadView<M extends VariantMessage> {
  /** The messages on the active path, oldest first. */
  path: M[];
  /** Keyed by message id; only messages with at least one sibling appear. */
  groups: Record<string, VariantGroup>;
}

/** The key that groups root-level messages together. NUL cannot collide with a uuid. */
const ROOT = "\u0000root";

function parentKey(message: VariantMessage): string {
  return message.parentId ?? ROOT;
}

/**
 * The leaf to trace back from: the server's choice when it names one that exists,
 * otherwise the last leaf in list order (the list is oldest first, so that is the
 * newest branch).
 */
function resolveLeaf<M extends VariantMessage>(
  messages: readonly M[],
  byId: ReadonlyMap<string, M>,
  children: ReadonlyMap<string, readonly string[]>,
  activeLeafId: string | null | undefined,
): string | null {
  if (activeLeafId !== null && activeLeafId !== undefined && byId.has(activeLeafId)) {
    return activeLeafId;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate !== undefined && !children.has(candidate.id)) return candidate.id;
  }

  const last = messages[messages.length - 1];
  return last?.id ?? null;
}

/**
 * The sibling set as the UI should count it: siblings present in the list, plus any
 * id the message declares but the list omits, so `n / total` is not understated when
 * the server sends only the active path.
 */
function siblingIds(
  message: VariantMessage,
  children: ReadonlyMap<string, readonly string[]>,
): string[] {
  const ids = [...(children.get(parentKey(message)) ?? [message.id])];
  const seen = new Set(ids);

  const declared = message.variants ?? [];
  // The contract does not say whether `variants` includes the message itself; both
  // readings are accepted so a server that changes its mind cannot drop the arrows.
  const declaredIds = declared.includes(message.id) ? declared : [message.id, ...declared];

  for (const id of declaredIds) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

export function buildThreadView<M extends VariantMessage>(
  messages: readonly M[],
  activeLeafId?: string | null,
): ThreadView<M> {
  if (messages.length === 0) return { path: [], groups: {} };

  const byId = new Map<string, M>();
  for (const message of messages) {
    if (!byId.has(message.id)) byId.set(message.id, message);
  }

  const children = new Map<string, string[]>();
  for (const message of messages) {
    const key = parentKey(message);
    const siblings = children.get(key);
    if (siblings === undefined) children.set(key, [message.id]);
    else siblings.push(message.id);
  }

  const path: M[] = [];
  const visited = new Set<string>();
  let cursor = resolveLeaf(messages, byId, children, activeLeafId);

  // Walking up stops at a missing parent (a row whose ancestor was pruned) and at a
  // repeat (a malformed cycle), rather than looping forever.
  while (cursor !== null && !visited.has(cursor)) {
    const message = byId.get(cursor);
    if (message === undefined) break;
    visited.add(cursor);
    path.unshift(message);
    cursor = message.parentId ?? null;
  }

  const groups: Record<string, VariantGroup> = {};
  for (const message of path) {
    const ids = siblingIds(message, children);
    if (ids.length > 1) groups[message.id] = { ids, index: ids.indexOf(message.id) };
  }

  return { path, groups };
}
