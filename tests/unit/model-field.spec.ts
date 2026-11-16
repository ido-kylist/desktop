import { describe, expect, it } from "vitest";
import {
  isModelInCatalog,
  type ModelCatalog,
  suggestDeploymentModel,
} from "../../src/renderer/src/lib/models";

/**
 * Two pure decisions behind the free-text model field:
 *  - does the typed id appear in the endpoint's catalogue (drives an honest note), and
 *  - what id is the provider asking for when it rejects a bare one.
 *
 * The second one exists because Sciforium's catalog advertises `deepseek-ai/…` while its
 * completions endpoint demands `/deployments/{target}/deepseek-ai/…`. Guessing wrong here
 * produces a double prefix, which is worse than no suggestion at all.
 */
const ready: ModelCatalog = {
  state: "ready",
  source: "remote",
  note: "Read from the configured endpoint.",
  options: [
    { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", ownedBy: "sciforium" },
    { id: "mock/text", ownedBy: "cleon-mock" },
  ],
};

const PROVIDER_MESSAGE =
  '{"message":"Invalid model deployment target","code":"INVALID_DEPLOYMENT_TARGET",' +
  '"details":"Model must be prefixed with \\"/deployments/{serverless|poolId}/\\"; the bare model format is no longer supported."}';

describe("isModelInCatalog", () => {
  it("is true for an id the endpoint lists", () => {
    expect(isModelInCatalog(ready, "deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe(true);
  });

  it("is false for an id the endpoint does not list", () => {
    expect(isModelInCatalog(ready, "/deployments/serverless/deepseek-ai/whatever")).toBe(false);
  });

  it("trims, so a trailing space does not read as unknown", () => {
    expect(isModelInCatalog(ready, "  mock/text  ")).toBe(true);
  });

  it("is false for empty input", () => {
    expect(isModelInCatalog(ready, "   ")).toBe(false);
  });

  it.each([
    ["loading", { state: "loading" } as ModelCatalog],
    ["empty", { state: "empty", source: "remote", note: "none" } as ModelCatalog],
    ["error", { state: "error", error: { code: "INTERNAL", message: "x" } } as ModelCatalog],
  ])("is false while the catalogue is %s", (_label, catalog) => {
    expect(isModelInCatalog(catalog, "mock/text")).toBe(false);
  });
});

describe("suggestDeploymentModel", () => {
  it("prefixes a bare id with the concrete pool the provider named", () => {
    expect(
      suggestDeploymentModel(
        'Model must be prefixed with "/deployments/d62861ef/"; bare is unsupported',
        "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      ),
    ).toBe("/deployments/d62861ef/deepseek-ai/DeepSeek-V4.1-Flash-1017");
  });

  it("falls back to `serverless` when the provider only shows the template", () => {
    // `{serverless|poolId}` must not be read as a literal target.
    expect(suggestDeploymentModel(PROVIDER_MESSAGE, "deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe(
      "/deployments/serverless/deepseek-ai/DeepSeek-V4.1-Flash-1017",
    );
  });

  it("never double-prefixes an id that already carries one", () => {
    expect(
      suggestDeploymentModel(PROVIDER_MESSAGE, "/deployments/serverless/deepseek-ai/x"),
    ).toBeNull();
  });

  it("tolerates a leading slash on the typed id", () => {
    expect(suggestDeploymentModel(PROVIDER_MESSAGE, "/mock/text")).toBe(
      "/deployments/serverless/mock/text",
    );
  });

  it("says nothing when the error is unrelated", () => {
    expect(suggestDeploymentModel("429 Too many requests", "mock/text")).toBeNull();
  });

  it("says nothing when the model is blank", () => {
    expect(suggestDeploymentModel(PROVIDER_MESSAGE, "   ")).toBeNull();
  });

  it("still offers a fix when the message names a prefix but no error code", () => {
    expect(suggestDeploymentModel('use "/deployments/pool9/" first', "m")).toBe(
      "/deployments/pool9/m",
    );
  });
});
