import type { IpcError } from "@shared/ipc-contract";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  type ArtifactHistoryView,
  type ArtifactView,
  artifactHistoryKey,
  artifactListKey,
  useArtifactHistory,
  useArtifacts,
} from "../hooks/use-artifacts";
import { buildCatalog, type Catalog } from "../lib/catalogs";
import { saveArtifact, toIpcError } from "../lib/ipc";

/**
 * Versioned artifacts for the thread on screen (D8).
 *
 * The whole surface is one idea: **a save is an append**. Editing version 2 and pressing Save
 * writes version 3; version 2 stays exactly as it was, and the switcher can show it again.
 * That is why the editor shows the selected version's content and the Save button says which
 * version it will write — a form that looked identical whether it would overwrite or append
 * would be a trap.
 *
 * Three states, kept apart on purpose:
 *
 *  - **no thread** — an artifact belongs to a conversation. The panel says so instead of
 *    offering a Save button that main would refuse.
 *  - **empty list** — the thread has no artifacts; "New artifact" starts at version 1.
 *  - **failed read** — shown as the error it is, not as an empty list.
 *
 * The draft is local until Save: typing does not write a version, and every keystroke writing
 * one would turn the version switcher into a typing history.
 */
export function ArtifactsPanel({
  threadId,
  onClose,
}: {
  threadId: string | null;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const artifacts = useArtifacts(threadId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const history = useArtifactHistory(selectedId);

  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const catalog: Catalog<ArtifactView> = buildCatalog({
    loading: threadId !== null && artifacts.isPending,
    result: threadId === null ? [] : artifacts.data?.items,
    error: toIpcError(artifacts.error),
  });

  const loaded: ArtifactHistoryView | undefined = history.data;
  /**
   * Which artifact the editor was last seeded from.
   *
   * A ref rather than a `useState`, and the distinction is the whole bug it fixes: the effect
   * below must run when a *different* artifact is opened and must not run when the same
   * artifact's history is re-read. The re-read happens right after a save — and a seed on every
   * read would silently reset the form and wipe the "Saved v2." confirmation the user needs to
   * see.
   */
  const seededFor = useRef<string | null>(null);

  /**
   * The editor follows the artifact that was opened, and only when the load belongs to the
   * selection: a cached read for another artifact must not overwrite what is being typed.
   *
   * Nothing here resets on a thread change: the panel is keyed by thread in `App`, so
   * switching conversations remounts it and every piece of this state starts over. An effect
   * that reset the selection when `threadId` changed would be the same behaviour with more
   * places to get it wrong.
   */
  useEffect(() => {
    if (loaded === undefined || loaded.artifact.id !== selectedId) return;
    if (seededFor.current === loaded.artifact.id) return;

    seededFor.current = loaded.artifact.id;
    setDraftTitle(loaded.artifact.title);
    setDraftContent(loaded.latest.content);
    setViewVersion(loaded.latest.version);
    setSaved(null);
  }, [loaded, selectedId]);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: artifactListKey(threadId) });
  };

  const startNew = (): void => {
    seededFor.current = null;
    setSelectedId(null);
    setDraftTitle("");
    setDraftContent("");
    setViewVersion(null);
    setError(null);
    setSaved(null);
  };

  const select = (artifact: ArtifactView): void => {
    // Cleared so re-opening the artifact that is already selected re-seeds the form from its
    // latest version — the draft is a proposal, and abandoning it by clicking the row again is
    // a reasonable thing to expect.
    seededFor.current = null;
    setSelectedId(artifact.id);
    setError(null);
    setSaved(null);
  };

  const save = async (): Promise<void> => {
    const title = draftTitle.trim();
    if (threadId === null || title === "" || busy) return;

    setBusy(true);
    setError(null);
    const result = await saveArtifact({
      artifactId: selectedId,
      threadId,
      title,
      content: draftContent,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    // The response is the row that was written: the new version number, not a guess. Selecting
    // it re-reads the history so the switcher lists it, and the draft stays as saved —
    // `seededFor` is stamped so the refresh below cannot treat this as "a different artifact
    // was opened" and reset the form (and the confirmation with it).
    const artifactId = result.data.artifact.id;
    seededFor.current = artifactId;
    setSelectedId(artifactId);
    setSaved(result.data.version.version);
    setViewVersion(result.data.version.version);
    await Promise.all([
      refresh(),
      queryClient.invalidateQueries({ queryKey: artifactHistoryKey(artifactId) }),
    ]);
  };

  const selectedVersion =
    loaded === undefined
      ? undefined
      : (loaded.versions.find((version) => version.version === viewVersion) ?? loaded.latest);

  const viewingOld =
    selectedVersion !== undefined && selectedVersion.version !== loaded?.latest.version;
  const showEditor = selectedId === null || (loaded !== undefined && !viewingOld);

  return (
    <div className="library-backdrop" data-testid="artifacts-panel">
      <section className="library artifacts" role="dialog" aria-modal="true" aria-label="Artifacts">
        <header className="library-head">
          <h2>Artifacts</h2>
          <span className="mcp-kicker">every save is a new version</span>
          <button
            type="button"
            className="btn btn-small"
            aria-label="Close artifacts"
            onClick={onClose}
            data-testid="artifacts-close"
          >
            ✕
          </button>
        </header>

        {threadId === null && (
          <p className="sidebar-note muted" data-testid="artifacts-no-thread">
            Open a conversation first: an artifact belongs to a thread.
          </p>
        )}

        {threadId !== null && error !== null && (
          <p className="sidebar-error" role="alert" data-testid="artifacts-error">
            <span className="banner-code">{error.code}</span> {error.message}
          </p>
        )}

        {threadId !== null && catalog.state === "error" && (
          <p className="sidebar-error" role="alert" data-testid="artifacts-list-error">
            <span className="banner-code">{catalog.error.code}</span> {catalog.error.message}
          </p>
        )}

        {threadId !== null && catalog.state === "loading" && (
          <p className="sidebar-note muted">Loading artifacts…</p>
        )}

        {threadId !== null && catalog.state === "empty" && (
          <p className="sidebar-note muted" data-testid="artifacts-list-empty">
            No artifacts in this thread yet. Start one below; it saves as version 1.
          </p>
        )}

        {threadId !== null && catalog.state === "ready" && (
          <ul className="library-list" data-testid="artifact-list">
            {catalog.items.map((artifact) => (
              <li className="library-row" key={artifact.id} data-testid="artifact-row">
                <div className="library-row-main">
                  <span className="library-row-title">{artifact.title}</span>
                  <span className="library-row-meta" data-testid="artifact-row-version">
                    v{artifact.currentVersion}
                  </span>
                </div>
                <div className="library-row-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => select(artifact)}
                    data-testid="artifact-open"
                  >
                    Open
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {threadId !== null && (
          <>
            <div className="library-form-actions">
              <button
                type="button"
                className="btn btn-small"
                onClick={startNew}
                data-testid="artifact-new"
              >
                New artifact
              </button>
              {selectedId !== null && loaded !== undefined && (
                <span className="library-count" data-testid="artifact-current">
                  {loaded.artifact.title} · v{loaded.latest.version} of {loaded.versions.length}{" "}
                  versions
                </span>
              )}
            </div>

            {selectedId !== null && history.isPending && (
              <p className="sidebar-note muted">Loading versions…</p>
            )}

            {selectedId !== null && toIpcError(history.error) !== null && (
              <p className="sidebar-error" role="alert" data-testid="artifacts-history-error">
                <span className="banner-code">{toIpcError(history.error)?.code}</span>{" "}
                {toIpcError(history.error)?.message}
              </p>
            )}

            {loaded !== undefined && (
              <div className="artifact-versions" data-testid="artifact-versions">
                <span className="library-count">Version</span>
                <ul className="version-switcher">
                  {loaded.versions.map((version) => (
                    <li key={version.id}>
                      <button
                        type="button"
                        className="version-pill"
                        aria-current={version.version === selectedVersion?.version}
                        onClick={() => setViewVersion(version.version)}
                        data-testid="artifact-version"
                      >
                        v{version.version}
                        {version.version === loaded.latest.version ? " latest" : ""}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {loaded !== undefined && viewingOld && selectedVersion !== undefined && (
              <div className="artifact-readonly" data-testid="artifact-old-version">
                <div className="artifact-readonly-head">
                  <p className="field-note">
                    v{selectedVersion.version} is read-only. Saving writes v
                    {loaded.latest.version + 1} from the editor.
                  </p>
                  {/* Outside the form on purpose: the form is hidden while an old version is
                      on screen, and this is the only way back to it. */}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setViewVersion(loaded.latest.version)}
                    data-testid="artifact-back-latest"
                  >
                    Back to latest
                  </button>
                </div>
                <pre className="artifact-content">{selectedVersion.content}</pre>
              </div>
            )}

            {showEditor && (
              <form
                className="library-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <label className="library-field">
                  <span>Title</span>
                  <input
                    type="text"
                    value={draftTitle}
                    maxLength={200}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    data-testid="artifact-title"
                  />
                </label>
                <label className="library-field">
                  <span>Content</span>
                  <textarea
                    rows={8}
                    value={draftContent}
                    maxLength={200_000}
                    onChange={(event) => setDraftContent(event.target.value)}
                    data-testid="artifact-content-input"
                  />
                </label>
                <div className="library-form-actions">
                  <button
                    type="submit"
                    className="btn btn-small"
                    disabled={busy || draftTitle.trim() === ""}
                    data-testid="artifact-save"
                  >
                    {busy
                      ? "Saving…"
                      : selectedId === null
                        ? "Save v1"
                        : `Save v${(loaded?.latest.version ?? 0) + 1}`}
                  </button>
                  {saved !== null && (
                    <span className="ok" data-testid="artifact-saved">
                      Saved v{saved}.
                    </span>
                  )}
                </div>
              </form>
            )}
          </>
        )}
      </section>
    </div>
  );
}
