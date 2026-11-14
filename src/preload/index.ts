// Runtime values come from the zod-free half of the contract: a sandboxed
// preload cannot resolve zod, so importing the schema module here would leave an
// unbundleable external and the bridge would silently never appear.
import { isChannelName, PROTOCOL_VERSION } from "@shared/channels";
import type { ChannelName, CleonApi, IpcResult, RequestOf, ResponseOf } from "@shared/ipc-contract";
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
};

contextBridge.exposeInMainWorld("cleon", Object.freeze(api));
