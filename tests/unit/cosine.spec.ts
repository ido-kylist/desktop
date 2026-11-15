import { describe, expect, it } from "vitest";
import { AppError } from "../../src/main/errors.js";
import {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  l2Normalise,
} from "../../src/main/knowledge/cosine.js";

/**
 * The similarity function retrieval is built on, and the bytes it stores.
 *
 * These are the cases that decide whether search is trustworthy: identical texts must
 * score 1, unrelated ones close to 0, a vector with no direction must not produce `NaN`
 * (which would silently sort as neither greater nor smaller and make the ranking
 * arbitrary), and two vectors of different widths must be refused rather than compared.
 */

const vector = (values: readonly number[]): Float32Array => Float32Array.from(values);

function expectClose(actual: number, expected: number, epsilon = 1e-6): void {
  expect(Math.abs(actual - expected)).toBeLessThan(epsilon);
}

describe("cosine similarity", () => {
  it("is 1 for identical vectors", () => {
    expectClose(cosineSimilarity(vector([1, 2, 3]), vector([1, 2, 3])), 1);
    expectClose(cosineSimilarity(vector([0.5, -0.5]), vector([0.5, -0.5])), 1);
  });

  it("is 1 for a vector and a positive multiple of it", () => {
    // Cosine is about direction, not length: the provider's scale is not meaningful and a
    // document is not less relevant for having been embedded with longer numbers.
    expectClose(cosineSimilarity(vector([1, 2, 3]), vector([10, 20, 30])), 1);
  });

  it("is 0 for orthogonal vectors", () => {
    expectClose(cosineSimilarity(vector([1, 0]), vector([0, 1])), 0);
    expectClose(cosineSimilarity(vector([1, 2, 3]), vector([2, -1, 0])), 0);
  });

  it("is -1 for opposite vectors", () => {
    expectClose(cosineSimilarity(vector([1, 2]), vector([-1, -2])), -1);
  });

  it("is 0 when either side is the zero vector, not NaN", () => {
    // A vector with no direction has no similarity. Returning NaN would poison the sort:
    // every comparison against it is false, so its position in the ranking would depend on
    // the sort implementation rather than on the data.
    expect(cosineSimilarity(vector([0, 0, 0]), vector([1, 2, 3]))).toBe(0);
    expect(cosineSimilarity(vector([1, 2, 3]), vector([0, 0, 0]))).toBe(0);
    expect(cosineSimilarity(vector([0, 0]), vector([0, 0]))).toBe(0);
  });

  it("is 0 for two empty vectors rather than dividing by zero", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("refuses vectors of different dimensions, naming both sizes", () => {
    // Truncating to the shorter one would produce a plausible number that means nothing,
    // and nothing downstream could tell it from a real score.
    let caught: unknown;
    try {
      cosineSimilarity(vector([1, 2, 3]), vector([1, 2]));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    const error = caught as AppError;
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.details).toEqual({ reason: "dimension_mismatch", a: 3, b: 2 });
  });

  it("scores in the closed range the contract declares", () => {
    // Float arithmetic can land a hair outside [-1, 1]; the caller clamps, and this pins the
    // size of the error so a clamp of ±1 is provably enough.
    const pairs: [Float32Array, Float32Array][] = [
      [vector([1, 1, 1]), vector([1, 1, 1])],
      [vector([3, -4, 5]), vector([-2, 7, 1])],
      [vector([0.1, 0.2, 0.3]), vector([0.3, 0.2, 0.1])],
    ];

    for (const [a, b] of pairs) {
      const score = cosineSimilarity(a, b);
      expect(score).toBeGreaterThanOrEqual(-1.000001);
      expect(score).toBeLessThanOrEqual(1.000001);
    }
  });
});

describe("normalisation", () => {
  it("produces a unit vector", () => {
    const normalised = l2Normalise(vector([3, 4]));

    expectClose(normalised[0] ?? 0, 0.6);
    expectClose(normalised[1] ?? 0, 0.8);
    expectClose(cosineSimilarity(normalised, normalised), 1);
  });

  it("leaves the zero vector alone instead of filling it with NaN", () => {
    const zero = l2Normalise(vector([0, 0, 0]));

    expect(Array.from(zero)).toEqual([0, 0, 0]);
    // The same array, not a copy: there is nothing to scale, and a new one would only invite
    // a caller to think something was normalised.
    expect(zero).toBeInstanceOf(Float32Array);
  });

  it("is close to idempotent", () => {
    const once = l2Normalise(vector([1, -2, 3, -4]));
    const twice = l2Normalise(once);

    for (let index = 0; index < once.length; index += 1) {
      expectClose(twice[index] ?? 0, once[index] ?? 0, 1e-6);
    }
  });
});

describe("stored vectors", () => {
  it("round-trip through the BLOB unchanged", () => {
    const original = vector([0.5, -0.25, 1e-7, -42.5]);

    const decoded = decodeVector(encodeVector(original));

    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("store four bytes per number", () => {
    expect(encodeVector(vector([1, 2, 3])).byteLength).toBe(12);
  });

  it("refuse a blob whose length is not a multiple of four", () => {
    // A truncated or text-encoded value is a corrupt row; reading it as floats would produce
    // garbage vectors that score plausibly.
    expect(() => decodeVector(Buffer.from([1, 2, 3]))).toThrowError(AppError);
  });

  it("do not alias the source buffer", () => {
    // The database driver hands back a view of memory it may reuse. Reading through it
    // would let the next row overwrite a score that was already computed.
    const source = Buffer.from(encodeVector(vector([1, 2])));
    const decoded = decodeVector(source);
    source.fill(0);

    expect(Array.from(decoded)).toEqual([1, 2]);
  });
});
