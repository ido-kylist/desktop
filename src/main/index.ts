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
import { GenerationService, type GenerationSink } from "./api/generations.js";
import { listModels } from "./api/models.js";
import { attachmentsRoot, createAttachmentHandlers } from "./attachments/handlers.js";
import { createDb, type DrizzleDb } from "./db/client.js";
import { countRows, defaultDbPath, hasFts5, openDatabase, schemaVersion } from "./db/index.js";
import {
  getSettings,
  getThreadTree,
  listThreads,
  type StoredSettings,
  setActiveVariant,
  setSettings,
  softDeleteThread,
  updateThread,
} from "./db/repo.js";
import { attachToUserMessage, listAttachmentsForMessages } from "./db/repo-attachments.js";
import { AppError, toIpcError } from "./errors.js";
import { registerNativeAppHooks, showLauncher } from "./native/handlers.js";
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
 * effect on the next message instead of the next launch. The base URL is resolved
 * per turn for the same reason: a URL typed into Settings has to work without a
 * relaunch. An unconfigured base URL surfaces from `resolveBaseUrl` inside the turn,
 * where it becomes an error event on a generation that is already persisted — the
 * user's message is not lost to a configuration mistake.
 */
function getGenerations(): GenerationService {
  if (!generations) {
    generations = new GenerationService({
      db: getOrm(),
      bus: new GenerationBus(),
      resolveConfig: async () => ({
        baseUrl: resolveBaseUrl({
          isPackaged: app.isPackaged,
          env: process.env,
          storedBaseUrl: getSettings(getOrm()).baseUrl,
        }),
        apiKey: await getSecrets().getApiKey(),
      }),
    });
  }
  return generations;
}

/**
 * The restore read (gate G1) plus the D3 tree.
 *
 * One repository call returns the messages, their sibling groups, the generation row
 * behind each message, and the active leaf; the handler's added value is the
 * contract's boundary types.
 *
 * A stored `error_code` that is not in the contract's closed set is reported as null
 * rather than passed through: the type is the boundary, and a database written by a
 * newer build must not crash an older renderer.
 */
let attachmentHandlersCache: ReturnType<typeof createAttachmentHandlers> | null = null;

function attachmentHandlers(): ReturnType<typeof createAttachmentHandlers> {
  attachmentHandlersCache ??= createAttachmentHandlers({
    db: getOrm(),
    rootDir: attachmentsRoot(app.getPath("userData")),
  });
  return attachmentHandlersCache;
}

function readThread(threadId: string): ResponseOf<"chat.thread"> {
  const tree = getThreadTree(getOrm(), threadId);
  if (tree === null) {
    throw new AppError("NOT_FOUND", "thread not found", { details: { threadId } });
  }

  const attachments = listAttachmentsForMessages(
    getOrm(),
    tree.messages.map((message) => message.id),
  );

  return {
    thread: {
      id: tree.thread.id,
      title: tree.thread.title,
      updatedAt: tree.thread.updatedAt,
    },
    messages: tree.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      generationId: message.generationId,
      errorCode: toErrorCode(message.errorCode),
      parentId: message.parentId,
      variantOf: message.variantOf,
      variants: message.variants,
      usage: message.usage,
      attachments: attachments.get(message.id) ?? [],
    })),
    activeLeafId: tree.activeLeafId,
  };
}

