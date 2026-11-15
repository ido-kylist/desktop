import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../src/main/db/client.js";
import { closeDatabase, type Db, openDatabase, schemaVersion } from "../../src/main/db/index.js";
import { MIGRATIONS } from "../../src/main/db/migrations.js";
import { AppError } from "../../src/main/errors.js";
import { McpManager } from "../../src/main/mcp/manager.js";
import { contracts } from "../../src/shared/ipc-contract";

/**
 * D7 against a real child process.
 *
 * Not a fake transport and not a mocked manager: every test here spawns
 * `mock/mcp-echo-server.mjs` exactly the way a user's server would be spawned, and speaks
 * to it over the pipes it was given. That is the only way to prove the three claims that
 * matter:
 *
 *  1. the approval gate holds — a denied call reaches no process, and the proof is a tool
 *     whose *execution* would kill the server,
 *  2. a call that is allowed really runs, and the arguments make the round trip,
 *  3. a server that dies takes nothing else with it — the manager keeps answering and the
 *     status says `crashed` with the reason.
 *
 * Every test builds its own server row, so nothing here depends on test order. Each server
 * is a node process; the crash test proves the manager notices when one stops being there.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO_SERVER = resolve(HERE, "../../mock/mcp-echo-server.mjs");

let tempDir = "";
let conn: Db;
let db: DrizzleDb;
let manager: McpManager;

/** A server row wired to the echo mock, named so a failure says which test made it. */
function addEchoServer(name: string): string {
  return manager.addServer({ name, command: process.execPath, args: [ECHO_SERVER] }).id;
}

function expectAppError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

async function expectAppErrorAsync(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

function statusOf(serverId: string): string {
  const found = manager.listServers().items.find((item) => item.id === serverId);
  if (found === undefined) throw new Error("the server is not in the list");
  return found.status;
}

function approvalRow(approvalId: string): { status: string; resolved_at: string | null } {
  const row = conn
    .prepare("SELECT status, resolved_at FROM mcp_approvals WHERE id = ?")
    .get(approvalId) as { status: string; resolved_at: string | null } | undefined;
  if (row === undefined) throw new Error("the approval row is gone");
  return row;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cleon-d7-mcp-"));
  conn = openDatabase(join(tempDir, "cleon.db"));
  db = createDb(conn);
  // A shorter grace than production's: these are processes that exit on SIGTERM.
  manager = new McpManager({ db, listTimeoutMs: 5_000, callTimeoutMs: 5_000, killGraceMs: 500 });
});

afterAll(async () => {
  manager.dispose();
  closeDatabase();
  if (tempDir !== "") await rm(tempDir, { recursive: true, force: true });
});

describe("the schema this slice relies on", () => {
  it("applies migration 6, and both MCP tables have the columns the repository uses", () => {
    expect(schemaVersion(conn)).toBe(MIGRATIONS.at(-1)?.version);

    const servers = conn.prepare("PRAGMA table_info(mcp_servers)").all() as { name: string }[];
    expect(servers.map((column) => column.name).sort()).toEqual([
      "args_json",
      "command",
      "created_at",
      "enabled",
      "env_json",
      "id",
      "name",
    ]);

    const approvals = conn.prepare("PRAGMA table_info(mcp_approvals)").all() as { name: string }[];
    expect(approvals.map((column) => column.name).sort()).toEqual([
      "args_json",
      "created_at",
      "id",
      "resolved_at",
      "server_id",
      "status",
      "tool",
    ]);
  });
});

