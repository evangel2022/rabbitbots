import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { invalidateActivityQueries } from "./activity-refresh";
import { spaceQueries } from "./query";

it("invalidates the exact active and recent Activity keys", async () => {
  const client = new QueryClient();
  const queries = spaceQueries("user-1", "space-1");
  const active = queries.runs.list.queryKey({ input: { filter: "active" } });
  const recent = queries.runs.list.queryKey({ input: { filter: "recent" } });
  client.setQueryData(active, { runs: [] });
  client.setQueryData(recent, { runs: [] });

  await invalidateActivityQueries(client, queries);

  expect(client.getQueryState(active)?.isInvalidated).toBe(true);
  expect(client.getQueryState(recent)?.isInvalidated).toBe(true);
});
