import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { AppError } from "../errors.js";
import type { DrizzleDb } from "./client.js";
import { projects, threads } from "./schema.js";

/**
 * Projects: the folders the sidebar files threads under (D6).
 *
 * Archived, never deleted — the same trade `threads.deleted_at` makes, for the same
 * reason: a thread that was filed under a project keeps a name to fall back to, and
 * a project the user put away an hour ago is not a project they meant to destroy.
 *
 * Rows come back in the contract's shape (`camelCase`, `archivedAt` nullable) rather
 * than as raw table rows, so the handler stays a pass-through and there is exactly one
 * place where the column names and the wire names meet.
 */

export interface ProjectRow {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** A list row: the project, plus how many live threads are in it. */
export interface ProjectListItem extends ProjectRow {
  threadCount: number;
}

const PROJECT_COLUMNS = {
  id: projects.id,
  name: projects.name,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
  archivedAt: projects.archivedAt,
} as const;

/**
 * A name is trimmed by the contract; trimming again here costs nothing and keeps the
 * repository honest for a caller that is not the IPC boundary.
 */
function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new AppError("BAD_REQUEST", "a project needs a name");
  }
  return trimmed;
}

/**
 * Inserts and returns what was inserted. The row is read back rather than assembled
 * from the input, because the timestamps are the database's answer, not ours.
 */
export function createProject(db: DrizzleDb, name: string): ProjectRow {
  const id = randomUUID();
  const now = new Date().toISOString();

  const row = db
    .insert(projects)
    .values({ id, name: cleanName(name), createdAt: now, updatedAt: now })
    .returning(PROJECT_COLUMNS)
    .get();

  if (row === undefined) {
    throw new AppError("INTERNAL", "the project was not written", { details: { id } });
  }
  return row;
}

/**
 * Every live project, alphabetical, with its thread count.
 *
 * The counts are one grouped SQL aggregate over `threads` and a merge here, rather than a
 * correlated subquery in the select. Two reasons: the plan stays one scan instead of one
 * per project, and the correlated form is a trap in this codebase — drizzle renders a
 * bare column reference as `"id"`, which inside a subquery over `threads` resolves to
 * `threads.id` and silently counts zero. A GROUP BY has no such ambiguity.
 *
 * Deleted threads are excluded so the number matches the list the filter produces.
 */
export function listProjects(db: DrizzleDb): { items: ProjectListItem[]; total: number } {
  const counts = db
    .select({ projectId: threads.projectId, n: sql<number>`COUNT(*)` })
    .from(threads)
    .where(and(isNull(threads.deletedAt), isNotNull(threads.projectId)))
    .groupBy(threads.projectId)
    .all();

  const byProject = new Map<string, number>();
  for (const row of counts) {
    if (row.projectId !== null) byProject.set(row.projectId, row.n);
  }

  const items = db
    .select(PROJECT_COLUMNS)
    .from(projects)
    .where(isNull(projects.archivedAt))
    .orderBy(asc(projects.name))
    .all()
    .map((project) => ({ ...project, threadCount: byProject.get(project.id) ?? 0 }));

  return { items, total: items.length };
}

export interface UpdateProjectInput {
  projectId: string;
  name?: string | undefined;
  archived?: boolean | undefined;
}

/**
 * Renames and/or archives. Each field is independent and absent means "leave alone";
 * `updated_at` always moves because every one of these is a user edit.
 *
 * `.returning()` rather than a preceding SELECT: the "does this row exist" question is
 * answered by the write itself, so a project archived between the two statements cannot
 * be updated behind its own tombstone.
 */
export function updateProject(db: DrizzleDb, input: UpdateProjectInput): void {
  const patch: { name?: string; archivedAt?: string | null; updatedAt: string } = {
    updatedAt: new Date().toISOString(),
  };
  if (input.name !== undefined) patch.name = cleanName(input.name);
  if (input.archived !== undefined) {
    patch.archivedAt = input.archived ? new Date().toISOString() : null;
  }

  const updated = db
    .update(projects)
    .set(patch)
    .where(eq(projects.id, input.projectId))
    .returning({ id: projects.id })
    .all();

  if (updated.length === 0) {
    throw new AppError("NOT_FOUND", "project not found", {
      details: { projectId: input.projectId },
    });
  }
}

/** One project, or null. An archived project still resolves: its threads still name it. */
export function getProject(db: DrizzleDb, projectId: string): ProjectRow | null {
  const row = db.select(PROJECT_COLUMNS).from(projects).where(eq(projects.id, projectId)).get();
  return row ?? null;
}

/**
 * The project a new thread is about to be filed under, or a refusal.
 *
 * A thread pointing at a project that does not exist would be a thread that vanishes
 * from every filter and shows up under "All" with no explanation, so the id is checked
 * before it is written rather than after.
 */
export function assertProjectExists(db: DrizzleDb, projectId: string): void {
  const row = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
  if (row === undefined) {
    throw new AppError("NOT_FOUND", "project not found", { details: { projectId } });
  }
}
