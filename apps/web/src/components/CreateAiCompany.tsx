import { Trans } from "@lingui/react/macro";
import type { WorkforceCompanyStatus } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { BriefcaseBusiness, Check, Landmark, LoaderCircle, Users } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";

export const DEFAULT_ROLES = [
  {
    key: "ceo",
    role: "CEO Assistant",
    description:
      "Chairs the boardroom, frames decisions and coordinates the company. The human CEO remains the final authority.",
  },
  {
    key: "research",
    role: "Research Bot",
    description:
      "Finds evidence, compares options and separates facts from assumptions and open questions.",
  },
  {
    key: "finance",
    role: "Finance Bot",
    description:
      "Analyzes budgets, costs and scenarios without inventing financial data or approving spend.",
  },
  {
    key: "operations",
    role: "Operations Bot",
    description:
      "Turns approved decisions into checklists, owners and checkpoints without bypassing the CEO.",
  },
] as const;

type Props = {
  status: WorkforceCompanyStatus | undefined;
  busy: boolean;
  error: string | null;
  onCreate: () => Promise<void>;
  secondary?: boolean;
};

export function CreateAiCompany({ status, busy, error, onCreate, secondary = false }: Props) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const busyNow = busy || submitting;
  const created = Boolean(status?.created);
  async function submit() {
    if (busyNow || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    try {
      await onCreate();
      setOpen(false);
    } catch {
      // The parent owns the error state and keeps the dialog open for retry.
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }
  const bots = status?.bots ?? [];

  if (created) {
    return (
      <section
        data-testid="ai-company-ready"
        className="mb-3 rounded-xl border border-success/30 bg-success/5 p-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Check size={15} className="text-success" />
          <span className="text-body-sm font-medium">
            <Trans>AI Company is ready</Trans>
          </span>
          <span className="text-label text-muted-foreground">
            {bots.length} AI employees · {status?.meetingTitle}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {bots.map((bot) => (
            <span
              key={bot.id}
              className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-label"
            >
              <BriefcaseBusiness size={12} />
              {bot.name}
            </span>
          ))}
          {status?.meetingId ? (
            <Link
              to={`/app/meetings?meeting=${status.meetingId}`}
              data-testid="open-boardroom"
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-secondary px-2.5 text-body-sm font-medium text-secondary-foreground hover:bg-accent"
            >
              <Landmark size={13} />
              <Trans>Open Executive Boardroom</Trans>
            </Link>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <>
      <section
        data-testid={secondary ? "create-ai-company-secondary" : "create-ai-company"}
        className={
          secondary
            ? "mb-3 rounded-xl border border-border bg-background p-3"
            : "mb-3 rounded-xl border border-dashed border-primary/30 bg-primary/5 p-4"
        }
      >
        <div className="flex flex-wrap items-start gap-3">
          <div
            className={
              secondary
                ? "grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground"
                : "grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground"
            }
          >
            <Users size={secondary ? 15 : 17} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-body font-medium">
              {secondary ? (
                <Trans>Create a Custom AI Company</Trans>
              ) : (
                <Trans>Create your AI Company</Trans>
              )}
            </h2>
            <p className="mt-0.5 text-body-sm text-muted-foreground">
              {secondary ? (
                <Trans>
                  Create an AI Company with four AI employees and an initial strategy meeting.
                  Nothing is approved or executed automatically.
                </Trans>
              ) : (
                <Trans>
                  Start with four AI employees and a first boardroom meeting. Nothing is approved or
                  executed automatically.
                </Trans>
              )}
            </p>
          </div>
          <Button
            size="sm"
            variant={secondary ? "secondary" : "default"}
            data-testid="create-ai-company-open"
            onClick={() => setOpen(true)}
            disabled={busyNow}
          >
            {busyNow ? <LoaderCircle size={13} className="animate-spin" /> : <Users size={13} />}
            {secondary ? (
              <Trans>Create a Custom AI Company</Trans>
            ) : (
              <Trans>Create AI Company</Trans>
            )}
          </Button>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {DEFAULT_ROLES.map((role) => (
            <div key={role.key} className="rounded-lg border bg-background p-2.5">
              <div className="text-label font-medium">{role.role}</div>
              <p className="mt-0.5 text-label text-muted-foreground">{role.description}</p>
            </div>
          ))}
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-body-sm text-destructive">
            {error}
            <Button
              size="sm"
              variant="secondary"
              className="ms-2"
              onClick={() => void submit()}
              disabled={busyNow}
            >
              <Trans>Retry</Trans>
            </Button>
          </p>
        ) : null}
      </section>

      <Dialog open={open} onOpenChange={(next) => !busyNow && setOpen(next)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              <Trans>Create your AI Company</Trans>
            </DialogTitle>
          </DialogHeader>
          <p className="text-body-sm text-muted-foreground">
            <Trans>
              This creates four employees and a draft strategy meeting. It does not approve
              decisions, start tasks, or spend money.
            </Trans>
          </p>
          <div className="mt-3 space-y-2">
            {DEFAULT_ROLES.map((role) => (
              <div key={role.key} className="rounded-lg border p-2.5">
                <div className="text-label font-medium">{role.role}</div>
                <div className="mt-0.5 text-label text-muted-foreground">{role.description}</div>
              </div>
            ))}
          </div>
          {error ? (
            <p role="alert" className="mt-3 text-body-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busyNow}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              data-testid="create-ai-company-confirm"
              onClick={() => void submit()}
              disabled={busyNow}
            >
              {busyNow ? <LoaderCircle size={13} className="animate-spin" /> : <Users size={13} />}
              {busyNow ? <Trans>Creating…</Trans> : <Trans>Create AI Company</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
