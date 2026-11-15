import { randomUUID } from "node:crypto";
import type { McpApprovalStatus } from "@shared/ipc-contract";
import { and, asc, eq } from "drizzle-orm";
import { AppError } from "../errors.js";
import type { DrizzleDb } from "./client.js";
import { mcpApprovals, mcpServers } from "./schema.js";

/**
 * MCP servers and their approvals (D7).
 *
 * Both tables store their vectors as JSON text, so the parsing lives here and nowhere
 * else: a row written by an older build, or edited by hand, must degrade to "no
 * arguments" rather than throw on the way to the UI. A malformed `args_json` on a server
 * therefore yields `[]` — the command still runs, with fewer arguments than intended, and
 * that is visible in the panel instead of being a crash nobody can act on.
 *
 * The approval transition is a single conditional UPDATE (`status = 'pending'` in the
 * WHERE clause), which is what makes a second resolve match no row instead of running a
 * tool twice.
 */

export interface McpServerRow {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  createdAt: string;
}

export interface McpApprovalRow {
  id: string;
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  status: McpApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function parseStringRecord(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const entries: [string, string][] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") entries.push([key, value]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed));
  } catch {
    return {};
  }
}

const SERVER_COLUMNS = {
  id: mcpServers.id,
  name: mcpServers.name,
  command: mcpServers.command,
  argsJson: mcpServers.argsJson,
  envJson: mcpServers.envJson,
  enabled: mcpServers.enabled,
  createdAt: mcpServers.createdAt,
} as const;

interface RawServer {
  id: string;
  name: string;
  command: string;
  argsJson: string;
  envJson: string;
  enabled: boolean;
  createdAt: string;
}

function toServerRow(raw: RawServer): McpServerRow {
  return {
    id: raw.id,
    name: raw.name,
    command: raw.command,
    args: parseStringArray(raw.argsJson),
    env: parseStringRecord(raw.envJson),
    enabled: raw.enabled,
    createdAt: raw.createdAt,
  };
}

/** Oldest first: a server list that reorders itself on every read is a list nobody can learn. */
export function listServerRows(db: DrizzleDb): McpServerRow[] {
  return db
    .select(SERVER_COLUMNS)
    .from(mcpServers)
    .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id))
    .all()
    .map(toServerRow);
}

export function getServerRow(db: DrizzleDb, serverId: string): McpServerRow {
  const raw = db.select(SERVER_COLUMNS).from(mcpServers).where(eq(mcpServers.id, serverId)).get();
  if (raw === undefined) {
    throw new AppError("NOT_FOUND", "MCP server not found", { details: { serverId } });
  }
  return toServerRow(raw);
}

export interface AddServerInput {
  name: string;
  command: string;
  args: string[];
}

/**
 * Inserts a server. Names are not unique: a user who removes a server and adds it back
 * under the same name is doing one thing, not tripping a constraint. `env_json` and
 * `enabled` take their defaults — no channel writes either in this phase.
 */
export function insertServer(db: DrizzleDb, input: AddServerInput): McpServerRow {
  const raw = db
    .insert(mcpServers)
    .values({
      id: randomUUID(),
      name: input.name,
      command: input.command,
      argsJson: JSON.stringify(input.args),
      createdAt: new Date().toISOString(),
    })
    .returning(SERVER_COLUMNS)
    .get();

  if (raw === undefined) {
    throw new AppError("INTERNAL", "the MCP server was not written");
  }
  return toServerRow(raw);
}

/** Hard delete. A server is configuration, not content; there is nothing to archive. */
export function deleteServerRow(db: DrizzleDb, serverId: string): void {
  const deleted = db
    .delete(mcpServers)
    .where(eq(mcpServers.id, serverId))
    .returning({ id: mcpServers.id })
    .all();

  if (deleted.length === 0) {
    throw new AppError("NOT_FOUND", "MCP server not found", { details: { serverId } });
  }
}

export interface RequestApprovalInput {
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
}

/** Records a call the user has not decided on yet. Nothing has run. */
export function insertApproval(db: DrizzleDb, input: RequestApprovalInput): string {
  const id = randomUUID();
  const written = db
    .insert(mcpApprovals)
    .values({
      id,
      serverId: input.serverId,
      tool: input.tool,
      argsJson: JSON.stringify(input.args),
      status: "pending",
      createdAt: new Date().toISOString(),
    })
    .returning({ id: mcpApprovals.id })
    .get();

  if (written === undefined) {
    throw new AppError("INTERNAL", "the approval was not written", { details: { id } });
  }
  return written.id;
}

const APPROVAL_COLUMNS = {
  id: mcpApprovals.id,
  serverId: mcpApprovals.serverId,
  tool: mcpApprovals.tool,
  argsJson: mcpApprovals.argsJson,
  status: mcpApprovals.status,
  createdAt: mcpApprovals.createdAt,
  resolvedAt: mcpApprovals.resolvedAt,
} as const;

export function getApprovalRow(db: DrizzleDb, approvalId: string): McpApprovalRow {
  const raw = db
    .select(APPROVAL_COLUMNS)
    .from(mcpApprovals)
    .where(eq(mcpApprovals.id, approvalId))
    .get();

  if (raw === undefined) {
    throw new AppError("NOT_FOUND", "approval not found", { details: { approvalId } });
  }
  return {
    id: raw.id,
    serverId: raw.serverId,
    tool: raw.tool,
    args: parseObject(raw.argsJson),
    status: raw.status,
    createdAt: raw.createdAt,
    resolvedAt: raw.resolvedAt,
  };
}

/**
 * Moves a pending approval to a terminal state, and reports whether it matched.
 *
 * The condition is in the UPDATE's WHERE clause rather than in a preceding read: two
 * resolves that both saw `pending` cannot both win, and the loser gets `false` instead of
 * a second execution.
 */
export function setApprovalStatus(
  db: DrizzleDb,
  approvalId: string,
  status: Exclude<McpApprovalStatus, "pending">,
): boolean {
  const updated = db
    .update(mcpApprovals)
    .set({ status, resolvedAt: new Date().toISOString() })
    .where(and(eq(mcpApprovals.id, approvalId), eq(mcpApprovals.status, "pending")))
    .returning({ id: mcpApprovals.id })
    .get();

  return updated !== undefined;
}
