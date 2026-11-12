#!/usr/bin/env node
// Creates (or reuses) the RabbitBots investor-demo account and its three preset bots.
//
// The roster is data, not hardcoded UI, so the demo account is provisioned through the same
// public RPC the app uses. Safe to rerun: existing bots are matched by spawnKey, then by name.
//
//   node scripts/rabbitbots-demo-seed.mjs [--base-url http://127.0.0.1:5173]
//                                        [--email you@example.com] [--password ...]
//
// Prints the demo credentials once; it stores nothing on disk.

import { randomBytes } from "node:crypto";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith("--") && value) args.set(key.slice(2), value);
}

const base = (
  args.get("base-url") ??
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: optional demo override, not a turbo task
  process.env.RABBITBOTS_BASE_URL ??
  "http://127.0.0.1:5173"
).replace(/\/+$/, "");
const email =
  args.get("email") ??
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: optional demo credential, not a turbo task
  process.env.RABBITBOTS_DEMO_EMAIL ??
  `rabbitbots.demo.${Date.now()}@example.com`;
const password =
  args.get("password") ??
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: optional demo credential, not a turbo task
  process.env.RABBITBOTS_DEMO_PASSWORD ??
  `RabbitBots-${randomBytes(9).toString("base64url")}`;

const PRESETS = [
  {
    name: "CEO Assistant",
    spawnKey: "rabbitbots:ceo",
    color: "#A97EFE",
    description: "Executive office · priorities and follow-ups",
    instructions:
      "You are the CEO Assistant for RabbitBots. Keep the executive office moving: summarize decisions, draft follow-ups, track commitments and surface what needs the CEO today. Be concise, concrete and proactive. Never invent status you cannot verify from the workspace. For a combined investment analysis that needs both market research and financial analysis, call start_parallel_delegation once with one task for Research Bot and one for Finance Bot, then end your turn. Do not do their work yourself and do not use message_bot for those two tasks. When both settle you will be asked for the final report: write Task goal, Research, Finance, Synthesis, Risks and open questions, and Subtask status. Never present a failed or timed-out child as complete; label the report partial.",
  },
  {
    name: "Research Bot",
    spawnKey: "rabbitbots:research",
    color: "#1CC3B0",
    description: "Research · sources, options and briefs",
    disabledBuiltinTools: [
      "computer_observe",
      "computer_act",
      "list_files",
      "read_file",
      "write_file",
      "attach_file",
      "shell",
      "open_path",
      "launch_app",
      "request_takeover",
      "ask_user",
      "message_user",
      "message_bot",
      "handoff_to_bot",
      "start_parallel_delegation",
      "user_computer_shell",
      "user_computer_observe",
      "user_computer_act",
    ],
    instructions:
      "You are the Research Bot for RabbitBots. Answer questions with sourced, current research: state what is known, what is uncertain, and what to check next. Prefer primary sources, compare alternatives and end with a short brief the team can act on. Your final answer is the deliverable and is collected automatically; do not message the requester. Use web_search and web_fetch for current public information and cite sources and dates when available. For a real website, use the browser tools on your computer: browser_navigate to open a URL, browser_snapshot to read the page, and browser_act only for a needed interaction. Start by navigating to the given site and read the snapshot before acting. Cite the pages you actually opened and say what you could not verify. Never claim a page you did not open.",
  },
  {
    name: "Finance Bot",
    spawnKey: "rabbitbots:finance",
    color: "#00C972",
    description: "Finance · spend, scenarios and risks",
    disabledBuiltinTools: [
      "computer_observe",
      "computer_act",
      "browser_navigate",
      "browser_snapshot",
      "browser_act",
      "list_files",
      "read_file",
      "write_file",
      "attach_file",
      "shell",
      "open_path",
      "launch_app",
      "request_takeover",
      "ask_user",
      "message_user",
      "message_bot",
      "handoff_to_bot",
      "start_parallel_delegation",
      "user_computer_shell",
      "user_computer_observe",
      "user_computer_act",
    ],
    instructions:
      "You are the Finance Bot for RabbitBots. Track spend and runway, build simple scenarios, and flag risks early. Show the assumptions behind every number and separate facts from estimates. Your final answer is the deliverable and is collected automatically; do not message the requester. Use public information and clearly labeled assumptions, never invented figures. Cover business model, revenue and pricing, unit economics, financial risks and scenarios. Never use a computer or browser: this bot works from web search and fetch only.",
  },
];

function cookieHeader(setCookies) {
  return setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

async function signIn() {
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password, name: "RabbitBots Demo" }),
  });
  if (response.ok) return cookieHeader(response.headers.getSetCookie());
  const retry = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password }),
  });
  if (!retry.ok) throw new Error(`Could not sign up or sign in: ${retry.status}`);
  return cookieHeader(retry.headers.getSetCookie());
}

function rpc(cookie, procedure, body) {
  return fetch(`${base}/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, cookie },
    body: JSON.stringify({ json: body }),
  }).then(async (response) => {
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${procedure} ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!response.ok || parsed.error) {
      throw new Error(`${procedure} ${response.status}: ${parsed.error?.message ?? text}`);
    }
    return parsed.json;
  });
}

async function main() {
  const cookie = await signIn();
  let me;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      me = await rpc(cookie, "me", {});
      break;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  if (me.spaceId) {
    await rpc(cookie, "spaces/rename", {
      spaceId: me.spaceId,
      name: "RabbitBots HQ",
    }).catch(() => undefined);
  }

  const existing = await rpc(cookie, "bots/list", {});
  const bots = [];
  for (const preset of PRESETS) {
    const found =
      existing.find((bot) => bot.spawnKey === preset.spawnKey) ??
      existing.find((bot) => bot.name === preset.name);
    if (found) {
      // Keep an existing demo account on the current preset, including its delegation rules.
      await rpc(cookie, "bots/update", {
        botId: found.id,
        description: preset.description,
        instructions: preset.instructions,
        ...(preset.disabledBuiltinTools
          ? { disabledBuiltinTools: preset.disabledBuiltinTools }
          : {}),
      }).catch((error) => {
        console.warn(`Could not update ${preset.name}: ${error.message}`);
      });
      bots.push({ id: found.id, name: found.name });
      continue;
    }
    try {
      const created = await rpc(cookie, "bots/create", {
        name: preset.name,
        description: preset.description,
        instructions: preset.instructions,
        disabledBuiltinTools: preset.disabledBuiltinTools,
        notifyOnFinish: true,
        computerMode: "dedicated",
        color: preset.color,
        spawnKey: preset.spawnKey,
      });
      if (preset.disabledBuiltinTools) {
        // bots/create has no tool list; the settings update is where a new bot gets one.
        await rpc(cookie, "bots/update", {
          botId: created.id,
          disabledBuiltinTools: preset.disabledBuiltinTools,
        }).catch((error) => {
          console.warn(`Could not set tools for ${preset.name}: ${error.message}`);
        });
      }
      bots.push({ id: created.id, name: created.name });
    } catch (error) {
      const after = await rpc(cookie, "bots/list", {});
      const raced = after.find((bot) => bot.name === preset.name);
      if (!raced) throw error;
      bots.push({ id: raced.id, name: raced.name });
    }
  }

  console.log("RabbitBots demo account is ready.\n");
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log(`  app:      ${base}/app/${bots[0].id}`);
  console.log(`  bots:     ${bots.map((bot) => `${bot.name} (${bot.id})`).join(", ")}`);
  console.log("\nSet RABBITBOTS_DEMO_EMAIL and RABBITBOTS_DEMO_PASSWORD to reuse this account.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
