import { mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CHANNELS,
  type ChannelName,
  contracts,
  type ErrorCode,
  ErrorCodeSchema,
  GENERATION_EVENT_CHANNEL,
  type IpcResult,
  PROTOCOL_VERSION,
  type RequestOf,
  type ResponseOf,
} from "@shared/ipc-contract";
import { eq } from "drizzle-orm";
import {
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import { GenerationBus } from "./api/bus.js";
import { resolveBaseUrl } from "./api/client.js";
import { GenerationService } from "./api/generations.js";
import { createDb, type DrizzleDb } from "./db/client.js";
import { countRows, defaultDbPath, hasFts5, openDatabase, schemaVersion } from "./db/index.js";
import { getThreadWithMessages } from "./db/repo.js";
import { generations as generationRows } from "./db/schema.js";
import { AppError, toIpcError } from "./errors.js";
import { type SecretBackend, type SecretStore, SecretsService } from "./secrets.js";

const HERE = import.meta.dirname;
const STARTED_AT = new Date().toISOString();

/**
 * Security baseline (plan invariant 1). Registered before `ready`, because a
 * privileged scheme can only be declared once, early.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

app.enableSandbox();

/**
 * Test hook: an isolated user-data directory.
 *
 * The e2e needs its own SQLite file and its own Chromium storage, and the
 * relaunch leg of gate G1 needs the *same* one twice. Chromium derives its storage
 * paths from `userData` during startup, so this has to run before `ready`, and
 * `setPath` throws on a directory that does not exist — hence the mkdir rather
 * than an assumption. Unset in normal runs, where the platform default applies.
 */
const userDataOverride = process.env.CLEON_USER_DATA?.trim() ?? "";
if (userDataOverride !== "") {
  mkdirSync(userDataOverride, { recursive: true });
  app.setPath("userData", userDataOverride);
}

type Handler<C extends ChannelName> = (
  payload: RequestOf<C>,
  /** The sender, so a push channel can answer the window that asked. */
  event: IpcMainInvokeEvent,
) => Promise<ResponseOf<C>> | ResponseOf<C>;

let pingSeq = 0;
let db: ReturnType<typeof openDatabase> | null = null;
let orm: DrizzleDb | null = null;
let secrets: SecretsService | null = null;
let generations: GenerationService | null = null;

function getDb(): ReturnType<typeof openDatabase> {
  if (!db) db = openDatabase(defaultDbPath(app.getPath("userData")));
  return db;
}

/** Drizzle over the same connection, built once. */
function getOrm(): DrizzleDb {
  if (!orm) orm = createDb(getDb());
  return orm;
}

/**
 * Production wiring for `SecretsService` — the half D1a deliberately left out.
 *
 * `safeStorage` is the platform primitive: Keychain on macOS, DPAPI on Windows,
 * libsecret on Linux. It is consulted through `available()` on every call rather
 * than cached, because the platform can refuse it (a locked keyring) and
 * `SecretsService` treats that as UNAUTHORIZED instead of silently degrading.
 *
 * The ciphertext lives in the app's own userData directory with owner-only
 * permissions. It is not the key, but nothing else has any business reading it.
 */
function createSecrets(): SecretsService {
  const keyFile = join(app.getPath("userData"), "inference-key.enc");

  const backend: SecretBackend = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, "base64")),
  };

  const store: SecretStore = {
    async read() {
      try {
        return await readFile(keyFile, "utf8");
      } catch (error) {
        // No file yet is the normal first run, not a failure to report.
        if (isMissingFile(error)) return null;
        throw error;
      }
    },
    async write(value) {
      await writeFile(keyFile, value, { mode: 0o600 });
    },
    async clear() {
      await rm(keyFile, { force: true });
    },
  };

  return new SecretsService(backend, store);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function getSecrets(): SecretsService {
  if (!secrets) secrets = createSecrets();
  return secrets;
}

/**
 * The inference service, over the shared connection and Drizzle handle.
 *
 * The API key is read per turn rather than captured once, so replacing it takes
 * effect on the next message instead of the next launch. An unconfigured base URL
 * surfaces from `resolveBaseUrl` inside the turn, where it becomes an error event
 * on a generation that is already persisted — the user's message is not lost to a
 * configuration mistake.
 */
function getGenerations(): GenerationService {
  if (!generations) {
    generations = new GenerationService({
      db: getOrm(),
      bus: new GenerationBus(),
      resolveConfig: async () => ({
        baseUrl: resolveBaseUrl({ isPackaged: app.isPackaged, env: process.env }),
        apiKey: await getSecrets().getApiKey(),
      }),
    });
  }
  return generations;
}

