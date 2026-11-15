import type { ResponseOf } from "@shared/ipc-contract";
import { useQuery } from "@tanstack/react-query";
import { getSettings, IpcFailure } from "../lib/ipc";

/**
 * The provider settings as main has them (P0).
 *
 * One keyed read, shared by the settings screen and the composer's default-model
 * fallback: TanStack Query puts both subscribers on one call. Writes go through the
 * surface that made them and invalidate this key — the field then shows what main
 * accepted, rather than a value patched in optimistically that main might refuse.
 */

export const SETTINGS_KEY = ["settings.get"] as const;

export function useSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async (): Promise<ResponseOf<"settings.get">> => {
      const result = await getSettings();
      if (!result.ok) throw new IpcFailure(result.error);
      return result.data;
    },
    retry: false,
  });
}
