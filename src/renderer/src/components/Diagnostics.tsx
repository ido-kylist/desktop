import type { IpcError, ResponseOf } from "@shared/ipc-contract";
import { useCallback, useEffect, useState } from "react";
import { bridge } from "../lib/ipc";

type Info = ResponseOf<"app.info">;
type Health = ResponseOf<"db.health">;
type Ping = ResponseOf<"app.ping">;

type Probe<T> =
  | { state: "loading" }
  | { state: "ok"; data: T }
  | { state: "error"; error: IpcError };

function describe(error: IpcError): string {
  return `${error.code}: ${error.message}`;
}

/**
 * The D0 smoke surface, kept as a status strip.
 *
 * `tests/e2e/boot.spec.ts` asserts the protocol handshake, the schema version, FTS5
 * and one real IPC round trip on every launch, and it is outside this slice's file
 * scope — so the strip stays until that spec is rewritten. It also earns its keep:
 * on a fresh machine it is the fastest answer to "is the bridge and the database
 * actually alive", without reading a log.
 */
export function Diagnostics(): React.JSX.Element {
  const [info, setInfo] = useState<Probe<Info>>({ state: "loading" });
  const [health, setHealth] = useState<Probe<Health>>({ state: "loading" });
  const [pings, setPings] = useState<Ping[]>([]);

  const api = bridge();

  useEffect(() => {
    if (!api) return;

    void api.invoke("app.info", {}).then((res) => {
      setInfo(res.ok ? { state: "ok", data: res.data } : { state: "error", error: res.error });
    });

    void api.invoke("db.health", {}).then((res) => {
      setHealth(res.ok ? { state: "ok", data: res.data } : { state: "error", error: res.error });
    });
  }, [api]);

  const ping = useCallback(async () => {
    if (!api) return;
    const res = await api.invoke("app.ping", { nonce: crypto.randomUUID() });
    if (res.ok) setPings((previous) => [res.data, ...previous].slice(0, 5));
  }, [api]);

  const handshakeOk =
    api !== undefined && info.state === "ok" && info.data.protocolVersion === api.protocolVersion;

  return (
    <footer className="diagnostics">
      <p className={handshakeOk ? "ok" : "warn"}>
        {api === undefined
          ? "window.cleon is missing — preload did not load."
          : handshakeOk
            ? `protocol v${api.protocolVersion} handshake OK`
            : "protocol handshake not confirmed"}
      </p>

      {info.state === "error" && <p className="bad">{describe(info.error)}</p>}

      <dl>
        <dt>schema</dt>
        <dd>{health.state === "ok" ? `v${health.data.schemaVersion}` : "…"}</dd>
        <dt>fts5</dt>
        <dd className={health.state === "ok" ? (health.data.fts5 ? "ok" : "bad") : "muted"}>
          {health.state === "ok" ? (health.data.fts5 ? "available" : "missing") : "…"}
        </dd>
        <dt>packaged</dt>
        <dd>{info.state === "ok" ? String(info.data.isPackaged) : "…"}</dd>
      </dl>

      <button type="button" className="btn btn-small" onClick={() => void ping()} disabled={!api}>
        Send ping
      </button>

      {pings.length === 0 ? (
        <p className="muted">No calls yet.</p>
      ) : (
        <ul className="pings">
          {pings.map((p) => (
            <li key={p.nonce}>
              <span className="mono">{p.nonce.slice(0, 8)}</span>
              <span className="muted"> seq {p.seq}</span>
              <span className="muted"> · {new Date(p.at).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </footer>
  );
}
