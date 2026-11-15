import type {
  ChannelName,
  CleonApi,
  GenerationEvent,
  IpcError,
  IpcResult,
  RequestOf,
  ResponseOf,
} from "@shared/ipc-contract";

declare global {
  interface Window {
    cleon: CleonApi;
  }
}

/**
 * One typed door to the preload bridge. Nothing else in the renderer touches
 * `window.cleon` directly, so the shape of the bridge is stated in exactly one place
 * and a missing preload is a single `undefined` rather than a crash per call site.
 */
export function bridge(): CleonApi | undefined {
  return typeof window === "undefined" ? undefined : window.cleon;
}

/** A failed envelope, carried as an exception for callers that want `throw` semantics. */
export class IpcFailure extends Error {
  readonly ipc: IpcError;

  constructor(ipc: IpcError) {
    super(ipc.message);
    this.name = "IpcFailure";
    this.ipc = ipc;
  }
}

const NO_BRIDGE: IpcError = {
  code: "INTERNAL",
  message: "The preload bridge is missing.",
};

function invoke<C extends ChannelName>(
  channel: C,
  payload: RequestOf<C>,
): Promise<IpcResult<ResponseOf<C>>> {
  const api = bridge();
  if (api === undefined) return Promise.resolve({ ok: false, error: NO_BRIDGE });
  return api.invoke(channel, payload);
}

/** For TanStack Query: a failed envelope becomes a rejection carrying the `IpcError`. */
export async function callOrThrow<C extends ChannelName>(
  channel: C,
  payload: RequestOf<C>,
): Promise<ResponseOf<C>> {
  const result = await invoke(channel, payload);
  if (!result.ok) throw new IpcFailure(result.error);
  return result.data;
}

/**
 * The one place an unknown rejection becomes a contract error. Used by every surface
 * that has to show what went wrong, so the code on screen is the code main sent.
 */
export function toIpcError(error: unknown): IpcError | null {
  if (error === null || error === undefined) return null;
  if (error instanceof IpcFailure) return error.ipc;
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}

/**
 * A settled invoke: a rejected bridge call (a handler this build does not have, a
 * frame that went away) becomes a failed envelope like any other. The settings
 * surface renders every failure, so it must not also have to catch an exception to
 * stay on screen.
 */
async function invokeSettled<C extends ChannelName>(
  channel: C,
  payload: RequestOf<C>,
): Promise<IpcResult<ResponseOf<C>>> {
  try {
    return await invoke(channel, payload);
  } catch (error) {
    return {
      ok: false,
      error: toIpcError(error) ?? { code: "INTERNAL", message: "The bridge call failed." },
    };
  }
}

export function sendChat(
  request: RequestOf<"chat.send">,
): Promise<IpcResult<ResponseOf<"chat.send">>> {
  return invoke("chat.send", request);
}

export function stopGeneration(generationId: string): Promise<IpcResult<ResponseOf<"chat.stop">>> {
  return invoke("chat.stop", { generationId });
}

export function loadThread(threadId: string): Promise<ResponseOf<"chat.thread">> {
  return callOrThrow("chat.thread", { threadId });
}

/** The history list. A failed envelope becomes a rejection, for TanStack Query. */
export function listThreads(
  request: RequestOf<"threads.list">,
): Promise<ResponseOf<"threads.list">> {
  return callOrThrow("threads.list", request);
}

export function updateThread(
  request: RequestOf<"threads.update">,
): Promise<IpcResult<ResponseOf<"threads.update">>> {
  return invoke("threads.update", request);
}

export function deleteThread(threadId: string): Promise<IpcResult<ResponseOf<"threads.delete">>> {
  return invoke("threads.delete", { threadId });
}

export function regenerateMessage(
  messageId: string,
): Promise<IpcResult<ResponseOf<"chat.regenerate">>> {
  return invoke("chat.regenerate", { messageId });
}

export function setActiveVariant(
  threadId: string,
  messageId: string,
): Promise<IpcResult<ResponseOf<"chat.setActiveVariant">>> {
  return invoke("chat.setActiveVariant", { threadId, messageId });
}

/** Subscribes to the generation stream. No-op when the bridge never loaded. */
export function subscribeToGenerationEvents(
  listener: (event: GenerationEvent) => void,
): () => void {
  const api = bridge();
  if (api === undefined) return () => undefined;
  return api.onGenerationEvent(listener);
}

