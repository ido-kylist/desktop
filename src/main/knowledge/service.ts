import type { Citation, KnowledgeChunk, KnowledgeHit } from "@shared/ipc-contract";
import type { InferenceConfig } from "../api/client.js";
import { DEFAULT_EMBEDDING_MODEL, type EmbedInput, embedTexts } from "../api/embeddings.js";
import type { DrizzleDb } from "../db/client.js";
import {
  countChunks,
  type DocumentRow,
  deleteDocument,
  getChunk,
  getDocument,
  insertDocument,
  listChunksForSearch,
  listDocuments,
  toCitation,
} from "../db/repo-knowledge.js";
import { AppError } from "../errors.js";
import { chunkText } from "./chunking.js";
import { cosineSimilarity, decodeVector, encodeVector } from "./cosine.js";
import { collectSources, removeSource, storedPathFor } from "./sources.js";

/**
 * The knowledge base: ingest, retrieve, cite.
 *
 * Retrieval is a linear scan over the stored vectors — read, score, sort, take k. It is O(n)
 * in the corpus and it is the right shape for a local knowledge base of a few thousand
 * chunks, where the scan is a few milliseconds. An ANN index (HNSW, IVF, sqlite-vec) is
 * explicitly out of scope for this slice; `docs/DECISIONS.md` records why and what the
 * upgrade would cost. Nothing here pretends otherwise.
 *
 * **What a citation is.** Retrieval returns up to five chunks, and the ones that are actually
 * cited are persisted on the assistant message as four fields each — id, document id, title,
 * ordinal. The text is read back on demand (`readChunk`), because a message row carrying four
 * kilobytes of document text per turn would be a copy of the corpus that goes stale the
 * moment a document is re-indexed.
 *
 * **What a retrieval failure means.** `chat.send` calls `retrieve` before it writes anything,
 * so an embedding failure is a refusal with nothing persisted. That is the deliberate order:
 * a knowledge-backed turn that cannot reach the embedding provider is a turn the user should
 * be told about, not one that quietly proceeds with no context while pretending it had some.
 */

/** How many chunks an answer is grounded on. Five is small enough to read, large enough to answer from. */
export const TOP_K = 5;

export interface KnowledgeDeps {
  db: DrizzleDb;
  /** `<userData>/knowledge`. Created on first ingest; never written outside. */
  rootDir: string;
  /**
   * Read per call, not cached: the key can be replaced and the embedding model is a setting.
   * An unconfigured base URL surfaces here as `INTERNAL`, the same as the chat transport.
   */
  resolveConfig: () => Promise<{ config: InferenceConfig; model: string }>;
  /** Injected by tests; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
}

/** The system message a knowledge-backed turn is given, and the citations it may make. */
export interface KnowledgePrompt {
  /** Non-empty: the numbered block, ready to be a system message. */
  systemText: string;
  citations: Citation[];
}

export class KnowledgeService {
  private readonly db: DrizzleDb;
  private readonly rootDir: string;
  private readonly deps: KnowledgeDeps;

  constructor(deps: KnowledgeDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.rootDir = deps.rootDir;
  }

  /**
   * Copies, chunks, embeds and records each file.
   *
   * All enqueued files are embedded in one call per file, not one call per chunk: the
   * provider takes an array, and a forty-chunk document that cost forty requests would be
   * forty times the latency for the same vectors.
   *
   * One file failing takes the whole batch down before any row is written — the copies are
   * removed and nothing is indexed. A batch that indexed four of five files and then failed
   * would leave the panel saying "Added 4" with no way to tell which one is missing.
   */
  async addDocuments(paths: readonly string[]): Promise<DocumentRow[]> {
    const sources = await collectSources(paths, { rootDir: this.rootDir });

    try {
      const { config, model } = await this.deps.resolveConfig();
      const prepared: {
        source: (typeof sources)[number];
        chunks: string[];
        vectors: Float32Array[];
      }[] = [];

      for (const source of sources) {
        const chunks = chunkText(source.text);
        if (chunks.length === 0) {
          throw new AppError("BAD_REQUEST", `${source.title} has no text to index`, {
            details: { reason: "empty_document", filename: source.title },
          });
        }
        const vectors = await this.embed({ config, model, texts: chunks });
        prepared.push({ source, chunks, vectors });
      }

      /**
       * One transaction for the whole batch. A batch that indexed three of five files and
       * then failed would leave the panel saying "added 3" with no way to tell which two are
       * missing — and a row whose copy was cleaned up would be a document that lists but
       * never searches.
       */
      return this.db.transaction((tx) =>
        prepared.map(({ source, chunks, vectors }) =>
          insertDocument(tx, {
            id: source.id,
            title: source.title,
            sourcePath: source.sourcePath,
            mime: source.mime,
            bytes: source.bytes,
            chunks: chunks.map((text, ordinal) => {
              const vector = vectors[ordinal];
              if (vector === undefined) {
                // The provider returned fewer vectors than inputs; `embedTexts` refuses that,
                // so reaching here means the two lists disagreed some other way. Fail loudly
                // rather than write a chunk with no vector.
                throw new AppError("INTERNAL", "a chunk has no embedding", {
                  details: { filename: source.title, ordinal },
                });
              }
              return { text, embedding: encodeVector(vector), dim: vector.length };
            }),
          }),
        ),
      );
    } catch (error) {
      // Nothing was committed (the transaction rolled back), so the copies belong to no row.
      // Removing them keeps a refused call from accumulating bytes nobody points at.
      await Promise.all(sources.map((source) => removeSource(source.storedPath)));
      throw error;
    }
  }

  list(): { items: DocumentRow[]; total: number } {
    return listDocuments(this.db);
  }

