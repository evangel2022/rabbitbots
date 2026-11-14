import { appendFileSync } from "node:fs";
import { asSystem, createDb } from "@rakazo/db";
import {
  claimToolInvocation,
  completeToolInvocation,
  markToolHandlerStarted,
} from "../tool-invocations.js";

const databaseUrl = process.env.DATABASE_URL;
const invocationId = process.env.TOOL_INVOCATION_ID;
const runId = process.env.TOOL_INVOCATION_RUN_ID;
const spaceId = process.env.TOOL_INVOCATION_SPACE_ID;
const workerId = process.env.TOOL_INVOCATION_WORKER_ID;
const counterFile = process.env.TOOL_INVOCATION_COUNTER;
const stage = process.env.TOOL_INVOCATION_CRASH_STAGE;
if (!databaseUrl || !invocationId || !runId || !spaceId || !workerId || !counterFile || !stage) {
  process.stderr.write("missing test fixture environment\n");
  process.exit(2);
}

const db = createDb(databaseUrl);
const prisma = asSystem(db.prisma);
const marker = (value: string) => appendFileSync(counterFile, `${value}\n`);
const ready = () => process.stdout.write("READY\n");
const hold = () => setInterval(() => undefined, 1_000);

try {
  const row = await prisma.toolInvocation.findUniqueOrThrow({
    where: { spaceId_invocationId: { spaceId, invocationId } },
    select: { id: true },
  });
  if (stage === "received") {
    marker("received");
    ready();
    hold();
  } else {
    const claimed = await claimToolInvocation(prisma, {
      id: row.id,
      workerId,
      fence: 1,
    });
    if (!claimed.claimed) {
      process.stderr.write("claim failed\n");
      process.exit(3);
    }
    marker("claimed");
    if (stage === "claimed") {
      ready();
      hold();
    } else {
      await markToolHandlerStarted(prisma, {
        id: row.id,
        workerId,
        fence: claimed.fencingToken,
      });
      marker("handler");
      if (stage === "handler") {
        ready();
        hold();
      } else if (stage === "result") {
        await completeToolInvocation(prisma, {
          id: row.id,
          workerId,
          fence: claimed.fencingToken,
          result: { ok: true },
          secrets: [],
        });
        marker("result");
        process.exit(0);
      } else {
        process.stderr.write("unknown stage\n");
        process.exit(4);
      }
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(5);
}
