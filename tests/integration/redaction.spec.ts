import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { streamChatCompletion } from "../../src/main/api/client.js";
import { type SecretBackend, type SecretStore, SecretsService } from "../../src/main/secrets.js";

/**
 * The product's central claim is that the API key never leaves the main process.
 * These tests try to falsify it with a canary string: if the key can be found in
 * a persisted byte, a masked value, a URL or a request body, they fail.
 *
 * The canary is deliberately shaped like a real key so a naive redaction that only
 * strips a prefix still gets caught.
 */
const CANARY = "sk-CANARY-9f3a2b7c1d4e5f60718293a4b5c6d7e8f9012345";

class ReversingBackend implements SecretBackend {
  available(): boolean {
    return true;
  }
  encrypt(plain: string): string {
    return Buffer.from(plain, "utf8").toString("base64");
  }
  decrypt(cipher: string): string {
    return Buffer.from(cipher, "base64").toString("utf8");
  }
}

function fileStore(dir: string): SecretStore {
  const file = join(dir, "secret.bin");
  return {
    async read() {
      try {
        return await readFile(file, "utf8");
      } catch {
        return null;
      }
    },
    async write(value: string) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(file, value, { mode: 0o600 });
    },
    async clear() {
      const { unlink } = await import("node:fs/promises");
      await unlink(file).catch(() => undefined);
    },
  };
}

/** Every byte of every file in the directory, concatenated as latin1 for a raw scan. */
async function allBytes(dir: string): Promise<string> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    out.push((await readFile(path)).toString("latin1"));
  }
  return out.join("\n");
}

describe("secret redaction", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  async function service(): Promise<{ svc: SecretsService; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "cleon-redact-"));
    dirs.push(dir);
    return { svc: new SecretsService(new ReversingBackend(), fileStore(dir)), dir };
  }

  it("round-trips the key, so the later assertions are not vacuous", async () => {
    const { svc } = await service();
    await svc.setApiKey(CANARY);
    expect(await svc.getApiKey()).toBe(CANARY);
    expect(await svc.hasKey()).toBe(true);
  });

  it("stores ciphertext only — the plaintext key is nowhere on disk", async () => {
    const { svc, dir } = await service();
    await svc.setApiKey(CANARY);

    const raw = await allBytes(dir);
    expect(raw).not.toContain(CANARY);
    // And the storage is genuinely encrypted, not merely absent.
    expect(raw).toContain(new ReversingBackend().encrypt(CANARY));
  });

  it("never puts the key in the masked value", async () => {
    const { svc } = await service();
    await svc.setApiKey(CANARY);

    const masked = await svc.masked();
    expect(masked).toBe(`••••${CANARY.slice(-4)}`);
    expect(masked).not.toContain(CANARY.slice(0, -4));
  });

  it("sends the key as a Bearer header only — never in the URL or the body", async () => {
    const { svc, dir } = await service();
    await svc.setApiKey(CANARY);

    const seen: { url: string; body: string; auth: string | null }[] = [];

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
        auth: new Headers(init?.headers).get("authorization"),
      });
      // 402 so the client maps an error and returns quickly; we only care about the request.
      return new Response(JSON.stringify({ error: { code: "BUDGET_EXCEEDED", message: "no" } }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const outcome = await streamChatCompletion({
      config: { baseUrl: "http://127.0.0.1:4790", apiKey: CANARY },
      model: "mock/text",
      messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal,
      onDelta: () => undefined,
      fetchImpl: fakeFetch,
    }).catch((err: unknown) => err);

    expect(seen).toHaveLength(1);
    const request = seen[0];
    if (!request) throw new Error("no request captured");
    expect(request.auth).toBe(`Bearer ${CANARY}`);
    expect(request.url).not.toContain(CANARY);
    expect(request.body).not.toContain(CANARY);

    // Whatever came back — an outcome or a thrown AppError — must not echo the key.
    expect(JSON.stringify(outcome)).not.toContain(CANARY);

    // Nothing on disk gained the key either.
    expect(await allBytes(dir)).not.toContain(CANARY);
  });
});
