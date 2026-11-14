import type { QueryClient } from "@tanstack/react-query";
import type { SpaceQueries } from "./query";

/** Invalidate the exact Activity queries without touching every runs cache. */
export function invalidateActivityQueries(
  queryClient: QueryClient,
  queries: SpaceQueries,
): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: queries.runs.list.queryKey({ input: { filter: "active" } }),
    }),
    queryClient.invalidateQueries({
      queryKey: queries.runs.list.queryKey({ input: { filter: "recent" } }),
    }),
  ]).then(() => undefined);
}
