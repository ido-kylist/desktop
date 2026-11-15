import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { AppError } from "../errors.js";
import type { DrizzleDb } from "./client.js";
import { assistants } from "./schema.js";

/**
 * Assistants: a saved send configuration (D6).
 *
 * A row is a model, a temperature, and the system prompt that goes in front of the
 * conversation. Applying one is `GenerationService`'s job — this module only stores
 * them, and reads one back by id when a turn asks for it.
 *
 * `delete` archives. Threads carry the id of the assistant they were last sent with,
 * and a hard delete would leave that pointer dangling; an archived assistant can still
 * be resolved by `getAssistant`, and simply stops being offered in the picker.
 */

export interface AssistantRow {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

const ASSISTANT_COLUMNS = {
  id: assistants.id,
  name: assistants.name,
  model: assistants.model,
  systemPrompt: assistants.systemPrompt,
  temperature: assistants.temperature,
  createdAt: assistants.createdAt,
  updatedAt: assistants.updatedAt,
  archivedAt: assistants.archivedAt,
} as const;

export interface CreateAssistantInput {
  name: string;
  model: string;
  systemPrompt: string;
  temperature: number;
}

export function createAssistant(db: DrizzleDb, input: CreateAssistantInput): AssistantRow {
  const id = randomUUID();
  const now = new Date().toISOString();

  const row = db
    .insert(assistants)
    .values({
      id,
      name: input.name,
      model: input.model,
      systemPrompt: input.systemPrompt,
      temperature: input.temperature,
      createdAt: now,
      updatedAt: now,
    })
    .returning(ASSISTANT_COLUMNS)
    .get();

  if (row === undefined) {
    throw new AppError("INTERNAL", "the assistant was not written", { details: { id } });
  }
  return row;
}

/**
 * The picker's read. Archived rows are included only on request, and ordered by name
 * so the menu does not reshuffle when one of them is edited.
 */
export function listAssistants(
  db: DrizzleDb,
  input: { includeArchived: boolean },
): { items: AssistantRow[]; total: number } {
  const rows = db
    .select(ASSISTANT_COLUMNS)
    .from(assistants)
    .where(input.includeArchived ? undefined : isNull(assistants.archivedAt))
    .orderBy(asc(assistants.name))
    .all();

  return { items: rows, total: rows.length };
}

export interface UpdateAssistantInput {
  assistantId: string;
  name?: string | undefined;
  model?: string | undefined;
  systemPrompt?: string | undefined;
  temperature?: number | undefined;
  archived?: boolean | undefined;
}

/**
 * The editable fields, each independent. Returns the stored row so the caller can
 * show what the database actually holds — a temperature of `0` is a real value and
 * must not be mistaken for "absent" on the way back.
 */
export function updateAssistant(db: DrizzleDb, input: UpdateAssistantInput): AssistantRow {
  const patch: Partial<Pick<AssistantRow, "name" | "model" | "systemPrompt" | "temperature">> & {
    updatedAt: string;
    archivedAt?: string | null;
  } = { updatedAt: new Date().toISOString() };

  if (input.name !== undefined) patch.name = input.name;
  if (input.model !== undefined) patch.model = input.model;
  if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
  if (input.temperature !== undefined) patch.temperature = input.temperature;
  if (input.archived !== undefined) {
    patch.archivedAt = input.archived ? new Date().toISOString() : null;
  }

  const row = db
    .update(assistants)
    .set(patch)
    .where(eq(assistants.id, input.assistantId))
    .returning(ASSISTANT_COLUMNS)
    .get();

  if (row === undefined) {
    throw new AppError("NOT_FOUND", "assistant not found", {
      details: { assistantId: input.assistantId },
    });
  }
  return row;
}

/**
 * Archives. A second call is NOT_FOUND rather than a silent success, exactly as
 * `threads.delete` behaves: the caller asked to remove something that is already gone.
 */
export function archiveAssistant(db: DrizzleDb, assistantId: string): void {
  const archived = db
    .update(assistants)
    .set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(and(eq(assistants.id, assistantId), isNull(assistants.archivedAt)))
    .returning({ id: assistants.id })
    .all();

  if (archived.length === 0) {
    throw new AppError("NOT_FOUND", "assistant not found", { details: { assistantId } });
  }
}

/**
 * One assistant, archived or not.
 *
 * Archived is deliberately allowed here: a thread that was sent with this assistant
 * re-reads it on regeneration, and refusing because the assistant was later put away
 * would turn "regenerate my answer" into an error about a menu entry.
 */
export function getAssistant(db: DrizzleDb, assistantId: string): AssistantRow | null {
  const row = db
    .select(ASSISTANT_COLUMNS)
    .from(assistants)
    .where(eq(assistants.id, assistantId))
    .get();
  return row ?? null;
}