describe("server lifecycle", () => {
  it("adds a server as `stopped` with no process and no tools", () => {
    const created = manager.addServer({
      name: "Stopped",
      command: process.execPath,
      args: [ECHO_SERVER],
    });

    expect(created).toMatchObject({
      name: "Stopped",
      command: process.execPath,
      args: [ECHO_SERVER],
      enabled: true,
      status: "stopped",
      toolCount: 0,
      lastError: null,
    });
    // The boundary is the type: uuid and ISO shapes included.
    expect(() => contracts["mcp.addServer"].response.parse(created)).not.toThrow();
    expect(manager.listServers()).toMatchObject({ total: expect.any(Number) });
    expect(() => contracts["mcp.listServers"].response.parse(manager.listServers())).not.toThrow();
  });

  it("starts on demand and lists the tools of the running process", async () => {
    const serverId = addEchoServer("Tools");

    const listed = await manager.listTools(serverId);

    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo", "crash"]);
    expect(listed.tools[0]?.description).toContain("Echo back");
    expect(listed.tools[0]?.inputSchema).toMatchObject({ type: "object" });
    expect(() => contracts["mcp.listTools"].response.parse(listed)).not.toThrow();

    const server = manager.listServers().items.find((item) => item.id === serverId);
    expect(server?.status).toBe("ready");
    expect(server?.toolCount).toBe(2);
    expect(server?.lastError).toBeNull();
  });

  it("reports `starting` while a server is still being brought up", async () => {
    const serverId = addEchoServer("Starting");

    // `start` marks the runtime before its first await, so the window is observable without
    // a race: the status is `starting` the moment the request is made.
    const inFlight = manager.listTools(serverId);
    expect(statusOf(serverId)).toBe("starting");

    await inFlight;
    expect(statusOf(serverId)).toBe("ready");
  });

  it("kills a running server and starts it again on the next request", async () => {
    const serverId = addEchoServer("Restart");
    await manager.listTools(serverId);
    expect(statusOf(serverId)).toBe("ready");

    await manager.killServer(serverId);
    expect(statusOf(serverId)).toBe("stopped");

    // The row survived the kill, and the next read starts a fresh process.
    await manager.listTools(serverId);
    expect(statusOf(serverId)).toBe("ready");
  });

  it("removes the row and its approvals, and refuses an unknown server", async () => {
    const serverId = addEchoServer("Removable");
    await manager.listTools(serverId);
    const { approvalId } = manager.requestToolCall({ serverId, tool: "echo", args: {} });

    await manager.removeServer(serverId);

    expect(manager.listServers().items.some((item) => item.id === serverId)).toBe(false);
    // Cascade: a pending call on a server that no longer exists has nowhere to go, so the
    // record goes with the server rather than staying resolvable against nothing.
    const remaining = conn
      .prepare("SELECT COUNT(*) AS n FROM mcp_approvals WHERE id = ?")
      .get(approvalId) as { n: number };
    expect(remaining.n).toBe(0);

    await expectAppErrorAsync(() => manager.killServer(serverId), "NOT_FOUND");
    await expectAppErrorAsync(() => manager.removeServer(serverId), "NOT_FOUND");
    await expectAppErrorAsync(() => manager.listTools(serverId), "NOT_FOUND");
  });
});