  /**
   * The row, its chunks by cascade, and the copy on disk.
   *
   * The disk removal happens after the row is gone and its failure is tolerated by
   * `removeSource` (`force: true`): a missing file is already the desired state, and rolling
   * back a database delete because a temp file was cleaned up externally would be worse than
   * the leaked bytes.
   */
  async deleteDocuments(documentId: string): Promise<{ ok: true }> {
    const document = getDocument(this.db, documentId);
    if (document === null) {
      throw new AppError("NOT_FOUND", "document not found", { details: { documentId } });
    }

    // The copy's path is derived from the row, which stores where the original *was*; the
    // copy is named by document id in this app's own directory. Deriving it here rather than
    // storing a second path keeps one source of truth for "where the bytes are".
    await removeSource(storedPathFor(this.rootDir, document.id, document.sourcePath));
    deleteDocument(this.db, documentId);
    return { ok: true };
  }

  /**
   * The nearest chunks to a query, best first.
   *
   * An empty corpus is an empty result, not an error: a user who has not added anything and
   * asks a question with knowledge on gets an answer with no context, which is a state the
   * UI can explain.
   *
   * A corpus whose every vector was written by a *different* embedding model is an error.
   * That is the one "no results" that has a fix ("re-add your documents"), and returning an
   * empty list would hide it behind a shrug.
   */
  async search(input: {
    query: string;
    limit: number;
    documentIds?: readonly string[] | undefined;
  }): Promise<KnowledgeHit[]> {
    const { config, model } = await this.deps.resolveConfig();
    const [queryVector] = await this.embed({ config, model, texts: [input.query] });
    if (queryVector === undefined) return [];

    const dim = queryVector.length;
    const { total, comparable } = countChunks(this.db, dim);
    if (total > 0 && comparable === 0) {
      throw new AppError(
        "CONFLICT",
        "The indexed documents were embedded with a different model. Re-add them after changing the embedding model.",
        { details: { reason: "embedding_dimension_mismatch", dim } },
      );
    }

    const rows = listChunksForSearch(this.db, { dim, documentIds: input.documentIds });

    const scored = rows.map((row) => {
      const score = cosineSimilarity(queryVector, decodeVector(row.embedding));
      return {
        chunkId: row.chunkId,
        documentId: row.documentId,
        documentTitle: row.documentTitle,
        ordinal: row.ordinal,
        text: row.text,
        score,
      } satisfies KnowledgeHit;
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // A stable tiebreak, so two chunks with the same score come back in the same order on
      // every run: an unstable order makes a test flaky and a preview look random.
      if (a.documentId !== b.documentId) return a.documentId < b.documentId ? -1 : 1;
      return a.ordinal - b.ordinal;
    });

    return scored.slice(0, input.limit).map((hit) => ({
      ...hit,
      // Clamped: a float32 dot of a vector with itself can land a hair above 1, and the
      // contract says the score is a cosine.
      score: Math.max(-1, Math.min(1, hit.score)),
    }));
  }

  /** One chunk's text, for expanding a citation. */
  readChunk(chunkId: string): KnowledgeChunk {
    const chunk = getChunk(this.db, chunkId);
    if (chunk === null) {
      throw new AppError("NOT_FOUND", "chunk not found", { details: { chunkId } });
    }
    return chunk;
  }

  /**
   * What a knowledge-backed turn is given, or null when there is nothing to give.
   *
   * Null — not an empty prompt — for "no results": a system message that says "the following
   * excerpts are relevant" followed by nothing is worse than no message at all, because the
   * model will try to use it.
   */
  async retrieve(input: {
    query: string;
    documentIds?: readonly string[] | undefined;
  }): Promise<KnowledgePrompt | null> {
    const hits = await this.search({
      query: input.query,
      limit: TOP_K,
      documentIds: input.documentIds,
    });
    if (hits.length === 0) return null;

    return {
      systemText: buildKnowledgePrompt(hits),
      citations: hits.map(toCitation),
    };
  }

  /**
   * The embedding call, with the injected transport threaded through.
   *
   * `embedTexts` takes `fetchImpl` in its own options; this wrapper exists so the service has
   * one place that decides how a request is made, and so a test can inject one fake.
   */
  private embed(input: { config: InferenceConfig; model: string; texts: readonly string[] }) {
    const request: EmbedInput = {
      config: input.config,
      model: input.model,
      texts: input.texts,
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
    };
    return embedTexts(request);
  }
}

/**
 * The system message: numbered excerpts, and a rule about citing them.
 *
 * The markers are `[1]`, `[2]`, … in the same order as the citation list, which is what lets
 * a reader (and a test) connect a claim in the answer to a row in the transcript. The
 * instruction to cite is stated once and plainly: a model told to "use the context" and not
 * told how will paraphrase it without attribution, and an answer with no marker is
 * indistinguishable from one that used no knowledge at all.
 */
export function buildKnowledgePrompt(hits: readonly KnowledgeHit[]): string {
  const excerpts = hits
    .map(
      (hit, index) =>
        `[${index + 1}] ${hit.documentTitle} (chunk ${hit.ordinal + 1})\n${hit.text.trim()}`,
    )
    .join("\n\n");

  return [
    "The user has enabled the knowledge base for this turn. The excerpts below were retrieved for their question.",
    "Cite an excerpt by its number in square brackets, for example [1], when you use it. If the excerpts do not answer the question, say so instead of guessing.",
    "",
    excerpts,
  ].join("\n");
}

/** The default embedding model, so a caller with no settings row has an answer. */
export function embeddingModelOrDefault(stored: string | null): string {
  const value = stored?.trim() ?? "";
  return value === "" ? DEFAULT_EMBEDDING_MODEL : value;
}
