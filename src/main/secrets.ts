import { AppError } from "./errors.js";

/**
 * The API key, encrypted at rest.
 *
 * Two things are deliberately absent here:
 *
 *  - Any Electron import. `safeStorage` is the production backend, but the logic
 *    under test is the policy, not the platform call, so both the encrypting
 *    primitive and the persistence are injected.
 *  - Any path back to the plaintext except `getApiKey()`. That method is for the
 *    main process to attach credentials to an outbound request; it is never
 *    exposed over IPC. The renderer gets `hasKey()` and `masked()` and nothing
 *    else (plan invariant 2).
 *
 * There is no plaintext fallback. If the platform cannot encrypt, the key is not
 * stored — an unusable key is recoverable, a leaked one is not.
 */

/** The platform primitive that turns plaintext into bytes at rest. */
export interface SecretBackend {
  /** False when the OS keychain/DPAPI/keyring is unreachable. */
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

/** Where the ciphertext lives between runs. Main-process only. */
export interface SecretStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

const MASK = "••••";
/** How many trailing characters `masked()` may disclose. */
const MASK_TAIL = 4;

export class SecretsService {
  constructor(
    private readonly backend: SecretBackend,
    private readonly store: SecretStore,
  ) {}

  /**
   * Stores the key encrypted. Whitespace around the key is trimmed — a paste
   * from a password manager routinely carries a trailing newline — and a key that
   * is empty once trimmed is rejected instead of being written as a blank secret.
   */
  async setApiKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed === "") {
      // Input validation first: it touches nothing, so a bad request stays a bad
      // request even when secure storage is also unavailable.
      throw new AppError("BAD_REQUEST", "API key must not be empty");
    }

    this.assertAvailable();
    await this.store.write(this.backend.encrypt(trimmed));
  }

  /** The plaintext key, for outbound requests in the main process. Never over IPC. */
  async getApiKey(): Promise<string | null> {
    this.assertAvailable();

    const cipher = await this.store.read();
    if (cipher === null || cipher === "") return null;
    return this.backend.decrypt(cipher);
  }

  /**
   * True exactly when `getApiKey()` would return a key: a store that answers
   * "yes" while the backend cannot decrypt would be a lie the UI acts on.
   */
  async hasKey(): Promise<boolean> {
    return (await this.getApiKey()) !== null;
  }

  /**
   * Deliberately unguarded: clearing is the recovery path. A key that can no
   * longer be decrypted must still be removable.
   */
  async clearKey(): Promise<void> {
    await this.store.clear();
  }

  /**
   * Display form: a fixed mask plus the last four characters, or null when there
   * is no key. A key short enough that its tail is most of its length is masked
   * with no tail at all — the point is to confirm the key, not to disclose it.
   */
  async masked(): Promise<string | null> {
    const key = await this.getApiKey();
    if (key === null) return null;
    return key.length > MASK_TAIL ? `${MASK}${key.slice(-MASK_TAIL)}` : MASK;
  }

  private assertAvailable(): void {
    if (!this.backend.available()) {
      throw new AppError("UNAUTHORIZED", "secure storage unavailable");
    }
  }
}

/**
 * Production wiring is slice D1b, not here: `safeStorage.isEncryptionAvailable()`
 * backs `available()`, encrypt/decrypt return base64 of the platform buffer, and
 * the store is the app's own file next to the database. Keeping that out of this
 * module is why it has no Electron import and why it is tested without one.
 */
