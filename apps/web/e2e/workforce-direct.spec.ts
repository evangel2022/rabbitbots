import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("CEO creates a direct task and it survives the Workforce reload", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `workforce-direct-${stamp}@rakazo.test`, "password12", "Workforce CEO");
  await completeOnboarding(page, testInfo);
  await page.goto("/app/workforce", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "AI Workforce", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Task title").fill(`Board evidence review ${stamp}`);
  await page
    .getByLabel("Task description")
    .fill("Review the persisted evidence and return a short verification note.");
  await page
    .getByLabel("Acceptance criteria")
    .fill("A verification note exists and names each source it uses.");
  await page.getByLabel("Assignee bot").selectOption({ index: 1 });
  await page.getByTestId("create-direct-task").click();

  const taskTitle = page.getByText(`Board evidence review ${stamp}`, { exact: true }).first();
  await expect(taskTitle).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("CEO direct", { exact: false }).first()).toBeVisible();
  await captureScreenshot(page, testInfo, "workforce-direct-task");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "AI Workforce", exact: true })).toBeVisible();
  await page.getByLabel("Task source").selectOption("CEO_DIRECT");
  await expect(
    page.getByText(`Board evidence review ${stamp}`, { exact: true }).first(),
  ).toBeVisible({
    timeout: 15_000,
  });
  await captureScreenshot(page, testInfo, "workforce-direct-task-refresh");
});
