import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The mock's job is to be harder to consume than the real thing. This suite treats
 * it as a contract: if the fixtures drift or the framing breaks, D1's parser work
 * would be built against a lie, so the breakage is caught here first.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PORT = 4793;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | undefined;

async function waitForHealth(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("mock server did not become healthy");
}

interface Frame {
  raw: string;
  json: unknown | null;
  isDone: boolean;
}

async function readFrames(model: string): Promise<{ frames: Frame[]; status: number }> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: true }),
  });

  if (!res.ok || !res.body) return { frames: [], status: res.status };

  const text = await res.text();
  const frames = text
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const line = block.split("\n").find((l) => l.startsWith("data:"));
      const payload = (line ?? "").slice(5).trim();
      if (payload === "[DONE]") return { raw: payload, json: null, isDone: true };
      try {
        return { raw: payload, json: JSON.parse(payload) as unknown, isDone: false };
      } catch {
        return { raw: payload, json: null, isDone: false };
      }
    });

  return { frames, status: res.status };
}

function deltaOf(frame: Frame): Record<string, unknown> {
  const choices = (frame.json as { choices?: { delta?: Record<string, unknown> }[] } | null)
    ?.choices;
  return choices?.[0]?.delta ?? {};
}

beforeAll(async () => {
  server = spawn(process.execPath, ["mock/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FRAME_DELAY_MS: "0" },
    stdio: "ignore",
  });
  await waitForHealth();
});

afterAll(() => {
  server?.kill();
});

describe("mock SSE server", () => {
  it("streams text deltas and terminates with [DONE]", async () => {
    const { frames, status } = await readFrames("mock/text");
    expect(status).toBe(200);
    expect(frames.at(-1)?.isDone).toBe(true);

    const text = frames
      .map(deltaOf)
      .map((d) => d.content ?? "")
      .join("");
    expect(text).toBe("Hello from the mock.");
  });

  it("emits reasoning before content", async () => {
    const { frames } = await readFrames("mock/reasoning");
    const deltas = frames.map(deltaOf);

    const firstReasoning = deltas.findIndex((d) => d.reasoning_content);
    const firstContent = deltas.findIndex((d) => d.content);
    expect(firstReasoning).toBeGreaterThanOrEqual(0);
    expect(firstContent).toBeGreaterThan(firstReasoning);

    const reasoning = deltas.map((d) => d.reasoning_content ?? "").join("");
    expect(reasoning).toBe("The user wants the short answer.");
  });

  it("splits tool call arguments across frames that reassemble into valid JSON", async () => {
    const { frames } = await readFrames("mock/tool");

    const fragments: string[] = [];
    for (const frame of frames) {
      const calls = (deltaOf(frame).tool_calls ?? []) as {
        function?: { name?: string; arguments?: string };
      }[];
      for (const call of calls) {
        if (call.function?.arguments) fragments.push(call.function.arguments);
      }
    }

    expect(fragments.length).toBeGreaterThan(1);
    expect(JSON.parse(fragments.join(""))).toEqual({ city: "Lisbon" });
  });

  it("ends a truncated stream without [DONE] or a finish reason", async () => {
    const { frames } = await readFrames("mock/truncated");

    expect(frames.some((f) => f.isDone)).toBe(false);
    const hasFinish = frames.some((f) => {
      const choices = (f.json as { choices?: { finish_reason?: string | null }[] } | null)?.choices;
      return Boolean(choices?.[0]?.finish_reason);
    });
    expect(hasFinish).toBe(false);
    expect(frames.length).toBeGreaterThan(0);
  });

  it("returns 402 with a budget error code", async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/402", messages: [], stream: true }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUDGET_EXCEEDED");
  });

  it("returns 429 with a retry-after header", async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/429", messages: [], stream: true }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });
});
