import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The one step both perf scripts share: compile the repo's database layer, then load it.
 *
 * Why a compile step instead of running the TypeScript directly:
 *
 *  - `node scripts/perf/measure.mjs` has to run under plain `node` (that is what `pnpm perf`
 *    is), and Node cannot import `src/main/db/repo.ts` from a module that addresses its
 *    neighbours as `./client.js` — the specifier does not exist on disk.
 *  - The alternative, a second copy of the queries written for the harness, would be a
 *    measurement of code that ships nowhere. The measurement is only worth something if it
 *    runs the same `listThreads`, the same FTS CTEs and the same `getThreadTree` the app
 *    runs.
 *
 * `tsc` is already a devDependency; nothing new is installed for this.
 */

export const PERF_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(PERF_DIR, "../..");
const BUILD_DIR = join(PERF_DIR, ".build");
const ENTRY = join(BUILD_DIR, "src/main/db/repo.js");

/**
 * Compiles once per process. `skip` is for the second script in a chain (`measure` after
 * `seed`), which finds the output already there.
 */
export function compile({ skipIfPresent = false } = {}) {
  if (skipIfPresent && existsSync(ENTRY)) return;

  const result = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(PERF_DIR, "tsconfig.json")],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(`perf: compiling the database layer failed (exit ${result.status})`);
  }
}

/** The compiled database layer, loaded on demand because it only exists after `compile`. */
export async function loadDbLayer() {
  const load = (relative) => import(pathToFileURL(join(BUILD_DIR, relative)).href);

  const [dbIndex, client, repo, repoAttachments] = await Promise.all([
    load("src/main/db/index.js"),
    load("src/main/db/client.js"),
    load("src/main/db/repo.js"),
    load("src/main/db/repo-attachments.js"),
  ]);

  return {
    openDatabase: dbIndex.openDatabase,
    schemaVersion: dbIndex.schemaVersion,
    hasFts5: dbIndex.hasFts5,
    createDb: client.createDb,
    listThreads: repo.listThreads,
    getThreadTree: repo.getThreadTree,
    insertMessage: repo.insertMessage,
    createThread: repo.createThread,
    touchThread: repo.touchThread,
    listAttachmentsForMessages: repoAttachments.listAttachmentsForMessages,
  };
}
