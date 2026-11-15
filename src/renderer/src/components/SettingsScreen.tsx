import type { IpcError } from "@shared/ipc-contract";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useModelCatalog } from "../hooks/use-model-catalog";
import { SETTINGS_KEY, useSettings } from "../hooks/use-settings";
import { clearApiKey, setApiKey, setSettings, toIpcError } from "../lib/ipc";
import { describeCatalog, type ModelCatalog } from "../lib/models";
import {
  isDirty,
  keyStatus,
  missingKeyNote,
  normalizeBaseUrl,
  providerForm,
} from "../lib/settings";

/**
 * The P0 provider surface: where a real endpoint and a real key are configured.
 *
 * Three deliberate choices:
 *
 * - The base URL has an explicit Save and a visible "Unsaved changes" line. Saving on
 *   blur would race the Test button (the click blurs the field), and a silent draft
 *   would be a trap: nothing on screen would say the app is still using the old URL.
 * - The key is write-only. It is sent and the input is cleared; what comes back is
 *   `hasKey` and the masked tail, which is all main will ever disclose.
 * - The model list is the same `models.list` the composer uses, so "Test connection"
 *   and the picker cannot tell two different stories about one endpoint.
 */
export function SettingsScreen({
  model,
  onModelChange,
  onClose,
}: {
  model: string;
  onModelChange: (model: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const settings = useSettings();
  const { catalog, probe, reload } = useModelCatalog();
  const queryClient = useQueryClient();

  /** Null means "follow what main saved"; a string is a draft the user is editing. */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [actionError, setActionError] = useState<IpcError | null>(null);
  const [probeResult, setProbeResult] = useState<ModelCatalog | null>(null);
  const [probing, setProbing] = useState(false);

  const form = settings.data === undefined ? null : providerForm(settings.data);
  const savedBaseUrl = form?.baseUrl ?? null;
  const baseUrl = draft ?? savedBaseUrl ?? "";
  const dirty = isDirty(baseUrl, savedBaseUrl);

  const loadError = toIpcError(settings.error);

  const saveBaseUrl = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving || !dirty) return;

    setSaving(true);
    setActionError(null);
    setSavedNotice(false);

    const result = await setSettings({ baseUrl: normalizeBaseUrl(baseUrl) });
    setSaving(false);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }

    // The response is what main accepted (it trims and normalises too). Showing it
    // rather than the draft is what keeps the field from claiming a value that was
    // changed on the way through.
    queryClient.setQueryData(SETTINGS_KEY, result.data);
    setDraft(null);
    setSavedNotice(true);
    // The catalogue belongs to the endpoint, and the endpoint just changed.
    await reload();
    setProbeResult(null);
  };

  const chooseModel = async (id: string): Promise<void> => {
    onModelChange(id);
    setActionError(null);

    const result = await setSettings({ defaultModel: id });
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    queryClient.setQueryData(SETTINGS_KEY, result.data);
  };

  const saveKey = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const key = keyDraft.trim();
    if (key === "" || keyBusy) return;

    setKeyBusy(true);
    setActionError(null);

    const result = await setApiKey(key);
    setKeyBusy(false);
    // Cleared whether or not it was accepted: the field is write-only, and leaving a
    // rejected secret on screen is the one thing this surface must never do.
    setKeyDraft("");
    if (!result.ok) {
      setActionError(result.error);
      return;
    }

    await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    // A key can be the difference between a refused list and an answered one.
    await reload();
  };

  const clearKey = async (): Promise<void> => {
    setKeyBusy(true);
    setActionError(null);

    const result = await clearApiKey();
    setKeyBusy(false);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }

    await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    await reload();
  };

  const testConnection = async (): Promise<void> => {
    setProbing(true);
    setActionError(null);

    // `probe` seeds the picker's cache with the same answer, so "Test connection"
    // and the select cannot end up describing two different endpoints.
    const result = await probe();
    setProbing(false);
    setProbeResult(result);
  };

  const catalogLine = describeCatalog(catalog);
  const probeLine = probeResult === null ? null : describeCatalog(probeResult);
  const missingKey = form === null ? null : missingKeyNote(form.hasKey);

  return (
    <section className="settings" aria-label="Settings" data-testid="settings">
      <header className="settings-head">
        <h2>Settings</h2>
        <p className="muted">
          The provider is called from the main process. The key is stored by the OS and never enters
          this window.
        </p>
        <button
          type="button"
          className="btn btn-small settings-done"
          onClick={onClose}
          data-testid="settings-done"
        >
          Done
        </button>
      </header>

      <div className="settings-body">
        {settings.isPending && (
          <p className="muted" data-testid="settings-loading">
            Loading settings…
          </p>
        )}

        {loadError !== null && (
          <div className="banner" role="alert" data-testid="settings-load-error">
            <div className="banner-main">
              <span className="banner-code">{loadError.code}</span>
              <span className="banner-message">{loadError.message}</span>
            </div>
            <button type="button" className="btn" onClick={() => void settings.refetch()}>
              Retry
            </button>
          </div>
        )}

        {actionError !== null && (
          <p className="settings-error" role="alert" data-testid="settings-action-error">
            <span className="banner-code">{actionError.code}</span> {actionError.message}
          </p>
        )}

        {form !== null && (
          <>
            <section className="settings-section">
              <h3>Provider</h3>
              <form onSubmit={(event) => void saveBaseUrl(event)}>
                <label className="field">
                  <span>Base URL</span>
                  <input
                    className="field-input"
                    aria-label="Base URL"
                    data-testid="base-url"
                    value={baseUrl}
                    placeholder="https://api.openai.com"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => {
                      setSavedNotice(false);
                      setDraft(event.target.value);
                    }}
                  />
                </label>
                <p className="field-note">
                  The API root, without <code>/v1</code>: Cleon appends <code>/v1/models</code> and{" "}
                  <code>/v1/chat/completions</code>. Any OpenAI-compatible endpoint works, for
                  example <code>https://api.openai.com</code>.
                </p>
                <div className="settings-actions">
                  <button
                    type="submit"
                    className="btn btn-small"
                    data-testid="save-base-url"
                    disabled={saving || !dirty}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  {dirty && (
                    <span className="warn" data-testid="base-url-dirty">
                      Unsaved changes
                    </span>
                  )}
                  {!dirty && savedNotice && (
                    <span className="ok" data-testid="base-url-saved">
                      Saved.
                    </span>
                  )}
                </div>
              </form>
            </section>

            <section className="settings-section">
              <h3>API key</h3>
              <p className="field-note">
                Stored:{" "}
                <span className="mono key-status" data-testid="key-masked">
                  {keyStatus(form.hasKey, form.masked)}
                </span>
              </p>
              <form onSubmit={(event) => void saveKey(event)}>
                <label className="field">
                  <span>Key</span>
                  <input
                    className="field-input"
                    type="password"
                    aria-label="API key"
                    data-testid="api-key"
                    value={keyDraft}
                    placeholder="sk-…"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setKeyDraft(event.target.value)}
                  />
                </label>
                <div className="settings-actions">
                  <button
                    type="submit"
                    className="btn btn-small"
                    data-testid="save-key"
                    disabled={keyBusy || keyDraft.trim() === ""}
                  >
                    {keyBusy ? "Saving…" : "Save key"}
                  </button>
                  {form.hasKey && (
                    <button
                      type="button"
                      className="btn btn-small"
                      data-testid="clear-key"
                      disabled={keyBusy}
                      onClick={() => void clearKey()}
                    >
                      Clear key
                    </button>
                  )}
                </div>
              </form>
              {missingKey !== null && (
                <p className="field-note warn" data-testid="key-missing">
                  {missingKey}
                </p>
              )}
            </section>

            <section className="settings-section">
              <h3>Model</h3>
              <label className="field">
                <span>Default model</span>
                <select
                  className="field-input"
                  aria-label="Default model"
                  data-testid="model-select"
                  value={model}
                  disabled={catalog.state !== "ready"}
                  onChange={(event) => void chooseModel(event.target.value)}
                >
                  {catalog.state === "ready" ? (
                    catalog.options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.id}
                      </option>
                    ))
                  ) : (
                    <option value={model}>{model}</option>
                  )}
                </select>
              </label>
              <p className={`field-note ${catalogLine.tone}`} data-testid="model-note">
                {catalogLine.text}
              </p>
            </section>

            <section className="settings-section">
              <h3>Connection</h3>
              <div className="settings-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  data-testid="test-connection"
                  disabled={probing}
                  onClick={() => void testConnection()}
                >
                  {probing ? "Testing…" : "Test connection"}
                </button>
                {probeResult !== null && probeLine !== null && (
                  <output
                    className={`field-note ${probeLine.tone}`}
                    data-testid="connection-result"
                  >
                    {probeLine.text}
                  </output>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </section>
  );
}
