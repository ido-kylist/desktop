import { AppError } from "../errors.js";

/**
 * Cosine similarity, and the two conversions a vector needs to survive SQLite.
 *
 * Retrieval is a linear scan over stored vectors: read every chunk, score it, sort, take
 * the top k. That is O(n) in the corpus and it is the *right* complexity for this app —
 * a local knowledge base is tens of documents and a few thousand chunks, where a scan is
 * a few milliseconds and an ANN index would be a second structure to build, persist,
 * invalidate, and explain. ANN is explicitly out of scope; `docs/DECISIONS.md` says so in
 * as many words.
 *
 * The vectors are L2-normalised on the way in, which makes cosine a dot product. The
 * function below does not rely on that: it divides by the norms anyway, so a row written
 * before normalisation (or by a provider that returns unnormalised vectors) still scores
 * correctly. The cost is one square root per comparison, paid by nobody at this scale.
 */

/**
 * How alike two vectors are, in [-1, 1]. 1 is identical, 0 is orthogonal.
 *
 * A zero vector has no direction, so it has no similarity to anything: the answer is 0,
 * not `NaN`. That matters because a query the embedding provider could not vectorise would
 * otherwise poison every score, and a `NaN` sort is not stable.
 *
 * Different dimensions are an error rather than a truncation. Comparing the first 64 of
 * 1536 numbers would produce a plausible score that means nothing, and the caller would
 * have no way to tell that from a real one — so it is refused, by name, with both sizes.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new AppError("BAD_REQUEST", "vectors have different dimensions", {
      details: { reason: "dimension_mismatch", a: a.length, b: b.length },
    });
  }
  if (a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * A unit-length copy of `vector`, or the vector itself when it has no direction.
 *
 * The zero vector is returned unchanged: dividing by its norm would produce `NaN` in every
 * slot, and a `NaN` BLOB is both unreadable as a score and unequal to itself in any test.
 */
export function l2Normalise(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;

  if (sum === 0) return vector;

  const norm = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) out[index] = (vector[index] ?? 0) / norm;
  return out;
}

/**
 * The BLOB for a stored vector.
 *
 * Little-endian float32, which is what every platform this app ships on reads natively.
 * Float32 rather than Float64 to halve the bytes: an embedding is already an
 * approximation, and the 7 digits a 32-bit float keeps are far more than a cosine needs.
 */
export function encodeVector(vector: Float32Array): Buffer {
  // Through a `Uint8Array` view so `Buffer.from` **copies** the bytes. Passing the
  // underlying `ArrayBuffer` would share it, and the caller's array is still live.
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  return Buffer.from(bytes);
}

/**
 * A stored BLOB back into numbers, or a refusal.
 *
 * A blob whose byte length is not a multiple of four cannot be a float32 array, and
 * `Buffer` would happily reinterpret it as garbage. That is a corrupt row, not a scoring
 * difference, so it throws where the reader can see it.
 */
export function decodeVector(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new AppError("INTERNAL", "stored embedding is not a float32 array", {
      details: { bytes: blob.byteLength },
    });
  }

  // A private, 4-byte-aligned copy. `Buffer.prototype.slice` is a view, not a copy, so
  // reading a float array through it would alias the database driver's buffer — and a
  // view whose offset is not a multiple of four cannot be read as float32 at all.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
