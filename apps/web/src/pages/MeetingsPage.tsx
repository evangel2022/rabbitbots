import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  Bot,
  MeetingActionAcceptanceAction,
  MeetingActionItemView,
  MeetingApprovalAction,
  MeetingDecisionView,
  MeetingMessageView,
  MeetingStatus,
  MeetingView,
} from "@rakazo/contracts";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Landmark, Plus, RefreshCw, Send, Users, Wifi, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MeetingStructuredTurn } from "../components/MeetingStructuredContent";
import { getActiveUiLocale } from "../lib/i18n";
import { mergeMeetingTranscript } from "../lib/meeting-transcript";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

const ACTIVE_STATUSES = new Set([
  "PREPARING",
  "OPENING",
  "REPORTING",
  "DISCUSSION",
  "DECISION",
  "CLOSING",
]);

const TERMINAL_STATUSES = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

const DEFAULT_AGENDA = [
  "Market opportunity",
  "Competitive position",
  "Financial feasibility",
  "Key investment risks",
  "Final recommendation",
];

const STATUS_LABELS: Record<MeetingStatus, string> = {
  DRAFT: "Draft",
  PREPARING: "Preparing",
  OPENING: "Opening",
  REPORTING: "Reporting",
  DISCUSSION: "Discussion",
  DECISION: "Decision",
  CLOSING: "Closing",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

function statusTone(status: MeetingStatus) {
  if (status === "FAILED") return "text-destructive";
  if (status === "CANCELLED") return "text-muted-foreground";
  if (status === "COMPLETED") return "text-success";
  if (status === "DRAFT") return "text-muted-foreground";
  return "text-status-working";
}

function agendaStatusLabel(status: string) {
  if (status === "ACTIVE") return "Active";
  if (status === "DISCUSSION") return "Discussion";
  if (status === "DECIDED") return "Decided";
  if (status === "DEFERRED") return "Deferred";
  return "Pending";
}

function statusDot(status: MeetingStatus) {
  if (status === "FAILED") return "bg-destructive";
  if (status === "COMPLETED") return "bg-success";
  if (status === "DRAFT" || status === "CANCELLED") return "bg-muted-foreground/50";
  return "bg-status-working";
}

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(getActiveUiLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function decisionLabel(decision: MeetingDecisionView) {
  return decision.decisionType.replaceAll("_", " ").toLowerCase();
}

function approvalStatusLabel(status: string) {
  return status.replaceAll("_", " ").toLowerCase();
}

function approvalActionLabel(action: MeetingApprovalAction) {
  if (action === "APPROVE") return "Approve";
  if (action === "APPROVE_WITH_CONDITIONS") return "Approve with conditions";
  if (action === "REJECT") return "Reject";
  return "Defer";
}

function evidenceSources(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== "object") return [];
  const sources = (evidence as { sources?: unknown }).sources;
  return Array.isArray(sources)
    ? sources.filter((source): source is string => typeof source === "string")
    : [];
}

function isActive(meeting: MeetingView | undefined) {
  return Boolean(meeting && ACTIVE_STATUSES.has(meeting.status));
}

function hasRunningAction(meeting: MeetingView | undefined) {
  return Boolean(meeting?.actionItems.some((item) => item.executionStatus === "IN_PROGRESS"));
}

export function MeetingsPage() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get("meeting");
  const [createOpen, setCreateOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [selectedAgendaId, setSelectedAgendaId] = useState<string | null>(null);
  const [humanMessages, setHumanMessages] = useState<MeetingMessageView[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [messageSending, setMessageSending] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [messageConnection, setMessageConnection] = useState<
    "connecting" | "live" | "reconnecting"
  >("connecting");
  const [conditionsDecision, setConditionsDecision] = useState<MeetingDecisionView | null>(null);
  const [conditionsSubmitting, setConditionsSubmitting] = useState(false);
  const [conditionsError, setConditionsError] = useState<string | null>(null);
  const [actionReview, setActionReview] = useState<{
    action: MeetingActionItemView;
    actionType: MeetingActionAcceptanceAction;
  } | null>(null);
  const [actionComment, setActionComment] = useState("");
  const [actionReviewSubmitting, setActionReviewSubmitting] = useState(false);
  const [actionReviewError, setActionReviewError] = useState<string | null>(null);
  const actionNonce = useRef<string | null>(null);
  const lastMessageSeq = useRef(0);
  const draftNonce = useRef<string | null>(null);
  const [approvalDraft, setApprovalDraft] = useState<{
    decision: MeetingDecisionView;
    action: MeetingApprovalAction;
  } | null>(null);
  const [approvalRationale, setApprovalRationale] = useState("");
  const [approvalConditions, setApprovalConditions] = useState("");
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const approvalNonce = useRef<string | null>(null);

  const botsQuery = useQuery({ queryKey: ["meetings", "bots"], queryFn: () => rpc.bots.list() });
  const listQuery = useQuery({
    queryKey: ["meetings", "list"],
    queryFn: () => rpc.meetings.list(),
  });
  const meetings = listQuery.data?.meetings ?? [];
  const bots = botsQuery.data ?? [];
  const effectiveId = selectedId ?? meetings[0]?.id ?? null;
  const meetingQuery = useQuery({
    queryKey: ["meetings", "get", effectiveId],
    queryFn: () => rpc.meetings.get({ meetingId: effectiveId! }),
    enabled: Boolean(effectiveId),
    refetchInterval: (query) =>
      isActive(query.state.data) || hasRunningAction(query.state.data) ? 2_000 : false,
  });
  const meeting = meetingQuery.data;
  const loadError = listQuery.error ?? botsQuery.error ?? meetingQuery.error;
  const error = actionError ?? (loadError ? errorText(loadError) : null);

  const currentAgenda = meeting?.agenda.find((item) => item.id === meeting.currentAgendaId);
  const selectedAgenda =
    meeting?.agenda.find((item) => item.id === selectedAgendaId) ?? currentAgenda;
  const selectedAgendaIdResolved = selectedAgenda?.id ?? null;
  const selectedTurns = meeting
    ? meeting.turns.filter(
        (turn) =>
          turn.phase === "OPENING" ||
          (selectedAgendaIdResolved &&
            turn.agendaId === selectedAgendaIdResolved &&
            turn.phase !== "AGENDA_REVIEW" &&
            turn.phase !== "AGENDA_EVALUATION" &&
            turn.phase !== "AGENDA_DECISION"),
      )
    : [];
  const selectedDecisions = meeting
    ? meeting.decisions.filter((decision) => decision.agendaId === selectedAgendaIdResolved)
    : [];
  const selectedResponses = meeting
    ? meeting.turns.filter(
        (turn) => turn.agendaId === selectedAgendaIdResolved && turn.phase === "AGENDA_RESPONSE",
      )
    : [];
  const selectedReview = meeting
    ? meeting.turns
        .filter(
          (turn) => turn.agendaId === selectedAgendaIdResolved && turn.phase === "AGENDA_REVIEW",
        )
        .at(-1)
    : undefined;
  const selectedRound = meeting
    ? Math.max(
        1,
        ...meeting.turns
          .filter(
            (turn) =>
              turn.agendaId === selectedAgendaIdResolved &&
              turn.phase !== "AGENDA_DECISION" &&
              turn.phase !== "SUMMARY",
          )
          .map((turn) => turn.round),
      )
    : 1;
  const currentTurn = selectedTurns.at(-1);
  const visibleHumanMessages = humanMessages.filter(
    (message) => !message.agendaId || message.agendaId === selectedAgendaIdResolved,
  );
  const transcript = mergeMeetingTranscript(selectedTurns, visibleHumanMessages);
  const terminal = meeting ? TERMINAL_STATUSES.has(meeting.status) : false;
  const pendingDecisions =
    meeting?.decisions.filter(
      (decision) => decision.approvalRequired && decision.approvalStatus === "PENDING",
    ) ?? [];
  const pendingApprovals = pendingDecisions.length;
  useEffect(() => {
    if (!meeting) return;
    setSelectedAgendaId((current) =>
      current && meeting.agenda.some((item) => item.id === current)
        ? current
        : (meeting.currentAgendaId ?? meeting.agenda[0]?.id ?? null),
    );
  }, [meeting?.id, meeting?.currentAgendaId]);
  useEffect(() => {
    if (!meeting?.id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    setHumanMessages([]);
    lastMessageSeq.current = 0;
    setMessageError(null);
    setMessageConnection("connecting");

    async function poll() {
      if (cancelled || !meeting) return;
      request = new AbortController();
      try {
        const page = await rpc.meetings.messages.list(
          {
            meetingId: meeting.id,
            afterSeq: lastMessageSeq.current,
            limit: 100,
          },
          { signal: request.signal },
        );
        if (cancelled) return;
        if (page.messages.length) {
          setHumanMessages((current) => {
            const seen = new Set(current.map((message) => message.id));
            return [...current, ...page.messages.filter((message) => !seen.has(message.id))];
          });
        }
        lastMessageSeq.current = Math.max(lastMessageSeq.current, page.nextCursor);
        setMessageConnection("live");
        if (page.hasMore) {
          timer = setTimeout(() => void poll(), 0);
          return;
        }
      } catch {
        if (cancelled) return;
        // A transient poll failure is surfaced, never hidden. The next success
        // continues from lastMessageSeq and therefore replays every missed row.
        setMessageConnection("reconnecting");
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1_500);
    }

    void poll();
    return () => {
      cancelled = true;
      request?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [meeting?.id]);

  async function sendMessage() {
    if (!meeting || terminal || messageSending) return;
    const content = messageDraft.trim();
    if (!content) return;
    const nonce = draftNonce.current ?? crypto.randomUUID();
    draftNonce.current = nonce;
    setMessageSending(true);
    setMessageError(null);
    try {
      const sent = await rpc.meetings.messages.send({
        meetingId: meeting.id,
        ...(selectedAgendaIdResolved ? { agendaId: selectedAgendaIdResolved } : {}),
        content,
        clientNonce: nonce,
      });
      lastMessageSeq.current = Math.max(lastMessageSeq.current, sent.seq);
      setHumanMessages((current) =>
        current.some((message) => message.id === sent.id) ? current : [...current, sent],
      );
      setMessageDraft("");
      draftNonce.current = null;
    } catch (cause) {
      setMessageError(errorText(cause, t`Could not send this message`));
    } finally {
      setMessageSending(false);
    }
  }

  useEffect(() => {
    if (meeting) void queryClient.invalidateQueries({ queryKey: ["meetings", "list"] });
  }, [meeting?.status, queryClient]);

  function beginApproval(decision: MeetingDecisionView, action: MeetingApprovalAction) {
    setApprovalDraft({ decision, action });
    setApprovalRationale("");
    setApprovalConditions("");
    setApprovalError(null);
    approvalNonce.current = null;
  }

  function closeApproval() {
    if (approvalSubmitting) return;
    setApprovalDraft(null);
    setApprovalRationale("");
    setApprovalConditions("");
    setApprovalError(null);
    approvalNonce.current = null;
  }

  async function submitApproval() {
    if (!meeting || !approvalDraft || approvalSubmitting) return;
    const conditions = approvalConditions.trim();
    const rationale = approvalRationale.trim();
    if (approvalDraft.action === "APPROVE_WITH_CONDITIONS" && !conditions) {
      setApprovalError(t`Conditions are required for a conditional approval.`);
      return;
    }
    if ((approvalDraft.action === "REJECT" || approvalDraft.action === "DEFER") && !rationale) {
      setApprovalError(t`A rationale is required for rejection or deferral.`);
      return;
    }
    const nonce = approvalNonce.current ?? crypto.randomUUID();
    approvalNonce.current = nonce;
    setApprovalSubmitting(true);
    setApprovalError(null);
    try {
      await rpc.meetings.decisions.approve({
        meetingId: meeting.id,
        decisionId: approvalDraft.decision.id,
        action: approvalDraft.action,
        ...(rationale ? { rationale } : {}),
        ...(approvalDraft.action === "APPROVE_WITH_CONDITIONS" ? { conditions } : {}),
        clientNonce: nonce,
      });
      setApprovalDraft(null);
      setApprovalRationale("");
      setApprovalConditions("");
      approvalNonce.current = null;
      await queryClient.invalidateQueries({ queryKey: ["meetings", "get"] });
      await meetingQuery.refetch();
    } catch (cause) {
      setApprovalError(errorText(cause, t`Could not record the approval`));
    } finally {
      setApprovalSubmitting(false);
    }
  }

  async function confirmConditions() {
    if (!meeting || !conditionsDecision || conditionsSubmitting) return;
    setConditionsSubmitting(true);
    setConditionsError(null);
    try {
      await rpc.meetings.decisions.confirmConditions({
        meetingId: meeting.id,
        decisionId: conditionsDecision.id,
        clientNonce: crypto.randomUUID(),
      });
      setConditionsDecision(null);
      await queryClient.invalidateQueries({ queryKey: ["meetings", "get"] });
      await meetingQuery.refetch();
    } catch (cause) {
      setConditionsError(errorText(cause, t`Could not confirm the conditions`));
    } finally {
      setConditionsSubmitting(false);
    }
  }

  async function runAction(action: MeetingActionItemView) {
    if (!meeting) return;
    setActionError(null);
    try {
      await rpc.meetings.actions.execute({
        meetingId: meeting.id,
        actionItemId: action.id,
        clientNonce: crypto.randomUUID(),
      });
      await queryClient.invalidateQueries({ queryKey: ["meetings", "get"] });
      await meetingQuery.refetch();
    } catch (cause) {
      setActionError(errorText(cause, t`Could not execute this action`));
    }
  }

  function beginActionReview(
    action: MeetingActionItemView,
    actionType: MeetingActionAcceptanceAction,
  ) {
    setActionReview({ action, actionType });
    setActionComment("");
    setActionReviewError(null);
    actionNonce.current = null;
  }

  function closeActionReview() {
    if (actionReviewSubmitting) return;
    setActionReview(null);
    setActionComment("");
    setActionReviewError(null);
    actionNonce.current = null;
  }

  async function submitActionReview() {
    if (!meeting || !actionReview || actionReviewSubmitting) return;
    const comment = actionComment.trim();
    if (
      (actionReview.actionType === "REJECT" ||
        actionReview.actionType === "BLOCK" ||
        actionReview.actionType === "REQUEST_EVIDENCE") &&
      !comment
    ) {
      setActionReviewError(t`A comment is required for this acceptance action.`);
      return;
    }
    const nonce = actionNonce.current ?? crypto.randomUUID();
    actionNonce.current = nonce;
    setActionReviewSubmitting(true);
    setActionReviewError(null);
    try {
      await rpc.meetings.actions.accept({
        meetingId: meeting.id,
        actionItemId: actionReview.action.id,
        action: actionReview.actionType,
        ...(comment ? { comment } : {}),
        clientNonce: nonce,
      });
      setActionReview(null);
      setActionComment("");
      actionNonce.current = null;
      await queryClient.invalidateQueries({ queryKey: ["meetings", "get"] });
      await meetingQuery.refetch();
    } catch (cause) {
      setActionReviewError(errorText(cause, t`Could not record the acceptance`));
    } finally {
      setActionReviewSubmitting(false);
    }
  }

  async function refresh() {
    setActionError(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["meetings", "list"] }),
      queryClient.invalidateQueries({ queryKey: ["meetings", "get"] }),
    ]);
  }

  async function start() {
    if (!meeting || starting) return;
    setStarting(true);
    setActionError(null);
    try {
      await rpc.meetings.start({ meetingId: meeting.id });
      await refresh();
    } catch (cause) {
      setActionError(errorText(cause, t`Could not start the meeting`));
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!meeting) return;
    setActionError(null);
    try {
      await rpc.meetings.cancel({
        meetingId: meeting.id,
        reason: "Cancelled from the Executive Boardroom.",
      });
      await refresh();
    } catch (cause) {
      setActionError(errorText(cause, t`Could not cancel the meeting`));
    }
  }

  function selectMeeting(id: string) {
    const next = new URLSearchParams(search);
    next.set("meeting", id);
    setSearch(next, { replace: true });
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <Link
          to="/app"
          className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent"
          aria-label={t`Back`}
        >
          <ChevronLeft size={17} />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Landmark size={18} strokeWidth={1.7} className="text-muted-foreground" />
          <div className="min-w-0">
            <h1 className="truncate text-body font-medium">
              <Trans>Executive Boardroom</Trans>
            </h1>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void refresh()}
          disabled={listQuery.isFetching}
        >
          <RefreshCw size={13} className={listQuery.isFetching ? "animate-spin" : undefined} />
          <Trans>Refresh</Trans>
        </Button>
        <Button size="sm" onClick={() => setCreateOpen(true)} disabled={bots.length < 2}>
          <Plus size={14} />
          <Trans>New meeting</Trans>
        </Button>
      </header>
      {error ? (
        <p
          role="alert"
          className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-body-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 flex-col border-e bg-sidebar/40 lg:flex">
          <div className="px-3 pb-2 pt-3 text-label font-medium uppercase tracking-wide text-muted-foreground">
            <Trans>Meetings</Trans>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {meetings.length === 0 ? (
              <div className="rounded-lg border border-dashed p-3 text-body-sm text-muted-foreground">
                <Trans>No meetings yet.</Trans>{" "}
                <Link
                  to="/app/workforce"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  <Trans>Create an AI Company</Trans>
                </Link>{" "}
                <Trans>or start a meeting.</Trans>
              </div>
            ) : (
              meetings.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectMeeting(item.id)}
                  data-testid={`meeting-list-${item.id}`}
                  className={cn(
                    "mb-1 w-full rounded-lg px-2.5 py-2 text-start outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    item.id === effectiveId && "bg-accent",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={cn("size-1.5 shrink-0 rounded-full", statusDot(item.status))}
                    />
                    <span className="min-w-0 flex-1 truncate text-body-sm font-medium">
                      {item.title}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-label text-muted-foreground">
                    <span className={statusTone(item.status)}>{STATUS_LABELS[item.status]}</span>
                    <span>·</span>
                    <span className="truncate">{item.chairBotName}</span>
                  </div>
                  <div className="mt-0.5 truncate text-label text-muted-foreground">
                    {item.participantNames.join(", ")}
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          {!effectiveId ? (
            <div className="grid min-h-full place-items-center px-6 text-center">
              <div className="max-w-md">
                <Landmark size={28} className="mx-auto text-muted-foreground" />
                <h2 className="mt-3 text-body-lg font-medium">
                  <Trans>Run a boardroom meeting</Trans>
                </h2>
                <p className="mt-1 text-body-sm text-muted-foreground">
                  <Trans>
                    CEO Assistant chairs, Research Bot and Finance Bot report real evidence, and the
                    meeting records decisions and actions.
                  </Trans>
                </p>
                <Button
                  className="mt-4"
                  onClick={() => setCreateOpen(true)}
                  disabled={bots.length < 2}
                >
                  <Plus size={14} />
                  <Trans>Create investor meeting</Trans>
                </Button>
              </div>
            </div>
          ) : meetingQuery.isLoading ? (
            <div className="p-6 text-body-sm text-muted-foreground">
              <Trans>Loading meeting…</Trans>
            </div>
          ) : meeting ? (
            <div className="mx-auto max-w-[64rem] px-4 py-4 sm:px-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-label">
                    <span
                      aria-hidden
                      className={cn("size-1.5 rounded-full", statusDot(meeting.status))}
                    />
                    <span className={statusTone(meeting.status)} data-testid="meeting-status">
                      {STATUS_LABELS[meeting.status]}
                    </span>
                    {meeting.deadlineAt ? (
                      <span className="text-muted-foreground">
                        · {t`Deadline`} {formatTime(meeting.deadlineAt)}
                      </span>
                    ) : null}
                  </div>
                  <h2 className="mt-1 text-body-xl font-medium">{meeting.title}</h2>
                  {meeting.description.startsWith("RabbitBots demo ·") ? (
                    <div className="mt-1 max-w-[46rem] text-body-sm text-muted-foreground">
                      <p>{meeting.description.split("\n\n")[0]}</p>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-label">
                          <Trans>Demo context</Trans>
                        </summary>
                        <p className="mt-1 whitespace-pre-wrap text-label">
                          {meeting.description.split("\n\n").slice(1).join("\n\n")}
                        </p>
                      </details>
                    </div>
                  ) : (
                    <p className="mt-1 max-w-[46rem] text-body-sm text-muted-foreground">
                      {meeting.description}
                    </p>
                  )}
                  {meeting.status !== "COMPLETED" &&
                  meeting.status !== "CANCELLED" &&
                  meeting.status !== "FAILED" ? (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-label text-muted-foreground">
                      <span>
                        {t`Current agenda`}: {currentAgenda?.title ?? "—"}
                      </span>
                      <span>
                        {t`Current speaker`}: {currentTurn?.participantBotName ?? "—"}
                      </span>
                      <span>
                        {t`Round`}: {selectedRound}/{selectedAgenda?.maxDiscussionRounds ?? 2}
                      </span>
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  {meeting.status === "DRAFT" ? (
                    <Button size="sm" onClick={() => void start()} disabled={starting}>
                      {starting ? <RefreshCw size={13} className="animate-spin" /> : null}
                      <Trans>Start meeting</Trans>
                    </Button>
                  ) : null}
                  {meeting.status !== "COMPLETED" &&
                  meeting.status !== "CANCELLED" &&
                  meeting.status !== "FAILED" ? (
                    <Button variant="secondary" size="sm" onClick={() => void cancel()}>
                      <Trans>Cancel</Trans>
                    </Button>
                  ) : null}
                </div>
              </div>
              {meeting.status === "CANCELLED" ? (
                <p className="mt-3 rounded-lg border bg-muted/40 px-3 py-2 text-body-sm text-muted-foreground">
                  {t`Cancelled`}
                  {meeting.cancelledAt ? ` · ${formatTime(meeting.cancelledAt)}` : ""}
                  {meeting.cancellationReason ? ` · ${meeting.cancellationReason}` : ""}
                </p>
              ) : meeting.error ? (
                <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-body-sm text-destructive">
                  {meeting.error}
                </p>
              ) : null}
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <section className="rounded-xl border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-body-sm font-medium">
                      <Trans>Agenda</Trans>
                    </h3>
                    <span className="text-label text-muted-foreground">
                      {currentAgenda
                        ? `${currentAgenda.sequence}/${meeting.agenda.length}`
                        : `${meeting.agenda.length} items`}
                    </span>
                  </div>
                  <ol className="mt-2 space-y-1.5">
                    {meeting.agenda.map((item) => {
                      const decision = meeting.decisions.find(
                        (candidate) => candidate.agendaId === item.id,
                      );
                      const responses = meeting.turns.filter(
                        (turn) =>
                          turn.agendaId === item.id &&
                          turn.phase === "AGENDA_RESPONSE" &&
                          turn.status === "COMPLETED",
                      ).length;
                      const rounds = Math.max(
                        1,
                        ...meeting.turns
                          .filter(
                            (turn) =>
                              turn.agendaId === item.id &&
                              turn.phase !== "AGENDA_DECISION" &&
                              turn.phase !== "SUMMARY",
                          )
                          .map((turn) => turn.round),
                      );
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedAgendaId(item.id)}
                            className={cn(
                              "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start text-body-sm hover:bg-accent/70",
                              item.id === selectedAgendaIdResolved && "bg-accent",
                            )}
                          >
                            <span className="mt-0.5 w-4 shrink-0 text-label text-muted-foreground">
                              {item.sequence}.
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium">{item.title}</span>
                              <span className="block text-label text-muted-foreground">
                                {agendaStatusLabel(item.status)} · round {rounds}/
                                {item.maxDiscussionRounds} · {item.timeLimitSeconds}s
                              </span>
                              <span className="block text-label text-muted-foreground">
                                {decision
                                  ? `${decisionLabel(decision)}${decision.approvalRequired ? ` · ${approvalStatusLabel(decision.approvalStatus)}` : ""}`
                                  : responses
                                    ? `${responses} response(s)`
                                    : "No decision yet"}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </section>
                <section className="rounded-xl border p-3">
                  <h3 className="text-body-sm font-medium">
                    <Trans>Participants</Trans>
                  </h3>
                  <div className="mt-2 space-y-2">
                    {meeting.humanParticipants.map((participant) => (
                      <div key={participant.id} className="flex items-start gap-2">
                        <Users size={14} className="mt-0.5 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="text-body-sm font-medium">
                            {participant.userName} · Human CEO
                          </div>
                          <div className="text-label text-muted-foreground">{participant.role}</div>
                        </div>
                      </div>
                    ))}
                    {meeting.participants.map((participant) => (
                      <div key={participant.id} className="flex items-start gap-2">
                        <Users size={14} className="mt-0.5 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="text-body-sm font-medium">
                            {participant.botName} · {participant.role}
                          </div>
                          {meeting.status !== "COMPLETED" ? (
                            <div className="text-label text-muted-foreground">
                              {participant.status}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
              <section className="mt-4 rounded-xl border">
                <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                  <h3 className="text-body-sm font-medium">
                    <Trans>Meeting transcript</Trans>
                  </h3>
                  <span className="text-label text-muted-foreground">
                    {selectedAgenda
                      ? `Agenda ${selectedAgenda.sequence}: ${selectedAgenda.title}`
                      : meeting.status === "COMPLETED"
                        ? "Closed"
                        : "Waiting"}
                  </span>
                </div>
                <div className="space-y-3 p-3">
                  {selectedReview ? (
                    <div className="rounded-lg border bg-background px-3 py-2">
                      <div className="text-label text-muted-foreground">
                        <Trans>Chair review</Trans> · round {selectedReview.round}
                      </div>
                      <div className="mt-1">
                        <MeetingStructuredTurn
                          content={selectedReview.content}
                          phase={selectedReview.phase}
                        />
                      </div>
                      <p className="mt-1 text-label text-muted-foreground">
                        {selectedResponses.length} participant response(s) recorded
                      </p>
                    </div>
                  ) : null}
                  {transcript.length === 0 ? (
                    <p className="text-body-sm text-muted-foreground">
                      <Trans>No participant has spoken on this agenda yet.</Trans>
                    </p>
                  ) : (
                    transcript.map((item) =>
                      item.kind === "human" ? (
                        <article
                          key={item.id}
                          className="rounded-lg border-s-2 border-primary/40 bg-accent/30 px-3 py-2.5"
                        >
                          <div className="flex flex-wrap items-center gap-2 text-label text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {item.message.authorName}
                            </span>
                            <span>HUMAN_CEO</span>
                            <span className="ms-auto">{formatTime(item.createdAt)}</span>
                          </div>
                          <p className="mt-1.5 whitespace-pre-wrap break-words text-body-sm">
                            {item.message.content}
                          </p>
                        </article>
                      ) : (
                        (() => {
                          const turn = item.turn;
                          return (
                            <article key={turn.id} className="rounded-lg bg-muted/50 px-3 py-2.5">
                              <div className="flex flex-wrap items-center gap-2 text-label text-muted-foreground">
                                <span className="font-medium text-foreground">
                                  {turn.participantBotName}
                                </span>
                                <span>{turn.phase}</span>
                                <span>round {turn.round}</span>
                                {turn.status !== "COMPLETED" ? (
                                  <span className="text-destructive">{turn.status}</span>
                                ) : null}
                                <span className="ms-auto">{formatTime(turn.createdAt)}</span>
                              </div>
                              <div className="mt-1.5">
                                <MeetingStructuredTurn content={turn.content} phase={turn.phase} />
                              </div>
                              {evidenceSources(turn.evidence).length ? (
                                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-label">
                                  <span className="text-muted-foreground">
                                    <Trans>Sources</Trans>
                                  </span>
                                  {evidenceSources(turn.evidence)
                                    .slice(0, 8)
                                    .map((source) => (
                                      <a
                                        key={source}
                                        href={source}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="max-w-full truncate text-foreground underline underline-offset-2"
                                      >
                                        {source}
                                      </a>
                                    ))}
                                </div>
                              ) : null}
                            </article>
                          );
                        })()
                      ),
                    )
                  )}
                </div>
                <form
                  className="border-t p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void sendMessage();
                  }}
                >
                  <div className="flex items-end gap-2">
                    <Textarea
                      aria-label={t`Message the meeting`}
                      value={messageDraft}
                      onChange={(event) => setMessageDraft(event.target.value)}
                      placeholder={
                        terminal
                          ? t`This meeting has ended; its transcript is read-only.`
                          : selectedAgenda
                            ? t`Message the room about ${selectedAgenda.title}…`
                            : t`Message the meeting…`
                      }
                      disabled={terminal || messageSending}
                      rows={2}
                      className="min-h-0"
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          void sendMessage();
                        }
                      }}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={terminal || messageSending || !messageDraft.trim()}
                    >
                      <Send size={13} />
                      <Trans>Send</Trans>
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground">
                    {terminal ? (
                      <span>Transcript read-only</span>
                    ) : messageConnection === "live" ? (
                      <span className="inline-flex items-center gap-1 text-success">
                        <Wifi size={12} /> <Trans>Live</Trans>
                      </span>
                    ) : messageConnection === "reconnecting" ? (
                      <span className="inline-flex items-center gap-1 text-warning">
                        <WifiOff size={12} /> <Trans>Reconnecting…</Trans>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Wifi size={12} /> <Trans>Connecting…</Trans>
                      </span>
                    )}
                    {messageSending ? <span>Sending…</span> : null}
                    {messageError ? (
                      <span className="text-destructive" role="alert">
                        {messageError}
                      </span>
                    ) : null}
                  </div>
                </form>
              </section>
              {meeting.formalMinutes ? (
                <section className="mt-4 rounded-xl border" data-testid="formal-minutes">
                  <div className="border-b px-3 py-2">
                    <h3 className="text-body-sm font-medium">
                      <Trans>Formal meeting minutes</Trans>
                    </h3>
                  </div>
                  <pre className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap break-words p-3 font-sans text-body-sm leading-[1.55]">
                    {meeting.formalMinutes}
                  </pre>
                </section>
              ) : null}
            </div>
          ) : (
            <div className="p-6 text-body-sm text-muted-foreground">
              <Trans>Select a meeting to open the room.</Trans>
            </div>
          )}
        </main>
        <aside className="hidden w-[340px] shrink-0 overflow-y-auto border-s bg-sidebar/30 xl:block">
          {meeting ? (
            <div className="space-y-4 p-4">
              <section data-testid="pending-approvals">
                <h3 className="text-label font-medium uppercase tracking-wide text-muted-foreground">
                  <Trans>Pending approvals</Trans>
                </h3>
                {pendingDecisions.length === 0 ? (
                  <p className="mt-2 text-body-sm text-muted-foreground">
                    <Trans>No pending approvals.</Trans>
                  </p>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    {pendingDecisions.map((decision) => {
                      const agenda = meeting.agenda.find((item) => item.id === decision.agendaId);
                      return (
                        <button
                          key={decision.id}
                          type="button"
                          onClick={() => {
                            if (decision.agendaId) setSelectedAgendaId(decision.agendaId);
                          }}
                          className="w-full rounded-md border border-warning/40 bg-warning/5 px-2.5 py-2 text-start hover:bg-warning/10"
                        >
                          <div className="text-body-sm font-medium">
                            {agenda?.title ?? "Meeting decision"}
                          </div>
                          <div className="text-label text-muted-foreground">
                            {decisionLabel(decision)} ·{" "}
                            {approvalStatusLabel(decision.approvalStatus)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
              <section>
                <h3 className="text-label font-medium uppercase tracking-wide text-muted-foreground">
                  <Trans>Chair closing summary</Trans>
                </h3>
                {pendingApprovals > 0 ? (
                  <p className="mt-1 text-label text-warning">
                    {pendingApprovals} human approval(s) pending
                  </p>
                ) : null}
                {meeting.meetingSummary ? (
                  <div className="mt-2 rounded-lg border bg-background p-3">
                    <ChatMarkdown>{meeting.meetingSummary}</ChatMarkdown>
                  </div>
                ) : (
                  <p className="mt-2 text-body-sm text-muted-foreground">
                    <Trans>The chair publishes the summary after the decision.</Trans>
                  </p>
                )}
              </section>
              <section>
                <h3 className="text-label font-medium uppercase tracking-wide text-muted-foreground">
                  <Trans>Agenda decision</Trans>
                  {selectedAgenda ? ` · ${selectedAgenda.title}` : ""}
                </h3>
                {selectedDecisions.length === 0 ? (
                  <p className="mt-2 text-body-sm text-muted-foreground">
                    <Trans>No decision for this agenda yet.</Trans>
                  </p>
                ) : (
                  <div className="mt-2 space-y-2">
                    {selectedDecisions.map((decision) => (
                      <div key={decision.id} className="rounded-lg border bg-background p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-body-sm font-medium">
                            {decisionLabel(decision)}
                          </span>
                          {decision.approvalRequired ? (
                            <span
                              className={
                                decision.approvalStatus === "PENDING"
                                  ? "text-label text-warning"
                                  : "text-label text-muted-foreground"
                              }
                            >
                              {approvalStatusLabel(decision.approvalStatus)}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-label text-muted-foreground">
                          {formatTime(decision.createdAt)}
                        </p>
                        <p className="mt-1 text-body-sm">{decision.decisionText}</p>
                        <p className="mt-1 text-label text-muted-foreground">
                          {decision.rationale}
                        </p>
                        <p className="mt-1 text-label font-medium">
                          Discussion state: {approvalStatusLabel(decision.discussionState)}
                        </p>
                        {decision.supportingOpinions.length ? (
                          <p className="mt-1 text-label text-muted-foreground">
                            Supporting opinions: {decision.supportingOpinions.join("; ")}
                          </p>
                        ) : null}
                        {decision.dissentingOpinions.length ? (
                          <p className="mt-1 text-label text-warning">
                            Opposing opinions: {decision.dissentingOpinions.join("; ")}
                          </p>
                        ) : null}
                        {decision.evidenceGaps.length ? (
                          <p className="mt-1 text-label text-muted-foreground">
                            Evidence gaps: {decision.evidenceGaps.join("; ")}
                          </p>
                        ) : null}
                        {decision.approvalHistory.length ? (
                          <div className="mt-2 rounded-md border bg-muted/30 px-2 py-1.5">
                            <div className="text-label font-medium text-muted-foreground">
                              <Trans>Approval history</Trans>
                            </div>
                            {decision.approvalHistory.map((approval) => (
                              <div key={approval.id} className="mt-1 text-label">
                                <span className="font-medium">{approval.actorName}</span> ·{" "}
                                {approvalStatusLabel(approval.newStatus)} ·{" "}
                                {formatTime(approval.createdAt)}
                                {approval.rationale ? (
                                  <div className="text-muted-foreground">{approval.rationale}</div>
                                ) : null}
                                {approval.conditions ? (
                                  <div className="text-muted-foreground">
                                    <Trans>Conditions:</Trans> {approval.conditions}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {meeting.actionItems.filter((item) => item.decisionId === decision.id)
                          .length ? (
                          <div className="mt-2 text-label text-muted-foreground">
                            <Trans>Action items:</Trans>
                            <ul className="mt-0.5 list-disc ps-4">
                              {meeting.actionItems
                                .filter((item) => item.decisionId === decision.id)
                                .map((item) => (
                                  <li key={item.id}>
                                    {item.title}
                                    {item.acceptanceCriteria ? (
                                      <span className="block text-muted-foreground">
                                        Acceptance: {item.acceptanceCriteria}
                                      </span>
                                    ) : null}
                                  </li>
                                ))}
                            </ul>
                          </div>
                        ) : null}
                        {decision.approvalStatus === "APPROVED_WITH_CONDITIONS" &&
                        !decision.conditionsConfirmedAt ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            data-testid={`confirm-conditions-${decision.id}`}
                            onClick={() => {
                              setConditionsDecision(decision);
                              setConditionsError(null);
                            }}
                          >
                            <Trans>Confirm conditions</Trans>
                          </Button>
                        ) : null}
                        {decision.approvalRequired && decision.approvalStatus === "PENDING" ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <Button
                              size="sm"
                              data-testid={`approve-${decision.id}`}
                              onClick={() => beginApproval(decision, "APPROVE")}
                            >
                              <Trans>Approve</Trans>
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              data-testid={`approve-conditions-${decision.id}`}
                              onClick={() => beginApproval(decision, "APPROVE_WITH_CONDITIONS")}
                            >
                              <Trans>Approve with conditions</Trans>
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              data-testid={`reject-${decision.id}`}
                              onClick={() => beginApproval(decision, "REJECT")}
                            >
                              <Trans>Reject</Trans>
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              data-testid={`defer-${decision.id}`}
                              onClick={() => beginApproval(decision, "DEFER")}
                            >
                              <Trans>Defer</Trans>
                            </Button>
                          </div>
                        ) : null}
                        {decision.conditions.length ? (
                          <p className="mt-1 text-label text-muted-foreground">
                            <Trans>Conditions:</Trans> {decision.conditions.join("; ")}
                          </p>
                        ) : null}
                        {decision.supportingEvidence.length ? (
                          <p className="mt-1 break-words text-label text-muted-foreground">
                            <Trans>Evidence:</Trans> {decision.supportingEvidence.join("; ")}
                          </p>
                        ) : null}
                        {decision.risks.length ? (
                          <p className="mt-1 text-label text-warning">
                            <Trans>Risks:</Trans> {decision.risks.join("; ")}
                          </p>
                        ) : null}
                        {decision.dissentingOpinions.length ? (
                          <p className="mt-1 text-label text-warning">
                            <Trans>Dissent:</Trans> {decision.dissentingOpinions.join("; ")}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <section>
                <h3 className="text-label font-medium uppercase tracking-wide text-muted-foreground">
                  <Trans>Action items</Trans>
                </h3>
                {meeting.actionItems.length === 0 ? (
                  <p className="mt-2 text-body-sm text-muted-foreground">
                    <Trans>No action item recorded.</Trans>
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {meeting.actionItems.map((item) => {
                      const decision = meeting.decisions.find(
                        (candidate) => candidate.id === item.decisionId,
                      );
                      const approved =
                        decision?.approvalStatus === "APPROVED" ||
                        (decision?.approvalStatus === "APPROVED_WITH_CONDITIONS" &&
                          Boolean(decision.conditionsConfirmedAt));
                      const canRun =
                        approved &&
                        item.executionStatus === "OPEN" &&
                        Boolean(item.activatedAt) &&
                        Boolean(item.assigneeBotId);
                      return (
                        <li key={item.id} className="rounded-md border bg-background px-2.5 py-2">
                          <div className="text-body-sm font-medium">{item.title}</div>
                          <div className="text-label text-muted-foreground">
                            {item.assigneeBotName ?? item.assigneeUserName ?? "Unassigned"} ·{" "}
                            {item.executionStatus.replaceAll("_", " ").toLowerCase()}
                            {item.dueAt ? ` · ${formatTime(item.dueAt)}` : " · no due date"}
                          </div>
                          {item.acceptanceCriteria ? (
                            <div className="mt-1 text-label text-muted-foreground">
                              Acceptance: {item.acceptanceCriteria}
                            </div>
                          ) : null}
                          {item.resultStatus ? (
                            <div className="mt-1 text-label">
                              Result: {item.resultStatus}
                              {item.resultSummary ? (
                                <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                                  {item.resultSummary}
                                </p>
                              ) : null}
                              {item.evidence.length ? (
                                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
                                  {item.evidence.map((evidence) => (
                                    <a
                                      key={evidence}
                                      href={evidence.startsWith("http") ? evidence : undefined}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="max-w-full truncate underline underline-offset-2"
                                    >
                                      {evidence}
                                    </a>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          {item.blockedReason ? (
                            <div className="mt-1 text-label text-warning">{item.blockedReason}</div>
                          ) : null}
                          {item.acceptanceStatus ? (
                            <div className="mt-1 text-label text-muted-foreground">
                              CEO: {item.acceptanceStatus.replaceAll("_", " ").toLowerCase()}
                            </div>
                          ) : null}
                          {item.acceptanceHistory.length ? (
                            <div className="mt-1 space-y-0.5 text-label text-muted-foreground">
                              {item.acceptanceHistory.map((acceptance) => (
                                <div key={acceptance.id}>
                                  {acceptance.actorName} ·{" "}
                                  {acceptance.action.replaceAll("_", " ").toLowerCase()} ·{" "}
                                  {formatTime(acceptance.createdAt)}
                                  {acceptance.comment ? ` · ${acceptance.comment}` : ""}
                                </div>
                              ))}
                            </div>
                          ) : null}
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {canRun ? (
                              <Button
                                size="sm"
                                data-testid={`run-action-${item.id}`}
                                onClick={() => void runAction(item)}
                              >
                                <Trans>Run</Trans>
                              </Button>
                            ) : null}
                            {item.executionStatus === "IN_PROGRESS" && item.resultStatus ? (
                              <>
                                <Button
                                  size="sm"
                                  data-testid={`accept-action-${item.id}`}
                                  onClick={() => beginActionReview(item, "ACCEPT")}
                                >
                                  <Trans>Accept</Trans>
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  data-testid={`request-evidence-${item.id}`}
                                  onClick={() => beginActionReview(item, "REQUEST_EVIDENCE")}
                                >
                                  <Trans>Request evidence</Trans>
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  data-testid={`re-execute-action-${item.id}`}
                                  onClick={() => beginActionReview(item, "RE_EXECUTE")}
                                >
                                  <Trans>Re-run</Trans>
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  data-testid={`reject-action-${item.id}`}
                                  onClick={() => beginActionReview(item, "REJECT")}
                                >
                                  <Trans>Reject</Trans>
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  data-testid={`block-action-${item.id}`}
                                  onClick={() => beginActionReview(item, "BLOCK")}
                                >
                                  <Trans>Block</Trans>
                                </Button>
                              </>
                            ) : null}
                            {item.executionStatus === "COMPLETED" ? (
                              <span className="text-label text-success">
                                <Trans>CEO accepted</Trans>
                              </span>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          ) : null}
        </aside>
      </div>
      <Dialog
        open={Boolean(approvalDraft)}
        onOpenChange={(next) => {
          if (!next) closeApproval();
        }}
      >
        <DialogContent
          data-testid="approval-confirmation"
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              {approvalDraft ? approvalActionLabel(approvalDraft.action) : "Approve decision"}
            </DialogTitle>
          </DialogHeader>
          {approvalDraft ? (
            <div className="space-y-3">
              <p className="text-body-sm text-muted-foreground">
                {meeting?.agenda.find((item) => item.id === approvalDraft.decision.agendaId)
                  ?.title ?? "Meeting decision"}
              </p>
              <p className="max-h-24 overflow-y-auto text-body-sm text-muted-foreground">
                {approvalDraft.decision.decisionText}
              </p>
              {approvalDraft.action === "APPROVE_WITH_CONDITIONS" ? (
                <label className="block text-body-sm" htmlFor="approval-conditions">
                  <span className="mb-1 block text-muted-foreground">
                    <Trans>Conditions (required)</Trans>
                  </span>
                  <Textarea
                    id="approval-conditions"
                    value={approvalConditions}
                    onChange={(event) => setApprovalConditions(event.target.value)}
                    rows={3}
                    maxLength={4000}
                  />
                </label>
              ) : null}
              <label className="block text-body-sm" htmlFor="approval-rationale">
                <span className="mb-1 block text-muted-foreground">
                  {approvalDraft.action === "APPROVE"
                    ? t`Rationale (optional)`
                    : t`Rationale (required)`}
                </span>
                <Textarea
                  id="approval-rationale"
                  value={approvalRationale}
                  onChange={(event) => setApprovalRationale(event.target.value)}
                  rows={3}
                  maxLength={2000}
                />
              </label>
              {approvalError ? (
                <p className="text-body-sm text-destructive" role="alert">
                  {approvalError}
                </p>
              ) : null}
              <DialogFooter>
                <Button variant="secondary" onClick={closeApproval} disabled={approvalSubmitting}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  data-testid="confirm-approval"
                  onClick={() => void submitApproval()}
                  disabled={approvalSubmitting}
                >
                  <Trans>Confirm</Trans>
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(conditionsDecision)}
        onOpenChange={(next) => {
          if (!next && !conditionsSubmitting) setConditionsDecision(null);
        }}
      >
        <DialogContent
          data-testid="conditions-confirmation"
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Confirm conditions</Trans>
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-body-sm text-muted-foreground">
              Confirm that the CEO-approved conditions have been satisfied before activating the
              linked action items. This does not change the original approval history.
            </p>
            <ul className="list-disc space-y-1 ps-4 text-body-sm">
              {(conditionsDecision?.conditions ?? []).map((condition) => (
                <li key={condition}>{condition}</li>
              ))}
            </ul>
            {conditionsError ? (
              <p className="text-body-sm text-destructive" role="alert">
                {conditionsError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => setConditionsDecision(null)}
                disabled={conditionsSubmitting}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button
                data-testid="confirm-conditions-submit"
                onClick={() => void confirmConditions()}
                disabled={conditionsSubmitting}
              >
                <Trans>Confirm</Trans>
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(actionReview)}
        onOpenChange={(next) => {
          if (!next) closeActionReview();
        }}
      >
        <DialogContent
          data-testid="action-acceptance-confirmation"
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              {actionReview ? actionReview.actionType.replaceAll("_", " ").toLowerCase() : "Action"}
            </DialogTitle>
          </DialogHeader>
          {actionReview ? (
            <div className="space-y-3">
              <p className="text-body-sm">{actionReview.action.title}</p>
              {actionReview.action.resultStatus ? (
                <p className="text-label text-muted-foreground">
                  Bot result: {actionReview.action.resultStatus}
                </p>
              ) : null}
              <label className="block text-body-sm" htmlFor="action-comment">
                <span className="mb-1 block text-muted-foreground">
                  {actionReview.actionType === "ACCEPT"
                    ? t`Comment (optional)`
                    : t`Comment (required)`}
                </span>
                <Textarea
                  id="action-comment"
                  value={actionComment}
                  onChange={(event) => setActionComment(event.target.value)}
                  rows={3}
                  maxLength={2000}
                />
              </label>
              {actionReviewError ? (
                <p className="text-body-sm text-destructive" role="alert">
                  {actionReviewError}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  variant="secondary"
                  onClick={closeActionReview}
                  disabled={actionReviewSubmitting}
                >
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  data-testid="confirm-action-acceptance"
                  onClick={() => void submitActionReview()}
                  disabled={actionReviewSubmitting}
                >
                  <Trans>Confirm</Trans>
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <CreateMeetingDialog
        open={createOpen}
        bots={bots}
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => {
          setCreateOpen(false);
          selectMeeting(created.id);
          void queryClient.invalidateQueries({ queryKey: ["meetings", "list"] });
        }}
      />
    </div>
  );
}

function CreateMeetingDialog({
  open,
  bots,
  onClose,
  onCreated,
}: {
  open: boolean;
  bots: Bot[];
  onClose: () => void;
  onCreated: (meeting: MeetingView) => void;
}) {
  const { t } = useLingui();
  const [title, setTitle] = useState("Glean Strategic Investment Review");
  const [description, setDescription] = useState(
    "Determine whether the company should proceed to the next investment due diligence stage.",
  );
  const [chairBotId, setChairBotId] = useState("");
  const [participantBotIds, setParticipantBotIds] = useState<string[]>([]);
  const [agenda, setAgenda] = useState(DEFAULT_AGENDA);
  const [timeLimit, setTimeLimit] = useState(300);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const ceo = bots.find((bot) => bot.spawnKey === "rabbitbots:ceo" || /^ceo/i.test(bot.name));
    setChairBotId(ceo?.id ?? bots[0]?.id ?? "");
    setParticipantBotIds(bots.map((bot) => bot.id));
    setError(null);
  }, [open, bots]);

  const chair = bots.find((bot) => bot.id === chairBotId);

  async function submit() {
    if (!chair || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await rpc.meetings.create({
        title: title.trim(),
        description: description.trim(),
        chairBotId: chair.id,
        participantBotIds: [...new Set([chair.id, ...participantBotIds])],
        agenda: agenda.map((item) => ({
          title: item.trim(),
          description: "",
          timeLimitSeconds: timeLimit,
        })),
      });
      onCreated(created);
    } catch (cause) {
      setError(errorText(cause, t`Could not create the meeting`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>New executive meeting</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-body-sm" htmlFor="meeting-title">
            <span className="mb-1 block text-muted-foreground">
              <Trans>Title</Trans>
            </span>
            <Input
              id="meeting-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
            />
          </label>
          <label className="block text-body-sm" htmlFor="meeting-objective">
            <span className="mb-1 block text-muted-foreground">
              <Trans>Objective</Trans>
            </span>
            <Textarea
              id="meeting-objective"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              maxLength={2000}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-body-sm" htmlFor="meeting-chair">
              <span className="mb-1 block text-muted-foreground">
                <Trans>Chair</Trans>
              </span>
              <NativeSelect
                id="meeting-chair"
                value={chairBotId}
                onChange={(event) => setChairBotId(event.target.value)}
              >
                {bots.map((bot) => (
                  <NativeSelectOption key={bot.id} value={bot.id}>
                    {bot.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="block text-body-sm" htmlFor="meeting-time-limit">
              <span className="mb-1 block text-muted-foreground">
                <Trans>Agenda time limit (seconds)</Trans>
              </span>
              <Input
                id="meeting-time-limit"
                type="number"
                min={30}
                max={3600}
                value={timeLimit}
                onChange={(event) =>
                  setTimeLimit(Math.max(30, Math.min(3600, Number(event.target.value) || 300)))
                }
              />
            </label>
          </div>
          <div>
            <div className="mb-1 text-body-sm text-muted-foreground">
              <Trans>Participants</Trans>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {bots.map((bot) => (
                <label key={bot.id} className="flex items-center gap-2 text-body-sm">
                  <input
                    type="checkbox"
                    checked={participantBotIds.includes(bot.id)}
                    onChange={(event) =>
                      setParticipantBotIds((current) =>
                        event.target.checked
                          ? [...current, bot.id]
                          : current.filter((id) => id !== bot.id),
                      )
                    }
                  />
                  <span className="truncate">{bot.name}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-body-sm text-muted-foreground">
              <Trans>Agenda</Trans>
            </div>
            <div className="space-y-1.5">
              {agenda.map((item, index) => (
                <Input
                  key={index}
                  value={item}
                  aria-label={`Agenda item ${index + 1}`}
                  onChange={(event) =>
                    setAgenda((current) =>
                      current.map((value, at) => (at === index ? event.target.value : value)),
                    )
                  }
                  maxLength={200}
                />
              ))}
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-body-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || !chair || !title.trim() || agenda.some((item) => !item.trim())}
          >
            <Plus size={14} />
            <Trans>Create meeting</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
