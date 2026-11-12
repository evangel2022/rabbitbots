import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import { BotAvatar, Button, cn } from "@rakazo/ui-web";
import { Maximize2, MousePointerClick, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { ComponentProps } from "react";
import { IconTooltip } from "../../components/IconTooltip";
import { ComputerPanel } from "./computer-panel";
import { computerLabel } from "./computer-view";

type WorkspacePanelProps = Omit<ComponentProps<typeof ComputerPanel>, "variant" | "onStart">;

/**
 * The always-on computer rail. It is the same panel the bot settings used, given the width and
 * height of a column; it never invents a screen, so an unstarted computer shows its real state.
 */
export function ComputerWorkspace({
  bot,
  computer,
  booting,
  hasControl,
  onCollapse,
  onOpen,
  onStart,
  onTakeControl,
  ...panel
}: WorkspacePanelProps & {
  bot: Bot;
  booting: boolean;
  hasControl: boolean;
  onCollapse: () => void;
  onOpen: () => void;
  onStart: () => void;
  onTakeControl: () => void;
}) {
  const { t } = useLingui();
  const status = workspaceStatus(computer, booting, panel.showComputerRecoveryHint, hasControl);
  return (
    <aside
      data-testid="computer-workspace"
      data-state="open"
      className="relative hidden w-[360px] shrink-0 flex-col border-s border-sidebar-border bg-background xl:flex 2xl:w-[400px]"
    >
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-3.5">
        <BotAvatar
          avatarSet={bot.avatarSet}
          color={bot.color}
          identity={bot.id}
          size={24}
          status={bot.status}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body-sm font-medium text-foreground" dir="auto">
            {computerLabel(computer?.mode, bot.name)}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-label text-muted-foreground">
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.dot)} />
            <span className="truncate">{status.label}</span>
          </div>
        </div>
        {computer?.state === "running" && !hasControl ? (
          <IconTooltip label={t`Take control`}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Take control`}
              onClick={onTakeControl}
            >
              <MousePointerClick size={15} strokeWidth={1.8} aria-hidden="true" />
            </Button>
          </IconTooltip>
        ) : null}
        <IconTooltip label={t`Open in full window`}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Open in full window`}
            onClick={onOpen}
          >
            <Maximize2 size={15} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        </IconTooltip>
        <IconTooltip label={t`Hide computer`}>
          <Button variant="ghost" size="icon-sm" aria-label={t`Hide computer`} onClick={onCollapse}>
            <PanelRightClose size={15} strokeWidth={1.8} aria-hidden="true" />
          </Button>
        </IconTooltip>
      </header>
      <div className="min-h-0 flex-1 p-3">
        <ComputerPanel
          {...panel}
          bot={bot}
          computer={computer}
          booting={booting}
          variant="workspace"
          onStart={onStart}
          onOpen={onOpen}
        />
      </div>
    </aside>
  );
}

/** The 48px edge left when the rail is hidden, so one click brings it back. */
export function ComputerWorkspaceRail({
  computer,
  onOpen,
}: {
  computer: ComputerStatus | null;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const running = computer?.state === "running";
  return (
    <aside
      data-testid="computer-workspace-rail"
      className="hidden w-12 shrink-0 flex-col items-center gap-3 border-s border-sidebar-border bg-sidebar py-3 xl:flex"
    >
      <IconTooltip side="inline-end" label={t`Show computer`}>
        <Button variant="ghost" size="icon-sm" aria-label={t`Show computer`} onClick={onOpen}>
          <PanelRightOpen size={16} strokeWidth={1.8} aria-hidden="true" />
        </Button>
      </IconTooltip>
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", running ? "bg-success" : "bg-muted-foreground/40")}
      />
    </aside>
  );
}

function workspaceStatus(
  computer: ComputerStatus | null,
  booting: boolean,
  unavailable: boolean,
  hasControl: boolean,
): { label: string; dot: string } {
  if (unavailable) return { label: t`Unavailable`, dot: "bg-muted-foreground/40" };
  if (booting || computer?.state === "booting")
    return { label: t`Starting…`, dot: "bg-status-working" };
  if (computer?.state === "running")
    return hasControl
      ? { label: t`You have control`, dot: "bg-success" }
      : { label: t`Live`, dot: "bg-success" };
  if (computer?.state === "suspended") return { label: t`Asleep`, dot: "bg-muted-foreground/40" };
  if (computer?.state === "stopped") return { label: t`Stopped`, dot: "bg-muted-foreground/40" };
  if (computer?.state === "error") return { label: t`Error`, dot: "bg-destructive" };
  return { label: t`Not started`, dot: "bg-muted-foreground/40" };
}
