import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../../lib/query";

/**
 * The active chat's orchestrations, newest first. Polling is only for a parent chat: a run in
 * flight may be about to create one, and an unfinished orchestration changes as children settle.
 */
export function useOrchestrations(botId: string | undefined, runInFlight: boolean) {
  const queries = useSpaceQueries();
  const query = useQuery({
    ...queries.orchestrations.list.queryOptions({ input: { botId: botId ?? "" } }),
    enabled: Boolean(botId),
    refetchInterval: (query) => {
      const rows = query.state.data?.orchestrations;
      const active = rows?.some((row) => row.status === "running" || row.status === "joining");
      return active || runInFlight ? 1_500 : 5_000;
    },
  });
  return {
    orchestration: query.data?.orchestrations[0] ?? null,
    isLoading: query.isLoading,
  };
}
