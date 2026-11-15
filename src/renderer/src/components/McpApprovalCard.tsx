import type { McpTool } from "@shared/ipc-contract";

/**
 * One tool call, waiting for a human.
 *
 * The card is the entire approval gate as a user sees it: the server, the tool, the
 * arguments pretty-printed, and two buttons. It is rendered from a request this window
 * made, because nothing else in this phase can ask for a tool call — there is no auto-call
 * path to intercept yet.
 *
 * The arguments are shown in full on purpose. A gate that hides what it is gating is not a
 * gate; the only thing this app does not do is write them to a log.
 */

export interface McpApprovalRequest {
  approvalId: string;
  serverId: string;
  serverName: string;
  tool: string;
  args: Record<string, unknown>;
}

export function McpApprovalCard({
  request,
  tools,
  busy,
  onResolve,
}: {
  request: McpApprovalRequest;
  /** What the server advertises, so the card can say what the tool is for. */
  tools: readonly McpTool[];
  busy: boolean;
  onResolve: (allow: boolean) => void;
}): React.JSX.Element {
  const tool = tools.find((candidate) => candidate.name === request.tool);

  return (
    <section
      className="mcp-approval"
      role="alertdialog"
      aria-label="Tool call awaiting approval"
      data-testid="mcp-approval-card"
    >
      <header className="mcp-approval-head">
        <span className="mcp-kicker">Tool call awaiting approval</span>
        <h3 className="mcp-approval-title">
          <span data-testid="mcp-approval-server">{request.serverName}</span>
          <span className="mcp-dot">·</span>
          <span className="mono" data-testid="mcp-approval-tool">
            {request.tool}
          </span>
        </h3>
        {tool !== undefined && tool.description !== "" && (
          <p className="mcp-note">{tool.description}</p>
        )}
      </header>

      <pre className="mcp-json" data-testid="mcp-approval-json">
        {JSON.stringify(request.args, null, 2)}
      </pre>

      <p className="mcp-note">
        Nothing has run. This call runs once, only if you allow it, and every call asks again.
      </p>

      <div className="mcp-approval-actions">
        <button
          type="button"
          className="btn btn-small"
          disabled={busy}
          onClick={() => onResolve(true)}
          data-testid="mcp-approval-allow"
        >
          Allow
        </button>
        <button
          type="button"
          className="btn btn-small btn-stop"
          disabled={busy}
          onClick={() => onResolve(false)}
          data-testid="mcp-approval-deny"
        >
          Deny
        </button>
      </div>
    </section>
  );
}
