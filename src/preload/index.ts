// Runtime values come from the zod-free half of the contract: a sandboxed
// preload cannot resolve zod, so importing the schema module here would leave an
// unbundleable external and the bridge would silently never appear.
import {
  DEEP_LINK_CHANNEL,
  GENERATION_EVENT_CHANNEL,
  isChannelName,
  PROTOCOL_VERSION,
} from "@shared/channels";
import type {
  ChannelName,
  CleonApi,
  GenerationEvent,
  IpcResult,
  RequestOf,
  ResponseOf,
} from "@shared/ipc-contract";
import type { IpcRendererEvent } from "electron";
import { contextBridge, ipcRenderer } from "electron";

/**
 * A parsed `cleon://thread/<uuid>` link, as main sends it.
 *
 * Declared here because the contract is **incomplete** at the frozen D5 commit, and
 * `src/shared` is not this slice's to change: `channels.ts` declares
 * `DEEP_LINK_CHANNEL`, but `ipc-contract.ts` exports no target schema and `CleonApi`
 * has no `onDeepLink`. The shape below is structurally identical to `DeepLinkTarget`
 * in `src/main/native/deeplinks.ts` (`{ kind: "thread", threadId: uuid }`).
 *
 * When the contract is next bumped: move this declaration into `ipc-contract.ts` as a
 * Zod schema, add `onDeepLink` to `CleonApi`, and delete both from here. Until then the
 * renderer cannot see this method through `window.cleon`'s type — see the handoff note.
 */
interface DeepLinkTarget {
  readonly kind: "thread";
  readonly threadId: string;
}

/** `CleonApi` plus the one method the frozen contract does not declare yet. */
interface CleonApiWithDeepLinks extends CleonApi {
  onDeepLink(listener: (target: DeepLinkTarget) => void): () => void;
}

/**
 * The only bridge into the privileged world. Channel names are validated against
 * the frozen contract, so a compromised renderer cannot invent a channel.
 */
const api: CleonApiWithDeepLinks = {
  protocolVersion: PROTOCOL_VERSION,

  async invoke<C extends ChannelName>(
    channel: C,
    payload: RequestOf<C>,
  ): Promise<IpcResult<ResponseOf<C>>> {
    if (!isChannelName(channel)) {
      return {
        ok: false,
        error: { code: "UNKNOWN_CHANNEL", message: `Unknown channel: ${String(channel)}` },
      };
    }
    return ipcRenderer.invoke(`cleon:${channel}`, payload) as Promise<IpcResult<ResponseOf<C>>>;
  },

  /**
   * The renderer's half of the push channel. Electron hands the listener the raw
   * `IpcRendererEvent` first; it carries the sender's frame and webContents, and
   * leaking it would widen the bridge well past `CleonApi`. Only the event body
   * crosses into the callback.
   */
  onGenerationEvent(listener: (event: GenerationEvent) => void): () => void {
    const handler = (_ipcEvent: IpcRendererEvent, event: GenerationEvent): void => {
      listener(event);
    };
    ipcRenderer.on(GENERATION_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(GENERATION_EVENT_CHANNEL, handler);
    };
  },

  /**
   * The deep-link half of the push channel, in exactly the same shape: the
   * `IpcRendererEvent` is stripped, and the listener is handed a target that main
   * already parsed and validated. A raw URL never crosses this boundary.
   */
  onDeepLink(listener: (target: DeepLinkTarget) => void): () => void {
    const handler = (_ipcEvent: IpcRendererEvent, target: DeepLinkTarget): void => {
      listener(target);
    };
    ipcRenderer.on(DEEP_LINK_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(DEEP_LINK_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld("cleon", Object.freeze(api));
