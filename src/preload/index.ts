// Runtime values come from the zod-free half of the contract: a sandboxed
// preload cannot resolve zod, so importing the schema module here would leave an
// unbundleable external and the bridge would silently never appear.
import { GENERATION_EVENT_CHANNEL, isChannelName, PROTOCOL_VERSION } from "@shared/channels";
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
 * The only bridge into the privileged world. Channel names are validated against
 * the frozen contract, so a compromised renderer cannot invent a channel.
 */
const api: CleonApi = {
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
};

contextBridge.exposeInMainWorld("cleon", Object.freeze(api));
