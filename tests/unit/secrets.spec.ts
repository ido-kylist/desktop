import { describe, expect, it } from "vitest";
import { AppError } from "../../src/main/errors";
import { type SecretBackend, type SecretStore, SecretsService } from "../../src/main/secrets";

/**
 * The backend here reverses the string. That is not encryption and is not meant to
 * be — these tests are about wiring, ordering and failure modes, and cryptography
 * is the one thing this module delegates wholesale.
 */
class ReverseBackend implements SecretBackend {
  availableCalls = 0;
  encryptCalls = 0;
  decryptCalls = 0;

  constructor(private readonly secure = true) {}

  available(): boolean {
    this.availableCalls += 1;
    return this.secure;
  }

  encrypt(plain: string): string {
    this.encryptCalls += 1;
    return [...plain].reverse().join("");
  }

  decrypt(cipher: string): string {
    this.decryptCalls += 1;
    return [...cipher].reverse().join("");
  }
}

class MemoryStore implements SecretStore {
  value: string | null = null;
  writes: string[] = [];
  clears = 0;

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(value: string): Promise<void> {
    this.writes.push(value);
    this.value = value;
  }

  async clear(): Promise<void> {
    this.clears += 1;
    this.value = null;
  }
}

const KEY = "sk-test-9f8e7d6c5b4a3210";
const MASK = "••••";

interface Rig {
  subject: SecretsService;
  backend: ReverseBackend;
  store: MemoryStore;
}

function createRig(secure = true): Rig {
  const backend = new ReverseBackend(secure);
  const store = new MemoryStore();
  return { subject: new SecretsService(backend, store), backend, store };
}

/** Returns the AppError the call threw, failing the test if it resolved or threw something else. */
async function appErrorFrom(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the call to fail, but it resolved");
}