/**
 * The restore read (gate G1): one thread and its messages, oldest first.
 *
 * `messages` carries no generation column — the link is `generations.message_id` —
 * but the renderer needs both the generation and its error code to render a turn it
 * did not watch. One extra read for the whole thread, keyed by message id, is
 * cheaper than a query per message.
 *
 * A stored `error_code` that is not in the contract's closed set is reported as
 * null rather than passed through: the type is the boundary, and a database written
 * by a newer build must not crash an older renderer.
 */
function readThread(threadId: string): ResponseOf<"chat.thread"> {
  const found = getThreadWithMessages(getOrm(), threadId);
  if (found === null) {
    throw new AppError("NOT_FOUND", "thread not found", { details: { threadId } });
  }

  const rows = getOrm()
    .select({
      messageId: generationRows.messageId,
      generationId: generationRows.id,
      errorCode: generationRows.errorCode,
    })
    .from(generationRows)
    .where(eq(generationRows.threadId, threadId))
    .all();

  const byMessage = new Map<string, { generationId: string; errorCode: ErrorCode | null }>();
  for (const row of rows) {
    if (row.messageId === null) continue;
    const parsed = row.errorCode === null ? null : ErrorCodeSchema.safeParse(row.errorCode);
    byMessage.set(row.messageId, {
      generationId: row.generationId,
      errorCode: parsed?.success === true ? parsed.data : null,
    });
  }

  return {
    thread: {
      id: found.thread.id,
      title: found.thread.title,
      updatedAt: found.thread.updatedAt,
    },
    messages: found.messages.map((message) => {
      const generation = byMessage.get(message.id);
      return {
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        generationId: generation?.generationId ?? null,
        errorCode: generation?.errorCode ?? null,
      };
    }),
  };
}

/**
 * The whole privilege surface. The renderer can only reach what is listed here,
 * and every handler returns a result envelope rather than throwing.
 */
const handlers: { [C in ChannelName]: Handler<C> } = {
  "app.info": () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? "unknown",
    chrome: process.versions.chrome ?? "unknown",
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: PROTOCOL_VERSION,
    isPackaged: app.isPackaged,
    startedAt: STARTED_AT,
  }),

  "app.ping": ({ nonce }) => {
    pingSeq += 1;
    return { nonce, at: new Date().toISOString(), seq: pingSeq };
  },

  "db.health": () => {
    const conn = getDb();
    return {
      ok: true,
      schemaVersion: schemaVersion(conn),
      fts5: hasFts5(conn),
      threads: countRows(conn, "threads"),
      messages: countRows(conn, "messages"),
    };
  },

  "secrets.status": async () => {
    const masked = await getSecrets().masked();
    return { hasKey: masked !== null, masked };
  },

  "secrets.setKey": async ({ key }) => {
    const service = getSecrets();
    await service.setApiKey(key);
    const masked = await service.masked();
    return { hasKey: masked !== null, masked };
  },

  "secrets.clearKey": async () => {
    await getSecrets().clearKey();
    return { hasKey: false };
  },

  "chat.send": (payload, event) => {
    const sender = event.sender;
    return getGenerations().send(payload, (generationEvent) => {
      // The window can close mid-answer. There is nothing left to tell, and
      // sending to a destroyed webContents throws.
      if (!sender.isDestroyed()) sender.send(GENERATION_EVENT_CHANNEL, generationEvent);
    });
  },

  "chat.stop": ({ generationId }) => getGenerations().stop(generationId),

  "chat.thread": ({ threadId }) => readThread(threadId),
};

export function registerIpc(): void {
  for (const channel of CHANNELS) {
    ipcMain.handle(
      `cleon:${channel}`,
      async (event, payload: unknown): Promise<IpcResult<unknown>> => {
        try {
          const request = contracts[channel].request.safeParse(payload);
          if (!request.success) {
            throw new AppError("BAD_REQUEST", `Invalid payload for ${channel}`, {
              details: { issues: request.error.issues },
            });
          }
          const handler = handlers[channel] as (
            value: unknown,
            invokeEvent: IpcMainInvokeEvent,
          ) => unknown;
          const data = await handler(request.data, event);
          return { ok: true, data };
        } catch (err) {
          return { ok: false, error: toIpcError(err) };
        }
      },
    );
  }
}

/** Serves the built renderer over a privileged scheme, with a traversal guard. */
function serveRenderer(): void {
  const root = join(HERE, "../renderer");

  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    const raw = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = normalize(join(root, raw));

    if (!file.startsWith(root + sep)) {
      return new Response("forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0d12",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(HERE, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Nothing in this app navigates. External links go to the real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://")) {
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    }
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadURL("app://bundle/index.html");
  }

  return win;
}

app.whenReady().then(() => {
  // Nothing in this app needs a camera, a mic, a location, or a notification prompt.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );

  serveRenderer();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
