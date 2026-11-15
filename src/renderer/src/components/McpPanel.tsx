import type { IpcError, McpTool } from "@shared/ipc-contract";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useDialogFocus } from "../hooks/use-dialog-focus";
import { MCP_SERVER_LIST_KEY, type McpServerSummary, useMcpServers } from "../hooks/use-mcp";
import { buildCatalog, type Catalog } from "../lib/catalogs";
import {
  addMcpServer,
  killMcpServer,
  listMcpTools,
  removeMcpServer,
  requestMcpToolCall,
  resolveMcpApproval,
  toIpcError,
} from "../lib/ipc";
import { McpApprovalCard, type McpApprovalRequest } from "./McpApprovalCard";

/**
 * The MCP panel (D7): the servers this app can run, and the gate in front of their tools.
 *
 * Three things it refuses to blur together:
 *
 *  - **status is live, not stored.** `stopped`, `starting`, `ready` and `crashed` come from
 *    the process the manager is holding, and a crashed server shows the last line it wrote
 *    to stderr instead of a shrug.
 *  - **a request is not a call.** "Call" asks for an approval and nothing more; the approval
 *    card is the only thing that can make the call happen, and Deny leaves a record saying
 *    it was refused.
 *  - **arguments are JSON, parsed here.** A malformed argument object is refused before it
 *    crosses the boundary, so a typo is a message on screen rather than a tool that ran with
 *    something else.
 *
 * The approval records below the card are this window's memory of its own calls. They are
 * persisted in `mcp_approvals` (the integration test reads them there), but the contract has
 * no channel to read them back yet, so a relaunch forgets what the panel was showing. That
 * gap is in BACKLOG.md rather than hidden behind a fake history.
 */

interface ApprovalRecord {
  approvalId: string;
  serverName: string;
  tool: string;
  status: "executed" | "denied" | "failed";
  /** What was requested, kept with the outcome: "what did I just refuse?" is the question. */
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

type Action = "add" | "remove" | "kill" | "tools" | "call" | "approval";

export function McpPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const servers = useMcpServers();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  /** Per server: two servers rarely take the same arguments, and a shared box would lie. */
  const [callArgs, setCallArgs] = useState<Record<string, string>>({});

