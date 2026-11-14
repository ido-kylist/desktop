import type { CleonApi, IpcError, ResponseOf } from "@shared/ipc-contract";
import { useCallback, useEffect, useState } from "react";

declare global {
  interface Window {
    cleon: CleonApi;
  }
}

type Info = ResponseOf<"app.info">;
type Health = ResponseOf<"db.health">;
type Ping = ResponseOf<"app.ping">;
type WordCount = ResponseOf<"scratch.wordCount">;

type Probe<T> =
  | { state: "loading" }
  | { state: "ok"; data: T }
  | { state: "error"; error: IpcError };

function describe(error: IpcError): string {
  return `${error.code}: ${error.message}`;
}

/**
 * D0 smoke surface. It exists to prove three things at a glance: the bridge is
 * present, the protocol versions agree, and the main process can reach SQLite.
 * Nothing here is product UI — D1 replaces it with the chat surface.
 */
export function App(): React.JSX.Element {
  const [info, setInfo] = useState<Probe<Info>>({ state: "loading" });
  const [health, setHealth] = useState<Probe<Health>>({ state: "loading" });
  const [pings, setPings] = useState<Ping[]>([]);
  const [scratchText, setScratchText] = useState("");
  const [scratch, setScratch] = useState<Probe<WordCount> | null>(null);

  const bridge = typeof window !== "undefined" ? window.cleon : undefined;

  useEffect(() => {
    if (!bridge) return;

    void bridge.invoke("app.info", {}).then((res) => {
      setInfo(res.ok ? { state: "ok", data: res.data } : { state: "error", error: res.error });
    });

    void bridge.invoke("db.health", {}).then((res) => {
      setHealth(res.ok ? { state: "ok", data: res.data } : { state: "error", error: res.error });
    });
  }, [bridge]);

  const ping = useCallback(async () => {
    if (!bridge) return;
    const res = await bridge.invoke("app.ping", { nonce: crypto.randomUUID() });
    if (res.ok) setPings((prev) => [res.data, ...prev].slice(0, 5));
  }, [bridge]);

  const countScratch = useCallback(async () => {
    if (!bridge) return;
    const res = await bridge.invoke("scratch.wordCount", { text: scratchText });
    setScratch(res.ok ? { state: "ok", data: res.data } : { state: "error", error: res.error });
  }, [bridge, scratchText]);

  const handshakeOk =
    bridge !== undefined &&
    info.state === "ok" &&
    info.data.protocolVersion === bridge.protocolVersion;

  return (
    <div className="shell">
      <header className="bar">
        <span className="mark" />
        <h1>Cleon</h1>
        <span className="tag">D0 · foundation</span>
      </header>

      <main>
        <section className="card">
          <h2>Bridge</h2>
          {!bridge && <p className="bad">window.cleon is missing — preload did not load.</p>}
          {bridge && (
            <>
              <p className={handshakeOk ? "ok" : "warn"}>
                {handshakeOk
                  ? `protocol v${bridge.protocolVersion} handshake OK`
                  : "protocol handshake not confirmed"}
              </p>
              <dl>
                <dt>app</dt>
                <dd>
                  {info.state === "ok"
                    ? `${info.data.name} ${info.data.version}`
                    : info.state === "error"
                      ? describe(info.error)
                      : "…"}
                </dd>
                <dt>electron</dt>
                <dd>{info.state === "ok" ? info.data.electron : "…"}</dd>
                <dt>chromium</dt>
                <dd>{info.state === "ok" ? info.data.chrome : "…"}</dd>
                <dt>node</dt>
                <dd>{info.state === "ok" ? info.data.node : "…"}</dd>
                <dt>platform</dt>
                <dd>{info.state === "ok" ? `${info.data.platform}/${info.data.arch}` : "…"}</dd>
                <dt>packaged</dt>
                <dd>{info.state === "ok" ? String(info.data.isPackaged) : "…"}</dd>
              </dl>
            </>
          )}
        </section>

        <section className="card">
          <h2>Local database</h2>
          {health.state === "loading" && <p className="muted">opening…</p>}
          {health.state === "error" && <p className="bad">{describe(health.error)}</p>}
          {health.state === "ok" && (
            <dl>
              <dt>schema</dt>
              <dd>v{health.data.schemaVersion}</dd>
              <dt>FTS5</dt>
              <dd className={health.data.fts5 ? "ok" : "bad"}>
                {health.data.fts5 ? "available" : "missing"}
              </dd>
              <dt>threads</dt>
              <dd>{health.data.threads}</dd>
              <dt>messages</dt>
              <dd>{health.data.messages}</dd>
            </dl>
          )}
        </section>

        <section className="card">
          <h2>Round trip</h2>
          <button type="button" className="btn" onClick={() => void ping()} disabled={!bridge}>
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
        </section>

        <section className="card">
          <h2>Word count</h2>
          <div>
            <textarea
              aria-label="Text to count"
              data-testid="word-count-input"
              rows={4}
              placeholder="Type or paste text"
              value={scratchText}
              onChange={(event) => setScratchText(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => void countScratch()}
            disabled={!bridge}
          >
            Count words
          </button>
          {scratch === null && <p className="muted">Nothing counted yet.</p>}
          {scratch?.state === "ok" && (
            <p data-testid="word-count-result">
              {scratch.data.words} words · {scratch.data.characters} characters
            </p>
          )}
          {scratch?.state === "error" && (
            <p className="bad" data-testid="word-count-error">
              {describe(scratch.error)}
            </p>
          )}
        </section>
      </main>

      <footer>
        <span>renderer is sandboxed · contextIsolation on · no node integration</span>
      </footer>
    </div>
  );
}
