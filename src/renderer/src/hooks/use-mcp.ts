import type { ResponseOf } from "@shared/ipc-contract";
import { useQuery } from "@tanstack/react-query";
import { listMcpServers } from "../lib/ipc";

/**
 * The MCP panel's server read (D7).
 *
 * Deliberately not polled. A server's status moves for exactly two reasons — a request this
 * window made (add, kill, list tools, resolve) and a crash — and every one of those is a
 * mutation the panel already invalidates on. A timer would add a second source of truth for
 * the same fact, and in a test it would be a race.
 */

export type McpServerSummary = ResponseOf<"mcp.listServers">["items"][number];

export const MCP_SERVER_LIST_KEY = ["mcp.listServers"] as const;

export function useMcpServers() {
  return useQuery({
    queryKey: MCP_SERVER_LIST_KEY,
    queryFn: () => listMcpServers(),
    retry: false,
  });
}