  const [toolsByServer, setToolsByServer] = useState<Record<string, McpTool[]>>({});
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<IpcError | null>(null);
  const [pending, setPending] = useState<McpApprovalRequest | null>(null);
  const [records, setRecords] = useState<ApprovalRecord[]>([]);
  const panel = useRef<HTMLElement | null>(null);
  useDialogFocus(panel, onClose);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: MCP_SERVER_LIST_KEY });
  };

  const catalog: Catalog<McpServerSummary> = buildCatalog({
    loading: servers.isPending,
    result: servers.data?.items,
    error: toIpcError(servers.error),
  });

  const add = async (): Promise<void> => {
    if (busy !== null || name.trim() === "" || command.trim() === "") return;

    setBusy("add");
    setError(null);
    const result = await addMcpServer({
      name: name.trim(),
      command: command.trim(),
      // One argument per line: a path with a space in it is one argument, and a textarea
      // split on whitespace would make that impossible to express.
      args: argsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setName("");
    setCommand("");
    setArgsText("");
    await refresh();
  };

  const remove = async (server: McpServerSummary): Promise<void> => {
    if (busy !== null) return;

    setBusy("remove");
    setError(null);
    const result = await removeMcpServer(server.id);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    forget(server.id);
    await refresh();
  };

  const kill = async (server: McpServerSummary): Promise<void> => {
    if (busy !== null) return;

    setBusy("kill");
    setError(null);
    const result = await killMcpServer(server.id);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refresh();
  };

  /** A server that is gone cannot have tools, a pending approval, or a record to resolve. */
  const forget = (serverId: string): void => {
    setToolsByServer((current) => {
      const next = { ...current };
      delete next[serverId];
      return next;
    });
    setPending((current) => (current !== null && current.serverId === serverId ? null : current));
  };

  const loadTools = async (server: McpServerSummary): Promise<void> => {
    if (busy !== null) return;

    setBusy("tools");
    setError(null);
    const result = await listMcpTools(server.id);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      // The status is re-read either way: a failed start is a crash, and the panel has to
      // show it instead of leaving the row saying `stopped`.
      await refresh();
      return;
    }
    setToolsByServer((current) => ({ ...current, [server.id]: result.data.tools }));
    await refresh();
  };

  const ask = async (server: McpServerSummary, tool: McpTool): Promise<void> => {
    if (busy !== null) return;

    const args = parseArgs(callArgs[server.id] ?? "{}");
    if (typeof args === "string") {
      setError({ code: "BAD_REQUEST", message: args });
      return;
    }

    setBusy("call");
    setError(null);
    const result = await requestMcpToolCall({ serverId: server.id, tool: tool.name, args });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPending({
      approvalId: result.data.approvalId,
      serverId: server.id,
      serverName: server.name,
      tool: tool.name,
      args,
    });
  };

  const resolve = async (allow: boolean): Promise<void> => {
    if (pending === null || busy !== null) return;

    const request = pending;
    setBusy("approval");
    setError(null);
    const result = await resolveMcpApproval({ approvalId: request.approvalId, allow });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setRecords((current) => [
      ...current,
      {
        approvalId: request.approvalId,
        serverName: request.serverName,
        tool: request.tool,
        status: result.data.status,
        args: request.args,
        ...(result.data.result === undefined ? {} : { result: result.data.result }),
        ...(result.data.error === undefined ? {} : { error: result.data.error }),
      },
    ]);
    setPending(null);
    // An executed or failed call can change what a server is: `crash` kills it, and the
    // panel has to say so.
    await refresh();
  };

  return (
    <div className="library-backdrop" data-testid="mcp-panel">
      <section
        className="library mcp"
        role="dialog"
        aria-modal="true"
        aria-label="MCP servers"
        ref={panel}
        tabIndex={-1}
      >
        <div className="library-head">
          <h2>MCP</h2>
          <span className="mcp-kicker">tools run only when you allow them</span>
          <button
            type="button"
            className="btn btn-small"
            aria-label="Refresh servers"
            title="Refresh servers"
            onClick={() => {
              void refresh();
            }}
            data-testid="mcp-refresh"
          >
            ↻
          </button>
          <button
            type="button"
            className="btn btn-small"
            aria-label="Close MCP"
            onClick={onClose}
            data-testid="mcp-close"
          >
            ✕
          </button>
        </div>

        {pending !== null && (
          <McpApprovalCard
            request={pending}
            tools={toolsByServer[pending.serverId] ?? []}
            busy={busy === "approval"}
            onResolve={(allow) => void resolve(allow)}
          />
        )}

        <form
          className="library-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="library-form-row">
            <label className="library-field">
              <span>Name</span>
              <input
                type="text"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                data-testid="mcp-name"
              />
            </label>
            <label className="library-field">
              <span>Command</span>
              <input
                type="text"
                value={command}
                maxLength={500}
                placeholder="node"
                onChange={(event) => setCommand(event.target.value)}
                data-testid="mcp-command"
              />
            </label>
          </div>
          <label className="library-field">
            <span>Arguments (one per line)</span>
            <textarea
              rows={2}
              value={argsText}
              placeholder="mock/mcp-echo-server.mjs"
              onChange={(event) => setArgsText(event.target.value)}
              data-testid="mcp-args"
            />
          </label>
          <div className="library-form-actions">
            <button
              type="submit"
              className="btn btn-small"
              disabled={busy !== null || name.trim() === "" || command.trim() === ""}
              data-testid="mcp-add"
            >
              Add server
            </button>
          </div>
        </form>

        {error !== null && (
          <p className="sidebar-error" role="alert" data-testid="mcp-error">
            <span className="banner-code">{error.code}</span> {error.message}
          </p>
        )}

        {catalog.state === "loading" && <p className="sidebar-note muted">Loading servers…</p>}

        {catalog.state === "error" && (
          <p className="sidebar-error" role="alert" data-testid="mcp-list-error">
            <span className="banner-code">{catalog.error.code}</span> {catalog.error.message}
          </p>
        )}

        {catalog.state === "empty" && (
          <p className="sidebar-note muted" data-testid="mcp-list-empty">
            No servers. Add a command above; nothing runs until you ask for its tools.
          </p>
        )}

        {catalog.state === "ready" && (
          <ul className="mcp-servers" data-testid="mcp-server-list">
            {catalog.items.map((server) => {
              const tools = toolsByServer[server.id];
              return (
                <li className="mcp-server" key={server.id} data-testid="mcp-server">
                  <div className="mcp-server-head">
                    <span className="mcp-server-name">{server.name}</span>
                    <span
                      className={`mcp-status mcp-status-${server.status}`}
                      data-testid="mcp-server-status"
                    >
                      {server.status}
                    </span>
                    <span className="mcp-server-tools-count">
                      {server.toolCount} {server.toolCount === 1 ? "tool" : "tools"}
                    </span>
                    <div className="mcp-server-actions">
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={busy !== null}
                        onClick={() => void loadTools(server)}
                        data-testid="mcp-server-tools"
                      >
                        Tools
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={busy !== null || server.status === "stopped"}
                        onClick={() => void kill(server)}
                        data-testid="mcp-server-kill"
                      >
                        Kill
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-stop"
                        disabled={busy !== null}
                        onClick={() => void remove(server)}
                        data-testid="mcp-server-remove"
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <p className="mcp-server-command mono">
                    {server.command} {server.args.join(" ")}
                  </p>

                  {server.lastError !== null && (
                    <p className="sidebar-error" data-testid="mcp-server-error">
                      {server.lastError}
                    </p>
                  )}

                  {tools !== undefined && (
                    <div className="mcp-tools">
                      <label className="library-field">
                        <span>Arguments for the next call (JSON)</span>
                        <textarea
                          rows={2}
                          value={callArgs[server.id] ?? "{}"}
                          onChange={(event) =>
                            setCallArgs((current) => ({
                              ...current,
                              [server.id]: event.target.value,
                            }))
                          }
                          data-testid="mcp-call-args"
                        />
                      </label>
                      {tools.length === 0 && (
                        <p className="sidebar-note muted">This server advertises no tools.</p>
                      )}
                      {tools.length > 0 && (
                        <ul className="mcp-tool-list" data-testid="mcp-tool-list">
                          {tools.map((tool) => (
                            <li className="mcp-tool" key={tool.name} data-testid="mcp-tool">
                              <div className="mcp-tool-main">
                                <span className="mcp-tool-name mono">{tool.name}</span>
                                <span className="mcp-tool-description">{tool.description}</span>
                              </div>
                              <button
                                type="button"
                                className="btn btn-small"
                                disabled={busy !== null}
                                onClick={() => void ask(server, tool)}
                                data-testid="mcp-tool-call"
                              >
                                Call
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {records.length > 0 && (
          <>
            <h3 className="mcp-records-title">This session</h3>
            <ul className="mcp-records" data-testid="mcp-records">
              {records.map((record) => (
                <li
                  className={`mcp-record mcp-record-${record.status}`}
                  key={record.approvalId}
                  data-testid="mcp-record"
                >
                  <div className="mcp-record-head">
                    <span className="mcp-record-status" data-testid="mcp-record-status">
                      {record.status}
                    </span>
                    <span className="mcp-record-tool">
                      {record.serverName} · <span className="mono">{record.tool}</span>
                    </span>
                  </div>
                  <pre className="mcp-json" data-testid="mcp-record-args">
                    {JSON.stringify(record.args, null, 2)}
                  </pre>
                  {record.result !== undefined && (
                    <pre className="mcp-json" data-testid="mcp-approval-result">
                      {JSON.stringify(record.result, null, 2)}
                    </pre>
                  )}
                  {record.error !== undefined && (
                    <p className="sidebar-error" data-testid="mcp-record-error">
                      {record.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Parses the argument box. Returns the object, or the sentence to show instead.
 *
 * A tool's arguments are an object by MCP's own shape, so an array or a bare string is
 * refused here rather than sent and rejected by every server individually.
 */
function parseArgs(text: string): Record<string, unknown> | string {
  const trimmed = text.trim() === "" ? "{}" : text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "The arguments must be valid JSON.";
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "The arguments must be a JSON object, for example {}.";
  }
  return Object.fromEntries(Object.entries(parsed));
}
