import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { AppError } from "../errors.js";
import type { DrizzleDb } from "./client.js";
import { prompts } from "./schema.js";

/**
 * The prompt library (D6): short saved bodies a user inserts into the composer.
 *
 * Search is SQL, not JavaScript. A LIKE over `title` and `body` is enough for a
 * table of this size, and it keeps the contract honest: `total` is the count of rows
 * that matched, not the length of a page the renderer then filtered. FTS5 is the
 * obvious upgrade once a library is large enough to deserve `bm25`; it needs its own
 * virtual table and three triggers, which is why it is in BACKLOG.md rather than here.
 *
 * Rows are returned in the contract's shape, so the handler is a pass-through.
 */

export interface PromptRow {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

const PROMPT_COLUMNS = {
  id: prompts.id,
  title: prompts.title,
  body: prompts.body,
  createdAt: prompts.createdAt,
  updatedAt: prompts.updatedAt,
} as const;

export interface CreatePromptInput {
  title: string;
  body: string;
}

export function createPrompt(db: DrizzleDb, input: CreatePromptInput): PromptRow {
  const id = randomUUID();
  const now = new Date().toISOString();

  const row = db
    .insert(prompts)
    .values({ id, title: input.title, body: input.body, createdAt: now, updatedAt: now })
    .returning(PROMPT_COLUMNS)
    .get();

  if (row === undefined) {
    throw new AppError("INTERNAL", "the prompt was not written", { details: { id } });
  }
  return row;
}

export interface UpdatePromptInput {
  promptId: string;
  title?: string | undefined;
  body?: string | undefined;
}

export function updatePrompt(db: DrizzleDb, input: UpdatePromptInput): PromptRow {
  const patch: Partial<Pick<PromptRow, "title" | "body">> & { updatedAt: string } = {
    updatedAt: new Date().toISOString(),
  };
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;

  const row = db
    .update(prompts)
    .set(patch)
    .where(eq(prompts.id, input.promptId))
    .returning(PROMPT_COLUMNS)
    .get();

  if (row === undefined) {
    throw new AppError("NOT_FOUND", "prompt not found", { details: { promptId: input.promptId } });
  }
  return row;
}

export function deletePrompt(db: DrizzleDb, promptId: string): void {
  const deleted = db
    .delete(prompts)
    .where(eq(prompts.id, promptId))
    .returning({ id: prompts.id })
    .all();

  if (deleted.length === 0) {
    throw new AppError("NOT_FOUND", "prompt not found", { details: { promptId } });
  }
}

export interface ListPromptsInput {
  /** Whitespace-separated terms; every one must match title or body. */
  query?: string | undefined;
  limit: number;
  offset: number;
}

/**
 * Escapes the LIKE wildcards so a user searching for `50%` finds the prompt that says
 * "50%" instead of every prompt. The backslash is the escape character declared with
 * `ESCAPE '\'` in the predicate, and it has to be escaped first or it would eat the
 * backslashes this function adds.
 */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

function searchPredicate(term: string): ReturnType<typeof or> {
  const pattern = likePattern(term);
  return or(
    sql`lower(${prompts.title}) LIKE lower(${pattern}) ESCAPE '\\'`,
    sql`lower(${prompts.body}) LIKE lower(${pattern}) ESCAPE '\\'`,
  );
}

/**
 * One page of the library, plus the total it was cut from.
 *
 * Tokens are joined with AND: a second word narrows the result rather than widening it,
 * which is what a search box is expected to do. An empty query is the whole library —
 * the branch is in the predicate builder, not in a JS filter after the read.
 */
export function listPrompts(
  db: DrizzleDb,
  input: ListPromptsInput,
): { items: PromptRow[]; total: number } {
  const terms = (input.query ?? "")
    .trim()
    .split(/\s+/)
    .filter((term) => term !== "");

  const where = terms.length === 0 ? undefined : and(...terms.map((term) => searchPredicate(term)));

  const items = db
    .select(PROMPT_COLUMNS)
    .from(prompts)
    .where(where)
    .orderBy(desc(prompts.updatedAt), asc(prompts.id))
    .limit(input.limit)
    .offset(input.offset)
    .all();

  const counted = db.select({ n: sql<number>`COUNT(*)` }).from(prompts).where(where).get();

  return { items, total: counted?.n ?? 0 };
}
