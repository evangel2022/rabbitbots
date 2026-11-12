import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { Loader2, Play, Sparkles } from "lucide-react";
import { useState } from "react";

/**
 * The one-click investor story: a real CEO/Research/Finance team and a real task. This is only a
 * prompt; no report or execution state is stored here.
 */
export const INVESTOR_DEMO_TASK = [
  "请对 Glean 公司进行一次投资前商业尽调。",
  "Research Bot 负责研究市场定位、竞争对手、产品功能、公开客户案例和行业趋势；",
  "Finance Bot 负责分析商业模式、收入来源、盈利能力、成本结构、融资情况及财务风险。",
  "最后 CEO 综合双方结果，形成一份专业投资分析报告，指出投资机会、主要风险、估值信息缺口和需要进一步核实的问题。",
  "这是新一轮演示：请重新执行并行委派，不要复用本对话中已有的报告或子任务结果。",
].join("");

export interface InvestorDemoTeam {
  ceo: Bot;
  research: Bot;
  finance: Bot;
}

/** The seeded demo roster, identified by spawn key with a display-name fallback. */
export function findInvestorDemoTeam(bots: readonly Bot[]): InvestorDemoTeam | null {
  const find = (spawnKey: string, name: string) =>
    bots.find((bot) => bot.spawnKey === spawnKey) ?? bots.find((bot) => bot.name === name);
  const ceo = find("rabbitbots:ceo", "CEO Assistant");
  const research = find("rabbitbots:research", "Research Bot");
  const finance = find("rabbitbots:finance", "Finance Bot");
  return ceo && research && finance ? { ceo, research, finance } : null;
}

export const INVESTOR_DEMO_ROLES = [
  {
    key: "ceo",
    title: "CEO Assistant",
    responsibility: "Sets the brief, delegates to both specialists and writes the final report.",
  },
  {
    key: "research",
    title: "Research Bot",
    responsibility: "Market position, competitors, product evidence and customer cases.",
  },
  {
    key: "finance",
    title: "Finance Bot",
    responsibility: "Business model, revenue, funding and financial risk.",
  },
] as const;

function RoleRow({
  bot,
  title,
  responsibility,
}: {
  bot: Bot;
  title: string;
  responsibility: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <BotAvatar
        avatarSet={bot.avatarSet}
        color={bot.color}
        identity={bot.id}
        size={28}
        status={bot.status}
      />
      <div className="min-w-0">
        <div className="truncate text-body-sm font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-label leading-[1.45] text-muted-foreground">
          {responsibility}
        </div>
      </div>
    </div>
  );
}

function RoleGrid({ team }: { team: InvestorDemoTeam }) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-3">
      {INVESTOR_DEMO_ROLES.map((role) => (
        <RoleRow
          key={role.key}
          bot={team[role.key]}
          title={role.title}
          responsibility={role.responsibility}
        />
      ))}
    </div>
  );
}

/**
 * The first-visit entry above the CEO transcript. It explains the three jobs and opens the
 * confirmation step; it never replaces the composer or writes a canned result.
 */
export function InvestorDemoWelcome({
  team,
  busy,
  onStart,
}: {
  team: InvestorDemoTeam;
  busy: boolean;
  onStart: () => void;
}) {
  return (
    <section
      data-testid="investor-demo-welcome"
      className="overflow-hidden rounded-xl border border-border bg-muted/30"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-label font-medium text-muted-foreground">
            <Sparkles size={13} strokeWidth={1.8} aria-hidden />
            <Trans>Investor demo</Trans>
          </div>
          <h2 className="mt-1 text-body-lg font-medium text-foreground">
            <Trans>Glean investment due diligence</Trans>
          </h2>
          <p className="mt-1 max-w-[44rem] text-body-sm leading-[1.45] text-muted-foreground">
            <Trans>
              CEO Assistant splits the work across Research Bot and Finance Bot, waits for both,
              then writes the investment report. It is a live run, not a canned answer.
            </Trans>
          </p>
        </div>
        <Button
          size="sm"
          onClick={onStart}
          disabled={busy}
          data-testid="investor-demo-open"
          className="shrink-0"
        >
          <Play size={13} strokeWidth={2} aria-hidden />
          <Trans>Start investor demo</Trans>
        </Button>
      </div>
      <div className="border-t border-border/70 px-4 py-3">
        <RoleGrid team={team} />
      </div>
    </section>
  );
}

/**
 * Confirmation before a real run. The full preset is shown and the user can cancel; the composer
 * underneath remains available for a custom task.
 */
export function InvestorDemoDialog({
  team,
  busy,
  onClose,
  onStart,
}: {
  team: InvestorDemoTeam;
  busy: boolean;
  onClose: () => void;
  onStart: () => Promise<boolean>;
}) {
  const { t } = useLingui();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (busy || starting) return;
    setError(null);
    setStarting(true);
    try {
      const started = await onStart();
      if (started) onClose();
      else setError(t`Could not start the demo. Check the chat error and try again.`);
    } catch {
      setError(t`Could not start the demo. Check the chat error and try again.`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !starting) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        data-testid="investor-demo-dialog"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Start the investor demo?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              This sends the task to CEO Assistant and runs Research Bot and Finance Bot for real.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-3">
          <RoleGrid team={team} />
        </div>
        <div>
          <div className="mb-1.5 text-label font-medium text-muted-foreground">
            <Trans>Task</Trans>
          </div>
          <div
            className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-body-sm leading-[1.5] text-foreground"
            data-testid="investor-demo-task"
          >
            {INVESTOR_DEMO_TASK}
          </div>
        </div>
        {busy ? (
          <p className="text-body-sm text-muted-foreground">
            <Trans>A run is already active in this chat. Wait for it to finish.</Trans>
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={starting}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            onClick={() => void start()}
            disabled={busy || starting}
            data-testid="investor-demo-start"
          >
            {starting ? (
              <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Play size={14} strokeWidth={2} aria-hidden />
            )}
            <Trans>Start investor demo</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
