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

/** Subscribes to the generation stream. No-op when the bridge never loaded. */
export function subscribeToGenerationEvents(
  listener: (event: GenerationEvent) => void,
): () => void {
  const api = bridge();
  if (api === undefined) return () => undefined;
  return api.onGenerationEvent(listener);
}
