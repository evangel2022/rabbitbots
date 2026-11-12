import { t } from "@lingui/core/macro";
import type {
  OrchestrationChildStatus,
  OrchestrationChildView,
  OrchestrationView,
} from "@rakazo/contracts";
import { Button, cn } from "@rakazo/ui-web";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Clock3,
  GitBranch,
  Loader2,
  XCircle,
} from "lucide-react";

/** The parent chat's compact delegation status: three real states and the final report entry. */
export function OrchestrationStrip({
  orchestration,
  onOpenBot,
  onOpenReport,
}: {
  orchestration: OrchestrationView;
  onOpenBot: (botId: string) => void;
  onOpenReport: (messageId: string | null) => void;
}) {
  const overall = overallLabel(orchestration);
  return (
    <div
      data-testid="orchestration-strip"
      data-status={orchestration.status}
      className="rounded-xl border border-border bg-muted/40 px-3.5 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <GitBranch
          size={14}
          strokeWidth={1.8}
          aria-hidden
          className="shrink-0 text-muted-foreground"
        />
        <span
          className="min-w-0 flex-1 truncate text-body-sm font-medium text-foreground"
          dir="auto"
          title={orchestration.goal}
        >
          {orchestration.goal}
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-label",
            orchestration.status === "failed"
              ? "text-destructive"
              : orchestration.status === "completed" && orchestration.outcome === "partial"
                ? "text-warning"
                : "text-muted-foreground",
          )}
        >
          {overall.spinning ? (
            <Loader2
              size={12}
              strokeWidth={2}
              className="animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : orchestration.status === "failed" ? (
            <XCircle size={12} strokeWidth={2} aria-hidden />
          ) : orchestration.outcome === "partial" ? (
            <Clock3 size={12} strokeWidth={2} aria-hidden />
          ) : (
            <CheckCircle2 size={12} strokeWidth={2} aria-hidden />
          )}
          {overall.label}
        </span>
        {orchestration.reportMessageId ? (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => onOpenReport(orchestration.reportMessageId)}
          >
            {t`View report`}
            <ArrowRight size={13} strokeWidth={1.9} aria-hidden />
          </Button>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {orchestration.children.map((child) => (
          <ChildChip key={child.id} child={child} onOpen={() => onOpenBot(child.botId)} />
        ))}
        {orchestration.status === "joining" ? (
          <span className="text-label text-muted-foreground">{t`Writing the final report…`}</span>
        ) : null}
        {orchestration.status === "failed" ? (
          <span className="text-label text-destructive">
            {orchestration.children.find((child) => child.error)?.error ?? t`Delegation failed`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ChildChip({ child, onOpen }: { child: OrchestrationChildView; onOpen: () => void }) {
  const status = childStatusLabel(child.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={child.error ?? undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-label outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        child.status === "failed" || child.status === "timed_out"
          ? "text-destructive"
          : "text-foreground",
      )}
    >
      <ChildStatusIcon status={child.status} />
      <span className="font-medium">{child.botName}</span>
      <span className="text-muted-foreground">{status}</span>
    </button>
  );
}

function ChildStatusIcon({ status }: { status: OrchestrationChildStatus }) {
  if (status === "completed")
    return <CheckCircle2 size={12} strokeWidth={2} className="text-success" aria-hidden />;
  if (status === "failed" || status === "timed_out")
    return <XCircle size={12} strokeWidth={2} aria-hidden />;
  if (status === "running")
    return (
      <Loader2
        size={12}
        strokeWidth={2}
        className="animate-spin text-status-working motion-reduce:animate-none"
        aria-hidden
      />
    );
  return <Circle size={12} strokeWidth={2} className="text-muted-foreground" aria-hidden />;
}

function overallLabel(orchestration: OrchestrationView): { label: string; spinning: boolean } {
  if (orchestration.status === "running") return { label: t`Delegation running`, spinning: true };
  if (orchestration.status === "joining") return { label: t`Writing final report`, spinning: true };
  if (orchestration.status === "failed") return { label: t`Delegation failed`, spinning: false };
  if (orchestration.outcome === "partial")
    return { label: t`Report ready · partial`, spinning: false };
  return { label: t`Report ready`, spinning: false };
}

function childStatusLabel(status: OrchestrationChildStatus): string {
  if (status === "pending") return t`Queued`;
  if (status === "running") return t`Working`;
  if (status === "completed") return t`Done`;
  if (status === "timed_out") return t`Timed out`;
  return t`Failed`;
}
