import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("Create AI Company HTTP auth integration", () => {
  it("requires auth, scopes to the caller and is idempotent", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-ai-company-test-"));
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: "http://127.0.0.1:5173",
      authUrl: "http://127.0.0.1:5173",
    });
    try {
      const post = (procedure: string, body: unknown, cookie?: string) =>
        handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:5173",
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify({ json: body }),
        });

      const unauthStatus = await post("workforce/company/status", {});
      expect(unauthStatus.status).toBeGreaterThanOrEqual(400);
      const unauthCreate = await post("workforce/company/create", {});
      expect(unauthCreate.status).toBeGreaterThanOrEqual(400);
      const unauthDemo = await post("workforce/demo/status", {});
      expect(unauthDemo.status).toBeGreaterThanOrEqual(400);
      const unauthDemoLaunch = await post("workforce/demo/launch", {});
      expect(unauthDemoLaunch.status).toBeGreaterThanOrEqual(400);

      const stamp = Date.now();
      const signup = async (label: string) => {
        const response = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
          body: JSON.stringify({
            email: `${label}-${stamp}@rakazo.test`,
            password: "test-password-123",
            name: `AI Company ${label}`,
          }),
        });
        expect(response.status).toBeLessThan(400);
        return sessionCookieHeader(response);
      };

      const ownerCookie = await signup("owner");
      const otherCookie = await signup("other");

      const ownerBefore = await post("workforce/company/status", {}, ownerCookie);
      expect(ownerBefore.status).toBe(200);
      expect(await ownerBefore.json()).toMatchObject({
        json: { created: false, bots: [], meetingId: null },
      });

      // Client-supplied IDs are not part of the RPC contract and must not change the actor's scope.
      const created = await post(
        "workforce/company/create",
        { spaceId: "other-space", userId: "other-user" },
        ownerCookie,
      );
      expect(created.status).toBe(200);
      const first = (await created.json()) as {
        json: {
          created: boolean;
          bots: Array<{ id: string; name: string }>;
          meetingId: string | null;
        };
      };
      expect(first.json.created).toBe(true);
      expect(first.json.bots.map((bot) => bot.name).sort()).toEqual([
        "CEO Assistant",
        "Finance Bot",
        "Operations Bot",
        "Research Bot",
      ]);
      expect(first.json.meetingId).toBeTruthy();

      const ownerAfter = await post("workforce/company/status", {}, ownerCookie);
      expect(ownerAfter.status).toBe(200);
      expect(await ownerAfter.json()).toMatchObject({
        json: {
          created: true,
          meetingId: first.json.meetingId,
          bots: expect.arrayContaining([
            expect.objectContaining({ name: "CEO Assistant" }),
            expect.objectContaining({ name: "Research Bot" }),
            expect.objectContaining({ name: "Finance Bot" }),
            expect.objectContaining({ name: "Operations Bot" }),
          ]),
        },
      });

      const repeated = await post("workforce/company/create", {}, ownerCookie);
      expect(repeated.status).toBe(200);
      const second = (await repeated.json()) as {
        json: { bots: Array<{ id: string }>; meetingId: string | null };
      };
      expect(second.json.bots.map((bot) => bot.id)).toEqual(first.json.bots.map((bot) => bot.id));
      expect(second.json.meetingId).toBe(first.json.meetingId);

      const demoBefore = await post("workforce/demo/status", {}, ownerCookie);
      expect(demoBefore.status).toBe(200);
      expect(await demoBefore.json()).toMatchObject({ json: { created: false } });

      const demoLaunch = await post("workforce/demo/launch", {}, ownerCookie);
      expect(demoLaunch.status).toBe(200);
      const demoFirst = (await demoLaunch.json()) as {
        json: {
          created: boolean;
          meetingId: string;
          meetingTitle: string;
          bots: Array<{ id: string }>;
        };
      };
      expect(demoFirst.json.created).toBe(true);
      expect(demoFirst.json.meetingId).toBeTruthy();
      expect(demoFirst.json.meetingTitle).toBe(
        "Launch RabbitBots on GitHub — AI Company Launch Strategy",
      );
      const demoAgain = await post("workforce/demo/launch", {}, ownerCookie);
      expect(demoAgain.status).toBe(200);
      expect((await demoAgain.json()) as unknown).toMatchObject({
        json: { meetingId: demoFirst.json.meetingId },
      });

      const otherStatus = await post("workforce/company/status", {}, otherCookie);
      expect(otherStatus.status).toBe(200);
      expect(await otherStatus.json()).toMatchObject({
        json: { created: false, bots: [], meetingId: null },
      });
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