function toErrorCode(raw: string | null): ErrorCode | null {
  if (raw === null) return null;
  const parsed = ErrorCodeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * A generation sink bound to one window.
 *
 * The window can close mid-answer. There is nothing left to tell, and sending to a
 * destroyed webContents throws.
 */
function generationSink(sender: IpcMainInvokeEvent["sender"]): GenerationSink {
  return (generationEvent) => {
    if (!sender.isDestroyed()) sender.send(GENERATION_EVENT_CHANNEL, generationEvent);
  };
}

/**
 * `settings.get` and `settings.set` answer with the same shape, so both go through
 * the one place that asks the secret store whether a key exists.
 *
 * Only the masked tail crosses the boundary (invariant 2): the settings screen needs
 * to confirm a key is present, not to read it. An unavailable keychain throws
 * UNAUTHORIZED rather than reporting `hasKey: false`, because claiming there is no
 * key when one exists is the kind of lie the user acts on.
 */
async function settingsResponse(stored: StoredSettings): Promise<ResponseOf<"settings.get">> {
  const masked = await getSecrets().masked();
  return {
    baseUrl: stored.baseUrl,
    defaultModel: stored.defaultModel,
    hasKey: masked !== null,
    masked,
  };
}

/**
 * The key, when one can be read, for a request that does not require it.
 *
 * A catalog read is such a request: the bearer header is attached only when a key
 * exists, so a locked keychain must not take the model list down with it. The list
 * goes out unauthenticated and a 401 comes back as an ordinary fallback with a
 * message, which is a state the settings screen can show.
 */
async function readOptionalApiKey(): Promise<string | null> {
  try {
    return await getSecrets().getApiKey();
  } catch (error) {
    if (error instanceof AppError && error.code === "UNAUTHORIZED") return null;
    throw error;
  }
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

  "chat.send": async (payload, event) => {
    const sent = await getGenerations().send(
      { threadId: payload.threadId, text: payload.text, model: payload.model },
      generationSink(event.sender),
    );
    // Stored by `attachments.add` before send, so the files already exist; this only
    // claims them for the turn. Claiming after the message row exists keeps the
    // foreign key honest, and a failure here leaves an orphan file, never a broken row.
    if (payload.attachmentIds !== undefined && payload.attachmentIds.length > 0) {
      attachToUserMessage(getOrm(), payload.attachmentIds, sent.userMessageId, sent.threadId);
    }
    return sent;
  },

  "chat.stop": ({ generationId }) => getGenerations().stop(generationId),

  "chat.thread": ({ threadId }) => readThread(threadId),

  /** Built lazily: the attachments root lives under `app.getPath`, which needs ready. */
  "attachments.add": (payload) => attachmentHandlers()["attachments.add"](payload),
  "attachments.preview": (payload) => attachmentHandlers()["attachments.preview"](payload),

  /** The launcher singleton is owned by the native module; this only forwards. */
  "native.showLauncher": () => {
    showLauncher();
    return { ok: true as const };
  },

  /** A sibling under the same parent, streamed by the same orchestrator as `chat.send`. */
  "chat.regenerate": (payload, event) =>
    getGenerations().regenerate(payload.messageId, generationSink(event.sender)),

  "chat.setActiveVariant": ({ threadId, messageId }) => {
    setActiveVariant(getOrm(), threadId, messageId);
    return { ok: true };
  },

  "threads.list": (payload) => listThreads(getOrm(), payload),

  "threads.update": (payload) => {
    updateThread(getOrm(), payload);
    return { ok: true };
  },

  "threads.delete": ({ threadId }) => {
    softDeleteThread(getOrm(), threadId);
    return { ok: true };
  },

  /* ------------------------------------------------- P0 provider settings */

  "settings.get": async () => settingsResponse(getSettings(getOrm())),

  /**
   * The patch is forwarded as it arrived: the contract already makes every field
   * optional, and "absent" and "null" mean different things (leave it / clear it),
   * so nothing is defaulted here. The response is the stored state after the write,
   * not an echo of the request, so a trimmed or cleared value is what the screen
   * then shows.
   */
  "settings.set": async (payload) =>
    settingsResponse(
      setSettings(getOrm(), {
        baseUrl: payload.baseUrl,
        defaultModel: payload.defaultModel,
      }),
    ),

  /**
   * The catalog for the settings screen. The base URL is resolved here rather than
   * inside `listModels` so the pure function stays pure, and an unconfigured packaged
   * build surfaces as an INTERNAL error the screen can render — the alternative, an
   * empty list, would look like a provider with no models.
   */
  "models.list": async () => {
    const baseUrl = resolveBaseUrl({
      isPackaged: app.isPackaged,
      env: process.env,
      storedBaseUrl: getSettings(getOrm()).baseUrl,
    });
    return listModels({ baseUrl, apiKey: await readOptionalApiKey() });
  },
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
  // Shortcuts, tray and deep links. Registered after the IPC surface so a deep link
  // that arrives during launch finds a live bridge rather than a dead one.
  registerNativeAppHooks();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
