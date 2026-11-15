import { describe, expect, it } from "vitest";
import { MOCK_BASE_URL, resolveBaseUrl } from "../../src/main/api/client.js";
import { AppError } from "../../src/main/errors.js";

/**
 * The one place that decides where inference lives.
 *
 * Four sources in a fixed order, and each boundary is worth a test because every
 * one of them is a way to send a user's message to the wrong server: the
 * environment for a one-off run, the stored setting the user typed, the local mock
 * that only exists while unpackaged, and the refusal that must never be a silent
 * fallback in a shipped build.
 *
 * The stored value is injected, never read from the database here — that is what
 * makes these assertions possible without a database at all.
 */

interface ResolveInput {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  storedBaseUrl?: string | null;
}

/** Returns what `resolveBaseUrl` threw, so the failure itself can be inspected. */
function thrownBy(run: () => string): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("resolveBaseUrl returned a URL where it should have thrown");
}

const NO_PROVIDER = "No provider configured. Open Settings and add your base URL.";

describe("resolveBaseUrl precedence", () => {
  it("1. takes CLEON_API_BASE over both the stored value and the mock", () => {
    const input: ResolveInput = {
      isPackaged: true,
      env: { CLEON_API_BASE: "https://env.example.com" },
      storedBaseUrl: "https://stored.example.com",
    };

    expect(resolveBaseUrl(input)).toBe("https://env.example.com");
  });

  it("2. takes the stored base URL when the environment is unset", () => {
    const input: ResolveInput = {
      isPackaged: true,
      env: {},
      storedBaseUrl: "https://stored.example.com",
    };

    expect(resolveBaseUrl(input)).toBe("https://stored.example.com");
  });

  it("2b. takes the stored base URL over the mock, so a dev build honours Settings", () => {
    const input: ResolveInput = {
      isPackaged: false,
      env: {},
      storedBaseUrl: "https://stored.example.com",
    };

    expect(resolveBaseUrl(input)).toBe("https://stored.example.com");
  });

  it("3. falls back to the mock while unpackaged, with nothing stored", () => {
    expect(resolveBaseUrl({ isPackaged: false, env: {} })).toBe(MOCK_BASE_URL);
    expect(resolveBaseUrl({ isPackaged: false, env: {}, storedBaseUrl: null })).toBe(MOCK_BASE_URL);
  });

  it("4. refuses to guess when packaged with nothing configured, and says what to do", () => {
    // A shipped build answering from a localhost fixture would be indistinguishable
    // from a working app, so the only acceptable outcome is a refusal that tells the
    // user where the fix is.
    const error = thrownBy(() =>
      resolveBaseUrl({ isPackaged: true, env: {}, storedBaseUrl: null }),
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("INTERNAL");
    expect((error as AppError).message).toBe(NO_PROVIDER);
  });
});

describe("resolveBaseUrl normalisation", () => {
  it("drops trailing slashes from the environment and from the stored value", () => {
    expect(
      resolveBaseUrl({ isPackaged: true, env: { CLEON_API_BASE: "https://env.example.com///" } }),
    ).toBe("https://env.example.com");

    expect(
      resolveBaseUrl({ isPackaged: true, env: {}, storedBaseUrl: "https://stored.example.com/" }),
    ).toBe("https://stored.example.com");
  });

  it("trims whitespace around a configured URL", () => {
    // A paste out of a terminal or a password manager routinely carries one.
    expect(
      resolveBaseUrl({ isPackaged: true, env: { CLEON_API_BASE: "  https://env.example.com  " } }),
    ).toBe("https://env.example.com");
  });

  it("treats blank values as unset rather than as a configured server", () => {
    // An empty string must not resolve to "the base URL is ''" — a request to
    // `/v1/models` with no host is a confusing failure, not a configuration.
    expect(
      resolveBaseUrl({ isPackaged: false, env: { CLEON_API_BASE: "   " }, storedBaseUrl: "  " }),
    ).toBe(MOCK_BASE_URL);

    const error = thrownBy(() =>
      resolveBaseUrl({ isPackaged: true, env: { CLEON_API_BASE: "" }, storedBaseUrl: "" }),
    );
    expect((error as AppError).message).toBe(NO_PROVIDER);
  });
});
