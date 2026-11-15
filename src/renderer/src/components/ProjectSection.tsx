import type { IpcError } from "@shared/ipc-contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PROJECT_LIST_KEY, useProjects } from "../hooks/use-projects";
import { THREAD_LIST_KEY } from "../hooks/use-thread-list";
import { buildCatalog, type Catalog } from "../lib/catalogs";
import { createProject, toIpcError, updateProject } from "../lib/ipc";

/**
 * The sidebar's projects section (D6): create, rename, archive, and pick the project the
 * thread list is filtered by.
 *
 * Selection is the parent's state, not this component's: the same id filters the thread
 * list (here) and files a new chat (in App), and two copies of it would drift.
 *
 * Every write is a contract call followed by an invalidation of both lists. Archiving a
 * project is not a delete — the threads filed under it survive and reappear under "All
 * threads" — so the thread list has to be re-read with it, not left showing a filter
 * that no longer exists.
 *
 * The four read states are drawn apart on purpose: a failed read is an error with a
 * code, never an empty section that reads as "you have no projects".
 */

export function ProjectSection({
  selectedProjectId,
  onSelect,
}: {
  selectedProjectId: string | null;
  onSelect: (projectId: string | null) => void;
}): React.JSX.Element {
  const projects = useProjects();
  const queryClient = useQueryClient();

  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<IpcError | null>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: PROJECT_LIST_KEY });
    await queryClient.invalidateQueries({ queryKey: THREAD_LIST_KEY });
  };

  const create = async (): Promise<void> => {
    const name = newName.trim();
    if (name === "" || busy) return;

    setBusy(true);
    setActionError(null);
    const result = await createProject({ name });
    setBusy(false);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    setNewName("");
    // Selecting what was just made is the only way the user sees the new, empty project
    // rather than a list that looks exactly as it did before.
    onSelect(result.data.id);
    await refresh();
  };

  const commitRename = async (projectId: string): Promise<void> => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (name === "") return;

    setBusy(true);
    setActionError(null);
    const result = await updateProject({ projectId, name });
    setBusy(false);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    await refresh();
  };

  const archive = async (projectId: string): Promise<void> => {
    setBusy(true);
    setActionError(null);
    const result = await updateProject({ projectId, archived: true });
    setBusy(false);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    // The filter would otherwise keep pointing at a project that is gone from the list,
    // and the thread list would look empty for no reason on screen.
    if (selectedProjectId === projectId) onSelect(null);
    await refresh();
  };

  const catalog: Catalog<{ id: string; name: string; threadCount: number }> = buildCatalog({
    loading: projects.isPending,
    result: projects.data?.items,
    error: toIpcError(projects.error),
  });

  return (
    <section className="projects" aria-label="Projects" data-testid="project-section">
      <div className="projects-head">
        <span>Projects</span>
      </div>

      <form
        className="project-new-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          type="text"
          className="project-new"
          aria-label="New project name"
          placeholder="New project…"
          value={newName}
          maxLength={120}
          onChange={(event) => setNewName(event.target.value)}
          data-testid="project-new"
        />
        <button
          type="submit"
          className="btn btn-small"
          disabled={busy || newName.trim() === ""}
          data-testid="project-create"
        >
          Add
        </button>
      </form>

      {actionError !== null && (
        <p className="sidebar-error" role="alert" data-testid="project-error">
          <span className="banner-code">{actionError.code}</span> {actionError.message}
        </p>
      )}

      {catalog.state === "loading" && <p className="sidebar-note muted">Loading projects…</p>}

      {catalog.state === "error" && (
        <p className="sidebar-error" role="alert" data-testid="project-list-error">
          <span className="banner-code">{catalog.error.code}</span> {catalog.error.message}
        </p>
      )}

      {catalog.state === "empty" && (
        <p className="sidebar-note muted" data-testid="project-list-empty">
          No projects yet.
        </p>
      )}

      {/*
        The reset is always on screen, even with no projects and even while the read is
        loading: it is a filter, not a project, and a filter a user cannot undo is how a
        sidebar ends up showing nothing with no way back.
      */}
      <ul className="project-list" data-testid="project-list">
        <li className="project-row">
          <button
            type="button"
            className="project-name"
            aria-current={selectedProjectId === null}
            onClick={() => onSelect(null)}
            data-testid="project-all"
          >
            All threads
          </button>
        </li>

        {catalog.state === "ready" &&
          catalog.items.map((project) => (
            <li className="project-row" key={project.id}>
              {renamingId === project.id ? (
                <input
                  type="text"
                  className="project-rename"
                  aria-label={`Rename ${project.name}`}
                  // Focused on mount rather than with `autoFocus`, which the a11y lint
                  // rule (rightly) dislikes as a blanket attribute. This input only
                  // exists because the user asked to rename, so the caret belongs in it.
                  ref={(node) => node?.focus()}
                  value={renameValue}
                  maxLength={120}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => void commitRename(project.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitRename(project.id);
                    }
                    if (event.key === "Escape") setRenamingId(null);
                  }}
                  data-testid="project-rename"
                />
              ) : (
                <button
                  type="button"
                  className="project-name"
                  aria-current={selectedProjectId === project.id}
                  onClick={() => onSelect(project.id)}
                >
                  <span className="project-name-text">{project.name}</span>
                  <span className="project-count">{project.threadCount}</span>
                </button>
              )}

              <button
                type="button"
                className="project-action"
                aria-label={`Rename ${project.name}`}
                title="Rename project"
                disabled={busy}
                onClick={() => {
                  setRenamingId(project.id);
                  setRenameValue(project.name);
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className="project-action"
                aria-label={`Archive ${project.name}`}
                title="Archive project"
                disabled={busy}
                onClick={() => void archive(project.id)}
              >
                ⤓
              </button>
            </li>
          ))}
      </ul>
    </section>
  );
}
