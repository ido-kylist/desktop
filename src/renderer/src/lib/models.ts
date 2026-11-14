/**
 * D1 talks to one provider through the mock, and there is no model catalog yet — the
 * `models` table and a picker arrive with the sidebar slice. Until then the composer
 * offers the mock scenarios directly, which also makes the renderer's error states
 * reachable without a fault-injection flag: `mock/402` and `mock/429` are the two
 * failures the contract distinguishes.
 */
export const SELECTABLE_MODELS = [
  "mock/text",
  "mock/reasoning",
  "mock/tool",
  "mock/truncated",
  "mock/402",
  "mock/429",
] as const;

export const DEFAULT_MODEL = "mock/text";