describe("the approval gate", () => {
  it("records a request and runs nothing: the server is not even started", () => {
    const serverId = addEchoServer("Pending");

    const { approvalId } = manager.requestToolCall({
      serverId,
      tool: "echo",
      args: { text: "nothing should happen" },
    });
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/);

    // The row is the whole outcome of a request.
    expect(approvalRow(approvalId)).toEqual({ status: "pending", resolved_at: null });
    // And no process was spawned to find out whether the tool exists.
    expect(statusOf(serverId)).toBe("stopped");
  });

  it("executes an allowed call and returns the server's own result", async () => {
    const serverId = addEchoServer("Allowed");
    await manager.listTools(serverId);

    const args = { text: "round trip", nested: { n: 7 } };
    const { approvalId } = manager.requestToolCall({ serverId, tool: "echo", args });

    const resolved = await manager.resolveApproval({ approvalId, allow: true });
    expect(resolved.status).toBe("executed");
    expect(() => contracts["mcp.resolveApproval"].response.parse(resolved)).not.toThrow();

    // The echo tool answers with the arguments as JSON text, so this is the exact object
    // making the round trip through spawn, the pipes, and JSON-RPC.
    const content = resolved.result as { content: { type: string; text: string }[] };
    expect(content.content[0]?.type).toBe("text");
    expect(JSON.parse(content.content[0]?.text ?? "null")).toEqual(args);

    const row = approvalRow(approvalId);
    expect(row.status).toBe("executed");
    expect(row.resolved_at).not.toBeNull();
  });

  it("never touches the child when the call is denied", async () => {
    const serverId = addEchoServer("Denied");
    await manager.listTools(serverId);

    // `crash` exits the process. If a denial reached the child, this server would die —
    // which makes a still-`ready` status proof that the denial sent nothing at all.
    const { approvalId } = manager.requestToolCall({ serverId, tool: "crash", args: {} });

    const resolved = await manager.resolveApproval({ approvalId, allow: false });

    expect(resolved).toEqual({ status: "denied" });
    expect(approvalRow(approvalId).status).toBe("denied");
    expect(approvalRow(approvalId).resolved_at).not.toBeNull();
    expect(statusOf(serverId)).toBe("ready");
  });

  it("refuses a second resolve, a request for an unknown server, and an unknown approval", async () => {
    const serverId = addEchoServer("Resolve");
    await manager.listTools(serverId);
    const { approvalId } = manager.requestToolCall({ serverId, tool: "echo", args: {} });

    const first = await manager.resolveApproval({ approvalId, allow: false });
    expect(first.status).toBe("denied");

    // The row is terminal; a second click is a conflict, not a second execution.
    await expectAppErrorAsync(
      () => manager.resolveApproval({ approvalId, allow: false }),
      "CONFLICT",
    );
    await expectAppErrorAsync(
      () => manager.resolveApproval({ approvalId, allow: true }),
      "CONFLICT",
    );

    // A request for a server that is not in the database, and a resolve of an approval
    // that never existed, are both NOT_FOUND rather than a silent success.
    expectAppError(
      () =>
        manager.requestToolCall({
          serverId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          tool: "echo",
          args: {},
        }),
      "NOT_FOUND",
    );
    await expectAppErrorAsync(
      () =>
        manager.resolveApproval({
          approvalId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          allow: true,
        }),
      "NOT_FOUND",
    );
  });
});

describe("isolation", () => {
  it("reports a server that dies as crashed, keeps its last stderr line, and stays alive", async () => {
    const serverId = addEchoServer("Crasher");
    await manager.listTools(serverId);

    const { approvalId } = manager.requestToolCall({ serverId, tool: "crash", args: {} });
    const resolved = await manager.resolveApproval({ approvalId, allow: true });

    // The call was allowed and did not complete: `failed` with the reason, not an error
    // envelope — the user's decision was carried out.
    expect(resolved.status).toBe("failed");
    expect(resolved.error).toBeTruthy();
    expect(approvalRow(approvalId).status).toBe("failed");

    // The server is gone, and the panel is told why: the last stderr line it wrote.
    const server = manager.listServers().items.find((item) => item.id === serverId);
    expect(server?.status).toBe("crashed");
    expect(server?.lastError).toContain("crash tool invoked");
    expect(server?.toolCount).toBe(0);

    // Nothing threw and nothing hung: the manager still answers, and a crashed server is
    // an error with a code rather than a restart nobody asked for.
    await expectAppErrorAsync(() => manager.listTools(serverId), "UPSTREAM_ERROR");
    expect(manager.listServers().items.some((item) => item.id === serverId)).toBe(true);

    // Kill, then list: the deliberate restart path.
    await manager.killServer(serverId);
    expect(statusOf(serverId)).toBe("stopped");
    await manager.listTools(serverId);
    expect(statusOf(serverId)).toBe("ready");
  });

  it("survives a command that cannot be started", async () => {
    const created = manager.addServer({
      name: "Missing",
      command: "cleon-definitely-not-a-command",
      args: [],
    });

    await expectAppErrorAsync(() => manager.listTools(created.id), "UPSTREAM_ERROR");

    const server = manager.listServers().items.find((item) => item.id === created.id);
    expect(server?.status).toBe("crashed");
    expect(server?.lastError).toBeTruthy();

    // And the app is still here, which is the point.
    expect(manager.listServers().total).toBeGreaterThan(0);
    await manager.removeServer(created.id);
  });
});
