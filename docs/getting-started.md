# Getting started

RabbitBots gives you persistent AI bots. Each one has its own conversations, memory, routines, and
computer, and keeps working on the web, desktop, and mobile apps.

## Start RabbitBots

Use the [source or published-image quick start](../README.md#quick-start). The source quick start starts the web app, API, worker and a local Postgres database; open the URL it prints.

## Create your AI Company

1. Create an account. A new account with no AI Company opens the first-run wizard.
2. Choose **Create Your AI Company**.
3. Name the Company, keep the four default AI employees or adjust their names and responsibilities.
4. Connect a model, or choose **Skip for now** if you only want to set up the Company first.
5. Choose **Create Your AI Company**. This is the explicit write action; it creates one Company profile, four AI employees and one draft Executive Boardroom. It is idempotent, so retrying or refreshing does not duplicate Bots.
6. If you skipped the model, Company Ready explains that a model is required before work can run.

## Connect a model

Connect a model during onboarding or later in **Settings → Models**. A subscription, a provider API key, or an OpenAI-compatible local server all work. The form performs a real server probe/test before saving; a wrong key or unreachable server is shown as a failure, not a connected state.

## Start your first task

From Company Ready choose **Start Your First Task**, describe one clear outcome, and send it. RabbitBots creates a real Workforce task, assigns it to the CEO Assistant, and starts the existing run/worker path. Follow the Task/Run history in **AI Workforce** and open the **Executive Boardroom** for the meeting and approval surface. Results remain `CEO: not accepted` until the human CEO accepts them.

## Create another bot

After your AI Company exists, you can still add ordinary Bots from the normal Bot picker. Existing Companies and Bots are never replaced by the onboarding flow.

## Connect your apps

Bots work in the apps you already use: Gmail, Slack, Notion, GitHub, and
[1,400+ more](./integrations.md). Ask a bot to connect one and approve the sign-in it sends you. See
[Connect apps](./integrations.md).

## Give it a schedule

Ask for a routine, such as "every weekday at 8am, summarize my inbox". The bot runs it on its own
computer and reports back in the same chat. See [Routines](./routines.md).

## Decide what it can do alone

Choose whether bots ask before acting in [Approvals](./approvals.md).

## Bring an agent you already have

Coming from OpenClaw, Hermes or another assistant? [Import it](./import-an-agent.md) as a new bot.