describe("SecretsService", () => {
  describe("setApiKey", () => {
    it("round-trips a key through the injected backend", async () => {
      const { subject, store } = createRig();

      await subject.setApiKey(KEY);

      expect(store.writes).toHaveLength(1);
      expect(await subject.getApiKey()).toBe(KEY);
    });

    it("persists ciphertext, never the plaintext key", async () => {
      const { subject, store } = createRig();

      await subject.setApiKey(KEY);

      expect(store.value).not.toBe(KEY);
      expect(store.value).toBe([...KEY].reverse().join(""));
      expect(store.value ?? "").not.toContain(KEY);
    });

    it("trims surrounding whitespace before storing", async () => {
      const { subject, store } = createRig();

      await subject.setApiKey(`  ${KEY}\n`);

      expect(await subject.getApiKey()).toBe(KEY);
      expect(store.value).toBe([...KEY].reverse().join(""));
    });

    it("rejects an empty key as BAD_REQUEST and writes nothing", async () => {
      const { subject, backend, store } = createRig();

      const error = await appErrorFrom(() => subject.setApiKey(""));

      expect(error.code).toBe("BAD_REQUEST");
      expect(store.writes).toHaveLength(0);
      expect(backend.encryptCalls).toBe(0);
    });

    it("rejects a whitespace-only key as BAD_REQUEST and writes nothing", async () => {
      const { subject, store } = createRig();

      const error = await appErrorFrom(() => subject.setApiKey(" \n\t  \r\n "));

      expect(error.code).toBe("BAD_REQUEST");
      expect(store.writes).toHaveLength(0);
      expect(store.value).toBeNull();
    });

    it("overwrites a previously stored key", async () => {
      const { subject, store } = createRig();

      await subject.setApiKey("sk-first-0000");
      await subject.setApiKey(KEY);

      expect(store.writes).toHaveLength(2);
      expect(await subject.getApiKey()).toBe(KEY);
    });

    it("refuses to store anything in plaintext when secure storage is unavailable", async () => {
      const { subject, backend, store } = createRig(false);

      const error = await appErrorFrom(() => subject.setApiKey(KEY));

      expect(error.code).toBe("UNAUTHORIZED");
      expect(error.message).toBe("secure storage unavailable");
      expect(backend.encryptCalls).toBe(0);
      expect(store.writes).toHaveLength(0);
      expect(store.value).toBeNull();
    });
  });

  describe("getApiKey", () => {
    it("returns null when nothing has been stored", async () => {
      const { subject } = createRig();

      expect(await subject.getApiKey()).toBeNull();
    });

    it("returns the stored key", async () => {
      const { subject } = createRig();

      await subject.setApiKey(KEY);

      expect(await subject.getApiKey()).toBe(KEY);
    });

    it("treats an empty stored value as no key", async () => {
      const { subject, store, backend } = createRig();
      store.value = "";

      expect(await subject.getApiKey()).toBeNull();
      expect(backend.decryptCalls).toBe(0);
    });

    it("throws UNAUTHORIZED and decrypts nothing when secure storage is unavailable", async () => {
      const { subject, backend, store } = createRig(false);
      store.value = [...KEY].reverse().join("");

      const error = await appErrorFrom(() => subject.getApiKey());

      expect(error.code).toBe("UNAUTHORIZED");
      expect(error.message).toBe("secure storage unavailable");
      expect(backend.decryptCalls).toBe(0);
    });
  });

  describe("hasKey", () => {
    it("is false before a key is set and true after", async () => {
      const { subject } = createRig();

      expect(await subject.hasKey()).toBe(false);
      await subject.setApiKey(KEY);
      expect(await subject.hasKey()).toBe(true);
    });

    it("is false again after clearKey", async () => {
      const { subject } = createRig();

      await subject.setApiKey(KEY);
      await subject.clearKey();

      expect(await subject.hasKey()).toBe(false);
    });

    it("reports failure rather than claiming there is no key when storage is unavailable", async () => {
      const { subject } = createRig(false);

      const error = await appErrorFrom(() => subject.hasKey());

      expect(error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("clearKey", () => {
    it("removes the key", async () => {
      const { subject, store } = createRig();

      await subject.setApiKey(KEY);
      await subject.clearKey();

      expect(store.value).toBeNull();
      expect(await subject.getApiKey()).toBeNull();
    });

    it("is idempotent", async () => {
      const { subject, store } = createRig();

      await subject.setApiKey(KEY);
      await subject.clearKey();
      await subject.clearKey();

      expect(store.clears).toBe(2);
      expect(await subject.hasKey()).toBe(false);
    });

    it("works even when secure storage is unavailable, so a stale entry is removable", async () => {
      const store = new MemoryStore();
      await new SecretsService(new ReverseBackend(), store).setApiKey(KEY);

      const locked = new SecretsService(new ReverseBackend(false), store);
      const error = await appErrorFrom(() => locked.getApiKey());
      expect(error.code).toBe("UNAUTHORIZED");

      await locked.clearKey();

      expect(store.value).toBeNull();
    });
  });

  describe("masked", () => {
    it("returns null when no key is stored", async () => {
      const { subject } = createRig();

      expect(await subject.masked()).toBeNull();
    });

    it("returns the fixed mask plus the last four characters", async () => {
      const { subject } = createRig();

      await subject.setApiKey(KEY);

      expect(await subject.masked()).toBe(`${MASK}3210`);
    });

    it("discloses nothing but the last four characters", async () => {
      const { subject } = createRig();

      await subject.setApiKey(KEY);

      const masked = await subject.masked();
      expect(masked).not.toBe(KEY);
      expect(masked ?? "").not.toContain(KEY.slice(0, -4));
      expect(masked).toBe(`${MASK}${KEY.slice(-4)}`);
    });

    it("shows no tail at all for a key short enough that the tail is the key", async () => {
      const { subject } = createRig();

      await subject.setApiKey("abcd");
      expect(await subject.masked()).toBe(MASK);

      await subject.setApiKey("a");
      expect(await subject.masked()).toBe(MASK);
    });

    it("throws rather than masking a key it cannot decrypt", async () => {
      const { subject } = createRig(false);

      const error = await appErrorFrom(() => subject.masked());

      expect(error.code).toBe("UNAUTHORIZED");
      expect(error.message).toBe("secure storage unavailable");
    });
  });
});
