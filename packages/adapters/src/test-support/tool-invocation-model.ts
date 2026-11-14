/**
 * In-memory Prisma tool-invocation model for executor tests.
 *
 * The durable invocation table is part of the execution path. Tests that exercise the
 * executor with a hand-written Prisma stub must still model this table, otherwise a stub
 * Proxy can look like a real model but fail on the first `toolInvocation.create` call.
 */

type Row = Record<string, unknown>;

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === "spaceId_invocationId") {
      const unique = value as { spaceId?: unknown; invocationId?: unknown };
      return row.spaceId === unique.spaceId && row.invocationId === unique.invocationId;
    }
    if (value && typeof value === "object" && "in" in value) {
      return (value.in as unknown[]).includes(row[key]);
    }
    if (value && typeof value === "object" && "startsWith" in value) {
      return String(row[key] ?? "").startsWith(String(value.startsWith));
    }
    return row[key] === value;
  });
}

function apply(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in value) {
      row[key] = Number(row[key] ?? 0) + Number(value.increment);
    } else {
      row[key] = value;
    }
  }
}

/** A small Prisma-compatible model with the invocation lifecycle methods the executor uses. */
export function createFakeToolInvocationModel() {
  const rows = new Map<string, Row>();
  let sequence = 0;
  const findOne = async (where?: Record<string, unknown>) =>
    [...rows.values()].find((row) => matches(row, where)) ?? null;
  return {
    findUnique: async ({ where }: { where: Record<string, unknown> }) => findOne(where),
    findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
      const row = await findOne(where);
      if (!row) throw new Error("Tool invocation not found");
      return row;
    },
    findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => findOne(where),
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      [...rows.values()].filter((row) => matches(row, where)),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const id = typeof data.id === "string" ? data.id : `invocation-${++sequence}`;
      const row: Row = {
        id,
        status: "RECEIVED",
        executionStage: "RECEIVED",
        recoverability: "full",
        fencingToken: 0,
        ...data,
      };
      rows.set(id, row);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where?: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const matchesForUpdate = [...rows.values()].filter((row) => matches(row, where));
      for (const row of matchesForUpdate) apply(row, data);
      return { count: matchesForUpdate.length };
    },
    update: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const row = await findOne(where);
      if (!row) throw new Error("Tool invocation not found");
      apply(row, data);
      return row;
    },
    deleteMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const kept = [...rows.values()].filter((row) => !matches(row, where));
      const count = rows.size - kept.length;
      rows.clear();
      for (const row of kept) rows.set(String(row.id), row);
      return { count };
    },
  };
}
