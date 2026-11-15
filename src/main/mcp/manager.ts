import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { McpServer, McpServerStatus, McpTool, ResponseOf } from "@shared/ipc-contract";
import type { DrizzleDb } from "../db/client.js";
import {
  deleteServerRow,
  getApprovalRow,
  getServerRow,
  insertApproval,
  insertServer,
  listServerRows,
  type McpApprovalRow,
  type McpServerRow,
  setApprovalStatus,
} from "../db/repo-mcp.js";
import { AppError } from "../errors.js";
import { JsonRpcPeer, JsonRpcTimeoutError } from "./jsonrpc.js";

/**
 * The MCP runtime (D7): one child process per server, one approval per tool call.
 *
 * Three properties this file exists to guarantee, in the order they matter:
 *
 *  1. **Nothing a server does can throw the app.** A bad line, a crash, a command that
 *     does not exist, a tool that never answers — every one of them ends as a status and a
 *     string, never as an unhandled `error` event on the main process.
 *  2. **No tool runs without an approval, and no approval runs twice.** A request is a
 *     row; execution is a separate channel that matches `status = 'pending'` in its UPDATE.
 *  3. **Arguments are never logged.** They are the one part of this surface that can carry
 *     a secret, so the logs carry the tool name and a byte count, and a byte count is
 *     enough to tell "empty" from "something was passed".
 *
 * Spawning is lazy. Adding a server is a database write; a process starts when something
 * asks for its tools or asks to run one, and a server that is never used never runs.
 */

/** The MCP revision this client speaks. Pinned rather than negotiated: no feature of a
 * later revision is used, and claiming one would be a lie about what was tested. */
const MCP_PROTOCOL_VERSION = "2024-11-05";

const DEFAULT_LIST_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

/** How much stderr to keep for display. The tail is what a crash reason lives in. */
const STDERR_CAP_CHARS = 2_000;
const LAST_ERROR_CAP_CHARS = 500;

interface Runtime {
  child: ChildProcessWithoutNullStreams;
  peer: JsonRpcPeer;
  status: McpServerStatus;
  tools: McpTool[];
  /** The trailing stderr text, capped. Read for the last line when a crash is reported. */
  stderr: string;
  /** Why the process is `crashed`, as one line for the panel. Null while it is not. */
  lastError: string | null;
}

export interface McpManagerOptions {
  db: DrizzleDb;
  /** The client name reported in `initialize`; tests do not care, a server might. */
  clientVersion?: string;
  listTimeoutMs?: number;
  callTimeoutMs?: number;
  killGraceMs?: number;
}

export class McpManager {
  private readonly db: DrizzleDb;
  private readonly clientVersion: string;
  private readonly listTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly starting = new Map<string, Promise<Runtime>>();
  /** Approval ids currently being resolved, so a double-click cannot execute twice. */
  private readonly resolving = new Set<string>();
  private disposed = false;