/* --------------------------------------------------- P0 provider settings */

/**
 * The settings surface's reads and writes. Kept as envelopes rather than throws:
 * every one of them is a user action with its own place to show a failure, and a
 * `settings.get` that main cannot answer is a state on screen, not a crash.
 */
export function getSettings(): Promise<IpcResult<ResponseOf<"settings.get">>> {
  return invokeSettled("settings.get", {});
}

export function setSettings(
  request: RequestOf<"settings.set">,
): Promise<IpcResult<ResponseOf<"settings.set">>> {
  return invokeSettled("settings.set", request);
}

export function listModels(): Promise<IpcResult<ResponseOf<"models.list">>> {
  return invokeSettled("models.list", {});
}

/** The key goes one way. No channel returns it, and nothing here keeps it. */
export function setApiKey(key: string): Promise<IpcResult<ResponseOf<"secrets.setKey">>> {
  return invokeSettled("secrets.setKey", { key });
}

export function clearApiKey(): Promise<IpcResult<ResponseOf<"secrets.clearKey">>> {
  return invokeSettled("secrets.clearKey", {});
}

/* ------------------------------------------------------ D4 attachments */

/**
 * Copies the files at these absolute paths into main's attachments directory and answers
 * with their metadata. The renderer sends paths it was handed; it never reads the bytes.
 */
export function addAttachments(
  paths: readonly string[],
): Promise<IpcResult<ResponseOf<"attachments.add">>> {
  return invokeSettled("attachments.add", { paths: [...paths] });
}

/**
 * A thumbnail for a small image, or `{ dataUrl: null }`. Settled rather than thrown: a chip
 * that cannot get a picture still has a filename to show, so a failed preview must not take
 * the composer down with it.
 */
export function previewAttachment(
  id: string,
): Promise<IpcResult<ResponseOf<"attachments.preview">>> {
  return invokeSettled("attachments.preview", { id });
}

/* ------------------------------------------- D6 projects, assistants, prompts */

/**
 * The project list drives a sidebar section, so a failure has to be renderable: these
 * throw (`callOrThrow`) where TanStack Query owns the state, and settle where a click
 * produced them and the surface has somewhere to put the error.
 */
export function listProjects(): Promise<ResponseOf<"projects.list">> {
  return callOrThrow("projects.list", {});
}

export function createProject(
  request: RequestOf<"projects.create">,
): Promise<IpcResult<ResponseOf<"projects.create">>> {
  return invokeSettled("projects.create", request);
}

export function updateProject(
  request: RequestOf<"projects.update">,
): Promise<IpcResult<ResponseOf<"projects.update">>> {
  return invokeSettled("projects.update", request);
}

export function listAssistants(
  request: RequestOf<"assistants.list">,
): Promise<ResponseOf<"assistants.list">> {
  return callOrThrow("assistants.list", request);
}

export function createAssistant(
  request: RequestOf<"assistants.create">,
): Promise<IpcResult<ResponseOf<"assistants.create">>> {
  return invokeSettled("assistants.create", request);
}

export function updateAssistant(
  request: RequestOf<"assistants.update">,
): Promise<IpcResult<ResponseOf<"assistants.update">>> {
  return invokeSettled("assistants.update", request);
}

export function deleteAssistant(
  assistantId: string,
): Promise<IpcResult<ResponseOf<"assistants.delete">>> {
  return invokeSettled("assistants.delete", { assistantId });
}

export function listPrompts(
  request: RequestOf<"prompts.list">,
): Promise<ResponseOf<"prompts.list">> {
  return callOrThrow("prompts.list", request);
}

export function createPrompt(
  request: RequestOf<"prompts.create">,
): Promise<IpcResult<ResponseOf<"prompts.create">>> {
  return invokeSettled("prompts.create", request);
}

export function updatePrompt(
  request: RequestOf<"prompts.update">,
): Promise<IpcResult<ResponseOf<"prompts.update">>> {
  return invokeSettled("prompts.update", request);
}

export function deletePrompt(promptId: string): Promise<IpcResult<ResponseOf<"prompts.delete">>> {
  return invokeSettled("prompts.delete", { promptId });
}
