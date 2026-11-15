import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { IpcFailure, listModels, toIpcError } from "../lib/ipc";
import { buildModelCatalog, type ModelCatalog, type ModelCatalogResult } from "../lib/models";

/**
 * The provider's model catalogue (P0).
 *
 * One keyed read per endpoint. `reload` is how a changed base URL or a freshly saved
 * key takes effect: the list belongs to the configuration, not to the window. `probe`
 * is the settings screen's "Test connection" — an explicit fetch the user asked for,
 * so its answer is reported as the result of that click.
 */

export const MODELS_KEY = ["models.list"] as const;

async function fetchCatalog(): Promise<ModelCatalogResult> {
  const result = await listModels();
  if (!result.ok) throw new IpcFailure(result.error);
  return result.data;
}

export interface ModelCatalogHandle {
  catalog: ModelCatalog;
  /** A fresh read for the Test button; success also clears a stale error on the picker. */
  probe: () => Promise<ModelCatalog>;
  /** Re-reads for the picker after a setting changed. */
  reload: () => Promise<void>;
}

export function useModelCatalog(): ModelCatalogHandle {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: MODELS_KEY,
    queryFn: fetchCatalog,
    retry: false,
  });

  const catalog = useMemo(
    () =>
      buildModelCatalog({
        loading: query.isPending,
        result: query.data ?? null,
        error: toIpcError(query.error),
      }),
    [query.isPending, query.data, query.error],
  );

  const probe = useCallback(async (): Promise<ModelCatalog> => {
    try {
      // Through the query, not around it: a successful fetch replaces the cached
      // failure, so the picker and the Test button cannot disagree — one showing a
      // dead endpoint while the other lists models from it.
      const result = await queryClient.fetchQuery({
        queryKey: MODELS_KEY,
        queryFn: fetchCatalog,
        staleTime: 0,
        retry: false,
      });
      return buildModelCatalog({ loading: false, result, error: null });
    } catch (error) {
      return buildModelCatalog({
        loading: false,
        result: null,
        error: toIpcError(error) ?? { code: "INTERNAL", message: "The model list failed." },
      });
    }
  }, [queryClient]);

  const reload = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: MODELS_KEY });
  }, [queryClient]);

  return { catalog, probe, reload };
}