  constructor(options: McpManagerOptions) {
    this.db = options.db;
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  /* ------------------------------------------------------------- servers */

  /** The list, with live state. A read: it never spawns anything. */
  listServers(): ResponseOf<"mcp.listServers"> {
    const items = listServerRows(this.db).map((row) => this.view(row));
    return { items, total: items.length };
  }

  addServer(input: { name: string; command: string; args: string[] }): McpServer {
    return this.view(insertServer(this.db, input));
  }

  /**
   * Stops the process (if one is running) and forgets the row.
   *
   * Approvals cascade with the server: a call that was pending on a server the user has
   * just removed has nowhere to go, and leaving it resolvable would offer a button that
   * cannot work.
   */
  async removeServer(serverId: string): Promise<void> {
    getServerRow(this.db, serverId);
    await this.stop(serverId);
    deleteServerRow(this.db, serverId);
  }

  /** Stops the process and keeps the row, so a crashed server can be restarted or removed. */
  async killServer(serverId: string): Promise<void> {
    getServerRow(this.db, serverId);
    await this.stop(serverId);
  }

  /* --------------------------------------------------------------- tools */

  /**
   * Starts the server if needed, initialises, and asks for `tools/list`.
   *
   * The tool list is cached per process, which is also what `toolCount` reports: a restart
   * clears it, because the tools of a process that died are not the tools of the one that
   * replaced it.
   */
  async listTools(serverId: string): Promise<ResponseOf<"mcp.listTools">> {
    const runtime = await this.ensureReady(serverId);
    let result: unknown;
    try {
      result = await runtime.peer.request<unknown>("tools/list", {}, this.listTimeoutMs);
    } catch (error) {
      throw new AppError("UPSTREAM_ERROR", `tools/list failed: ${describe(error)}`, {
        details: { serverId },
      });
    }

    const tools = normalizeTools(result);
    runtime.tools = tools;
    return { tools };
  }

  /* ----------------------------------------------------------- approvals */

  /**
   * Records an intent to call a tool. Nothing runs, and the id is the only answer.
   *
   * Deliberately cheap: no process is started and no tool is looked up, so a request can
   * be made against a server that is not running. Whether the tool exists is the server's
   * problem at execution time, and a `tools/call` for an unknown tool is a `failed`
   * approval with the server's own reason in it.
   */
  requestToolCall(input: { serverId: string; tool: string; args: Record<string, unknown> }): {
    approvalId: string;
  } {
    const server = getServerRow(this.db, input.serverId);
    const approvalId = insertApproval(this.db, {
      serverId: server.id,
      tool: input.tool,
      args: input.args,
    });

    // The tool name and a size, never the arguments: this is the one log line on the
    // tool-call path, and arguments are where a token or a password would be.
    console.info("[mcp] tool call requested, awaiting approval", {
      serverId: server.id,
      tool: input.tool,
      argBytes: byteLength(input.args),
    });
    return { approvalId };
  }

  /**
   * The only path from an approval to an executed tool.
   *
   * `deny` never touches the child: it settles the row and returns. `allow` starts the
   * server if it is not running, sends exactly one `tools/call`, and records what came
   * back. A call that cannot be completed is `failed` with the reason — not an error
   * envelope, because the user's decision was carried out and the outcome belongs on the
   * approval.
   */
  async resolveApproval(input: {
    approvalId: string;
    allow: boolean;
  }): Promise<ResponseOf<"mcp.resolveApproval">> {
    const approval = getApprovalRow(this.db, input.approvalId);

    if (approval.status !== "pending") {
      throw new AppError("CONFLICT", "this approval has already been resolved", {
        details: { approvalId: approval.id, status: approval.status },
      });
    }
    if (this.resolving.has(approval.id)) {
      throw new AppError("CONFLICT", "this approval is already being resolved", {
        details: { approvalId: approval.id },
      });
    }

    this.resolving.add(approval.id);
    try {
      if (!input.allow) {
        this.record(approval.id, "denied");
        return { status: "denied" };
      }
      return await this.execute(approval);
    } finally {
      this.resolving.delete(approval.id);
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Stops every child. Called on quit, and synchronous by design: a quit handler that
   * awaits can be cut short by the app going away mid-await.
   */
  dispose(): void {
    this.disposed = true;
    for (const [serverId, runtime] of this.runtimes) {
      runtime.status = "stopped";
      runtime.peer.close(new Error("the MCP manager was shut down"));
      this.terminateNow(runtime.child);
      this.runtimes.delete(serverId);
    }
    this.starting.clear();
  }

  /* -------------------------------------------------------------- private */

  private view(row: McpServerRow): McpServer {
    const runtime = this.runtimes.get(row.id);
    return {
      id: row.id,
      name: row.name,
      command: row.command,
      args: row.args,
      enabled: row.enabled,
      createdAt: row.createdAt,
      status: runtime?.status ?? "stopped",
      toolCount: runtime?.tools.length ?? 0,
      lastError: runtime?.status === "crashed" ? (runtime.lastError ?? "the server stopped") : null,
    };
  }

  private async execute(approval: McpApprovalRow): Promise<ResponseOf<"mcp.resolveApproval">> {
    const argBytes = byteLength(approval.args);
    try {
      const runtime = await this.ensureReady(approval.serverId);
      console.info("[mcp] tool call allowed, executing", {
        serverId: approval.serverId,
        tool: approval.tool,
        argBytes,
      });

      const result = await runtime.peer.request<unknown>(
        "tools/call",
        { name: approval.tool, arguments: approval.args },
        this.callTimeoutMs,
      );

      // A tool that reports `isError: true` inside its result *did* run: the call
      // completed, and its own result says the work failed. That is `executed` with a
      // result, not `failed` — collapsing the two would hide the tool's own words.
      this.record(approval.id, "executed");
      return { status: "executed", result };
    } catch (error) {
      const message = describe(error);
      console.warn("[mcp] tool call failed", {
        serverId: approval.serverId,
        tool: approval.tool,
        argBytes,
        error: message,
      });
      this.record(approval.id, "failed");
      return { status: "failed", error: message };
    }
  }

  /** Writes the terminal state, and says so if another path got there first. */
  private record(approvalId: string, status: "executed" | "denied" | "failed"): void {
    if (!setApprovalStatus(this.db, approvalId, status)) {
      console.warn("[mcp] an approval was already resolved and was not overwritten", {
        approvalId,
        status,
      });
    }
  }

  /**
   * The runtime for a server that is ready to answer, starting it if it is not.
   *
   * A crashed server is not restarted implicitly: its tools would come back without the
   * user knowing the process they trusted had died. `killServer` then `listTools` is the
   * deliberate restart, and the error says so.
   */
  private async ensureReady(serverId: string): Promise<Runtime> {
    if (this.disposed) {
      throw new AppError("INTERNAL", "the MCP manager has been shut down");
    }

    const existing = this.runtimes.get(serverId);
    if (existing !== undefined) {
      if (existing.status === "ready") return existing;
      if (existing.status === "crashed") {
        throw new AppError(
          "UPSTREAM_ERROR",
          `the server has crashed (${existing.lastError ?? "no reason reported"}); kill it before starting it again`,
          { details: { serverId } },
        );
      }
    }

    const inFlight = this.starting.get(serverId);
    if (inFlight !== undefined) return inFlight;

    const starting = this.start(serverId).finally(() => {
      this.starting.delete(serverId);
    });
    this.starting.set(serverId, starting);
    return starting;
  }

  private async start(serverId: string): Promise<Runtime> {
    const row = getServerRow(this.db, serverId);

    const child: ChildProcessWithoutNullStreams = spawn(row.command, row.args, {
      // An array, so nothing here goes through a shell: a server's arguments are handed to
      // the command as argv, and a `;` in one of them is a character, not a separator.
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, ...row.env },
    });

    const peer = new JsonRpcPeer({
      send: (line) => {
        child.stdin.write(`${line}\n`);
      },
      timeoutMs: this.listTimeoutMs,
      onMalformed: (line, cause) => {
        // Never the whole line: it could be a fragment of a message carrying arguments.
        console.warn("[mcp] ignored an unparseable line from a server", {
          serverId: row.id,
          bytes: Buffer.byteLength(line, "utf8"),
          error: describe(cause),
        });
      },
    });

    const runtime: Runtime = {
      child,
      peer,
      status: "starting",
      tools: [],
      stderr: "",
      lastError: null,
    };
    this.runtimes.set(serverId, runtime);

    // A write to a stdin whose process is gone emits `error` on the stream. Unhandled,
    // that event takes the whole main process down — which is the exact failure this
    // whole file is written to prevent.
    const ignoreStreamError = (error: Error): void => {
      console.warn("[mcp] a stdio stream reported an error", {
        serverId: row.id,
        error: describe(error),
      });
    };
    child.stdin.on("error", ignoreStreamError);
    child.stdout.on("error", ignoreStreamError);
    child.stderr.on("error", ignoreStreamError);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => peer.receive(chunk));
    child.stderr.on("data", (chunk: string) => {
      runtime.stderr = tail(runtime.stderr + chunk, STDERR_CAP_CHARS);
    });

    const crash = (reason: string): void => {
      // Only the runtime that is still current may mark itself crashed: a runtime stopped
      // by `killServer` is removed from the map first, and its exit is not news.
      if (this.runtimes.get(serverId) !== runtime) return;
      if (runtime.status === "crashed") return;

      runtime.status = "crashed";
      runtime.tools = [];
      runtime.lastError = cap(lastLine(runtime.stderr) || reason, LAST_ERROR_CAP_CHARS);
      peer.close(new Error(runtime.lastError));
      console.warn("[mcp] server crashed", { serverId: row.id, error: runtime.lastError });
    };

    // `error` covers a command that does not exist; `close` covers a process that ran and
    // then went away. Both are crashes from the manager's point of view, and `close` is
    // preferred over `exit` for the second because it fires after stderr has been drained —
    // a crash reason written just before dying still makes it into the panel.
    child.once("error", (error: Error) => crash(`could not start: ${describe(error)}`));
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) =>
      crash(`the server exited (${describeExit(code, signal)})`),
    );

    try {
      // No protocol-version check on the way back: this client uses none of the features
      // a revision adds, so a mismatch would only reject a server that works.
      await peer.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "cleon-desktop", version: this.clientVersion },
        },
        this.listTimeoutMs,
      );
      peer.notify("notifications/initialized");
      runtime.status = "ready";
      return runtime;
    } catch (error) {
      crash(`initialise failed: ${describe(error)}`);
      // The child is either gone already or wedged; either way it is not wanted.
      await this.terminate(child);
      if (error instanceof JsonRpcTimeoutError) {
        throw new AppError("UPSTREAM_ERROR", `the server did not initialise in time`, {
          details: { serverId },
        });
      }
      throw new AppError("UPSTREAM_ERROR", `could not start ${row.name}: ${describe(error)}`, {
        details: { serverId },
      });
    }
  }

  /** Stops the process and forgets its runtime. A no-op when nothing is running. */
  private async stop(serverId: string): Promise<void> {
    const runtime = this.runtimes.get(serverId);
    this.starting.delete(serverId);
    this.runtimes.delete(serverId);
    if (runtime === undefined) return;

    // Marked before the signal, so the `close` handler sees a runtime that is no longer
    // current and does not report the shutdown as a crash.
    runtime.status = "stopped";
    runtime.peer.close(new Error("the server was stopped"));
    await this.terminate(runtime.child);
  }

  /** SIGTERM, then SIGKILL once the grace period is up, and resolve when it is gone. */
  private terminate(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }

      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      let bail: NodeJS.Timeout | undefined;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (grace !== undefined) clearTimeout(grace);
        if (bail !== undefined) clearTimeout(bail);
        resolve();
      };

      // A child that ignores SIGKILL at the kernel level does not exist, but a stream that
      // never reports the exit would hang an IPC call forever; the bail timer is the
      // guarantee that a kill is bounded.
      bail = setTimeout(finish, this.killGraceMs * 2);
      bail.unref();

      grace = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, this.killGraceMs);
      grace.unref();

      child.once("exit", finish);
      child.kill("SIGTERM");
    });
  }

  /** The quit path: signal now, do not wait, do not keep the process alive to do it. */
  private terminateNow(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const hard = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, this.killGraceMs);
    hard.unref();
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * The contract's tool shape from whatever the server sent.
 *
 * A tool without a name is dropped rather than shown: a row a user can click that calls
 * nothing is worse than a shorter list. `inputSchema` is passed through as an object and
 * defaulted when the server omits it, because the panel renders it and a missing field
 * must not be a crash.
 */
function normalizeTools(result: unknown): McpTool[] {
  if (typeof result !== "object" || result === null) return [];
  const tools: unknown = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];

  const normalized: McpTool[] = [];
  for (const entry of tools) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== "string" || name === "") continue;

    normalized.push({
      name,
      description: typeof record.description === "string" ? record.description : "",
      inputSchema:
        typeof record.inputSchema === "object" &&
        record.inputSchema !== null &&
        !Array.isArray(record.inputSchema)
          ? Object.fromEntries(Object.entries(record.inputSchema))
          : {},
    });
  }
  return normalized;
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

function tail(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(-cap);
}

function cap(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `signal ${signal}`;
  if (code !== null) return `exit code ${code}`;
  return "no exit status";
}

function describe(error: unknown): string {
  if (error instanceof JsonRpcTimeoutError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
