import { Trans, useLingui } from "@lingui/react/macro";
import type {
  MeetingActionAcceptanceAction,
  WorkforceCompanyStatus,
  WorkforceTaskView,
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
import { Bot, BriefcaseBusiness, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CreateAiCompany } from "../components/CreateAiCompany";
import { getActiveUiLocale } from "../lib/i18n";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(getActiveUiLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusLabel(value: string) {
  return value.replaceAll("_", " ").toLowerCase();
}

function statusTone(value: string) {
  if (value === "COMPLETED" || value === "SUCCESS") return "text-success";
  if (value === "BLOCKED" || value === "FAILED") return "text-destructive";
  if (
    value === "IN_PROGRESS" ||
    value === "PARTIAL" ||
    value === "WAITING" ||
    value === "WAITING_FOR_CHILDREN"
  )
    return "text-status-working";
  return "text-muted-foreground";
}

export function WorkforcePage() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [assignBotId, setAssignBotId] = useState("");
  const [sourceFilter, setSourceFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [timeFilter, setTimeFilter] = useState("ALL");
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newCriteria, setNewCriteria] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [newPriority, setNewPriority] = useState("NORMAL");
  const [newDueAt, setNewDueAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companyBusy, setCompanyBusy] = useState(false);
  const [companyError, setCompanyError] = useState<string | null>(null);
  const [companyStatus, setCompanyStatus] = useState<WorkforceCompanyStatus | undefined>(undefined);

  const companyQuery = useQuery({
    queryKey: ["workforce", "company"],
    queryFn: () => rpc.workforce.company.status(),
  });
  const currentCompany = companyStatus ?? companyQuery.data;

  async function createAiCompany() {
    setCompanyBusy(true);
    setCompanyError(null);
    try {
      const created = await rpc.workforce.company.create();
      setCompanyStatus(created);
      await queryClient.invalidateQueries({ queryKey: ["workforce"] });
      await queryClient.invalidateQueries({ queryKey: ["meetings"] });
      await queryClient.invalidateQueries({ queryKey: ["meetings", "bots"] });
    } catch (cause) {
      setCompanyError(errorText(cause, t`Could not create your AI Company`));
      throw cause;
    } finally {
      setCompanyBusy(false);
    }
  }

  const overviewQuery = useQuery({
    queryKey: ["workforce", "overview"],
    queryFn: () => rpc.workforce.overview(),
    refetchInterval: (query) =>
      query.state.data?.tasks.some(
        (task) =>
          task.executionStatus === "IN_PROGRESS" ||
          task.executionStatus === "OPEN" ||
          task.executionStatus === "WAITING_FOR_CHILDREN",
      )
        ? 3_000
        : false,
  });
  const data = overviewQuery.data;
  const bots = data?.bots ?? [];
  const tasks = data?.tasks ?? [];
  const selectedBot = bots.find((bot) => bot.id === selectedBotId) ?? bots[0];
  const now = Date.now();
  const filteredTasks = tasks.filter((task) => {
    if (sourceFilter !== "ALL" && task.source !== sourceFilter) return false;
    if (statusFilter !== "ALL" && task.executionStatus !== statusFilter) return false;
    if (
      timeFilter === "TODAY" &&
      new Date(task.createdAt).toDateString() !== new Date().toDateString()
    )
      return false;
    if (timeFilter === "7D" && now - new Date(task.createdAt).getTime() > 7 * 86_400_000)
      return false;
    return true;
  });
  const botTasks = selectedBot
    ? filteredTasks.filter((task) => task.assigneeBotId === selectedBot.id)
    : filteredTasks;
  const selectedTask =
    botTasks.find((task) => task.id === selectedTaskId) ??
    tasks.find((task) => task.id === selectedTaskId) ??
    botTasks[0];
  const executionTaskId = selectedTask?.linkedWorkforceTaskId ?? selectedTask?.id ?? null;
  const childTasks = selectedTask
    ? tasks.filter(
        (task) =>
          task.parentTaskId === executionTaskId || task.parentMeetingActionId === executionTaskId,
      )
    : [];
  const descendantTasks: Array<{ task: WorkforceTaskView; depth: number }> = [];
  const collectDescendants = (parentId: string, depth: number) => {
    for (const child of tasks.filter(
      (task) => task.parentTaskId === parentId || task.parentMeetingActionId === parentId,
    )) {
      descendantTasks.push({ task: child, depth });
      collectDescendants(child.id, depth + 1);
    }
  };
  if (executionTaskId) collectDescendants(executionTaskId, 1);

  useEffect(() => {
    if (!selectedBotId && bots[0]) setSelectedBotId(bots[0].id);
  }, [bots, selectedBotId]);
  useEffect(() => {
    if (selectedTaskId && tasks.some((task) => task.id === selectedTaskId)) return;
    setSelectedTaskId(botTasks[0]?.id ?? tasks[0]?.id ?? null);
  }, [botTasks, tasks, selectedTaskId]);

  async function refresh() {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ["workforce", "overview"] });
  }

  async function execute(task: WorkforceTaskView) {
    setBusy(true);
    setError(null);
    try {
      if (task.source === "MEETING_DECISION") {
        await rpc.meetings.actions.execute({
          meetingId: task.meetingId!,
          actionItemId: task.id,
          clientNonce: crypto.randomUUID(),
        });
      } else {
        await rpc.workforce.tasks.execute({
          taskId: task.id,
          clientNonce: crypto.randomUUID(),
        });
      }
      await refresh();
    } catch (cause) {
      setError(errorText(cause, t`Could not execute this task`));
    } finally {
      setBusy(false);
    }
  }

  async function accept(task: WorkforceTaskView, action: MeetingActionAcceptanceAction) {
    setBusy(true);
    setError(null);
    try {
      if (task.source === "MEETING_DECISION") {
        await rpc.meetings.actions.accept({
          meetingId: task.meetingId!,
          actionItemId: task.id,
          action,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          clientNonce: crypto.randomUUID(),
        });
      } else {
        await rpc.workforce.tasks.accept({
          taskId: task.id,
          action,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          clientNonce: crypto.randomUUID(),
        });
      }
      setComment("");
      await refresh();
    } catch (cause) {
      setError(errorText(cause, t`Could not record this decision`));
    } finally {
      setBusy(false);
    }
  }

  async function createTask() {
    if (!newTitle.trim() || !newAssignee || !newCriteria.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await rpc.workforce.tasks.create({
        title: newTitle.trim(),
        description: newDescription.trim(),
        acceptanceCriteria: newCriteria.trim(),
        assigneeBotId: newAssignee,
        priority: newPriority as "LOW" | "NORMAL" | "HIGH" | "URGENT",
        ...(newDueAt ? { dueAt: new Date(newDueAt).toISOString() } : {}),
      });
      setCreateOpen(false);
      setNewTitle("");
      setNewDescription("");
      setNewCriteria("");
      setNewDueAt("");
      setNewPriority("NORMAL");
      setSelectedBotId(created.assigneeBotId);
      setSelectedTaskId(created.id);
      await refresh();
    } catch (cause) {
      setError(errorText(cause, t`Could not create this task`));
    } finally {
      setBusy(false);
    }
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
          <Bot size={17} />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <BriefcaseBusiness size={18} strokeWidth={1.7} className="text-muted-foreground" />
          <div className="min-w-0">
            <h1 className="truncate text-body font-medium">
              <Trans>AI Workforce</Trans>
            </h1>
            <p className="text-label text-muted-foreground">
              <Trans>Real tasks, executions and CEO acceptance across your bot team.</Trans>
            </p>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={13} className={busy ? "animate-spin" : undefined} />
          <Trans>Refresh</Trans>
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setNewAssignee(bots[0]?.id ?? "");
            setCreateOpen(true);
          }}
          disabled={busy}
        >
          <Trans>New task</Trans>
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void refresh()} disabled={busy}>
          <Trans>Live</Trans>
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
      {companyQuery.isSuccess ? (
        <div className="shrink-0 px-4 pt-3">
          <CreateAiCompany
            status={currentCompany}
            busy={companyBusy}
            error={companyError}
            onCreate={createAiCompany}
            secondary
          />
        </div>
      ) : null}
      {!data ? (
        <div className="p-6 text-body-sm text-muted-foreground">
          <Trans>Loading workforce…</Trans>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-64 shrink-0 overflow-y-auto border-e bg-sidebar/40 lg:block">
            <div className="px-3 pb-2 pt-3 text-label font-medium uppercase tracking-wide text-muted-foreground">
              <Trans>Bots</Trans>
            </div>
            <div className="space-y-1 px-2 pb-3">
              {bots.map((bot) => (
                <button
                  key={bot.id}
                  type="button"
                  onClick={() => {
                    setSelectedBotId(bot.id);
                    setSelectedTaskId(null);
                  }}
                  className={cn(
                    "w-full rounded-lg px-2.5 py-2 text-start hover:bg-accent",
                    selectedBot?.id === bot.id && "bg-accent",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        bot.status === "WORKING" || bot.status === "WAITING"
                          ? "bg-status-working"
                          : bot.status === "BLOCKED"
                            ? "bg-destructive"
                            : "bg-success",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-body-sm font-medium">
                      {bot.name}
                    </span>
                  </div>
                  <div className="mt-0.5 text-label text-muted-foreground">{bot.role}</div>
                  <div className="mt-0.5 text-label text-muted-foreground">
                    {statusLabel(bot.status)} · {bot.completedToday} done today
                  </div>
                  {bot.currentTaskTitle ? (
                    <div className="mt-0.5 truncate text-label text-muted-foreground">
                      {bot.currentTaskTitle}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="border-t px-3 py-3">
              <div className="text-label font-medium uppercase tracking-wide text-muted-foreground">
                <Trans>Operations</Trans>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5 text-label">
                <span>Open {data.summary.open}</span>
                <span>In progress {data.summary.inProgress}</span>
                <span>Completed {data.summary.completed}</span>
                <span>Blocked {data.summary.blocked}</span>
                <span>Failed {data.summary.failed}</span>
                <span>Waiting {data.summary.waiting}</span>
                <span>Acceptance {data.summary.pendingAcceptance}</span>
              </div>
            </div>
          </aside>
          <main className="min-w-0 flex-1 overflow-y-auto p-4">
            <div className="mx-auto max-w-[48rem]">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-body-lg font-medium">
                  {selectedBot ? selectedBot.name : "All tasks"}
                </h2>
                <span className="text-label text-muted-foreground">
                  {botTasks.length} task{botTasks.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="mb-3 flex flex-wrap gap-1.5">
                <NativeSelect
                  aria-label={t`Task source`}
                  value={sourceFilter}
                  onChange={(event) => setSourceFilter(event.target.value)}
                >
                  <NativeSelectOption value="ALL">All sources</NativeSelectOption>
                  <NativeSelectOption value="MEETING_DECISION">Meeting</NativeSelectOption>
                  <NativeSelectOption value="CEO_DIRECT">CEO direct</NativeSelectOption>
                  <NativeSelectOption value="BOT_DELEGATED">Delegated</NativeSelectOption>
                </NativeSelect>
                <NativeSelect
                  aria-label={t`Task status`}
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                >
                  <NativeSelectOption value="ALL">All statuses</NativeSelectOption>
                  <NativeSelectOption value="OPEN">Open</NativeSelectOption>
                  <NativeSelectOption value="IN_PROGRESS">In progress</NativeSelectOption>
                  <NativeSelectOption value="WAITING_FOR_CHILDREN">
                    Waiting for children
                  </NativeSelectOption>
                  <NativeSelectOption value="COMPLETED">Completed</NativeSelectOption>
                  <NativeSelectOption value="BLOCKED">Blocked</NativeSelectOption>
                </NativeSelect>
                <NativeSelect
                  aria-label={t`Task time`}
                  value={timeFilter}
                  onChange={(event) => setTimeFilter(event.target.value)}
                >
                  <NativeSelectOption value="ALL">Any time</NativeSelectOption>
                  <NativeSelectOption value="TODAY">Today</NativeSelectOption>
                  <NativeSelectOption value="7D">Last 7 days</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="space-y-2">
                {botTasks.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-4 text-body-sm text-muted-foreground">
                    <Trans>No tasks assigned to this bot yet.</Trans>
                  </p>
                ) : (
                  botTasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      data-testid={`workforce-task-${task.id}`}
                      onClick={() => setSelectedTaskId(task.id)}
                      className={cn(
                        "w-full rounded-xl border bg-background p-3 text-start hover:bg-accent/30",
                        selectedTask?.id === task.id && "border-primary/40 bg-accent/30",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 text-body-sm font-medium">
                          {task.title}
                        </span>
                        <span className={cn("text-label", statusTone(task.executionStatus))}>
                          {statusLabel(task.executionStatus)}
                        </span>
                      </div>
                      <div className="mt-1 text-label text-muted-foreground">
                        {task.source.replaceAll("_", " ").toLowerCase()} ·{" "}
                        {task.meetingTitle ?? task.parentTaskId ?? "standalone"} ·{" "}
                        {task.attempts.length} attempt(s)
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-label">
                        <span className="text-muted-foreground">
                          Result: {task.latestResultStatus ?? "—"}
                        </span>
                        <span className="text-muted-foreground">
                          CEO: {task.acceptanceStatus ?? "not accepted"}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </main>
          <aside className="hidden w-[26rem] shrink-0 overflow-y-auto border-s bg-sidebar/30 xl:block">
            {selectedTask ? (
              <div className="space-y-4 p-4">
                <div>
                  <h2 className="text-body-lg font-medium">{selectedTask.title}</h2>
                  <p className="mt-1 text-label text-muted-foreground">
                    {selectedTask.assigneeBotName ?? selectedTask.assigneeUserName ?? "Unassigned"}{" "}
                    · {selectedTask.source.replaceAll("_", " ").toLowerCase()} ·{" "}
                    {selectedTask.meetingTitle ?? "no meeting"}
                  </p>
                  {selectedTask.linkedWorkforceTaskId ? (
                    <p className="mt-1 text-label text-muted-foreground">
                      Parent task: {selectedTask.linkedWorkforceTaskId}
                    </p>
                  ) : null}
                  {!selectedTask.linkedWorkforceTaskId &&
                  (selectedTask.parentTaskId || selectedTask.parentMeetingActionId) ? (
                    <p className="mt-1 text-label text-muted-foreground">
                      Parent: {selectedTask.parentTaskId ?? selectedTask.parentMeetingActionId}
                      {selectedTask.delegatorBotId
                        ? ` · delegated by ${selectedTask.delegatorBotId}`
                        : ""}
                    </p>
                  ) : null}
                  <p className="mt-1 text-body-sm text-muted-foreground">
                    {selectedTask.acceptanceCriteria || "No acceptance criterion recorded."}
                  </p>
                </div>
                <section className="rounded-lg border bg-background p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-label font-medium">Execution</span>
                    <span className={cn("text-label", statusTone(selectedTask.executionStatus))}>
                      {statusLabel(selectedTask.executionStatus)}
                    </span>
                  </div>
                  {selectedTask.linkedExecutionStatus ? (
                    <p className="mt-1 text-label text-muted-foreground">
                      Parent execution:{" "}
                      <span className={statusTone(selectedTask.linkedExecutionStatus)}>
                        {statusLabel(selectedTask.linkedExecutionStatus)}
                      </span>
                    </p>
                  ) : null}
                  <p className="mt-1 text-label text-muted-foreground">
                    Decision: {selectedTask.decisionType ?? "—"} · Approval:{" "}
                    {selectedTask.approvalStatus ?? "—"}
                    {selectedTask.conditionsConfirmedAt
                      ? ` · conditions confirmed ${formatTime(selectedTask.conditionsConfirmedAt)}`
                      : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {selectedTask.assigneeBotId &&
                    (selectedTask.executionStatus === "OPEN" ||
                      selectedTask.executionStatus === "BLOCKED" ||
                      selectedTask.executionStatus === "IN_PROGRESS") ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        data-testid="workforce-run"
                        onClick={() => void execute(selectedTask)}
                      >
                        {selectedTask.executionStatus === "OPEN" ? "Run" : "Retry"}
                      </Button>
                    ) : null}
                    {selectedTask.executionStatus === "IN_PROGRESS" &&
                    (selectedTask.latestResultStatus === "SUCCESS" ||
                      selectedTask.latestResultStatus === "PARTIAL") ? (
                      <>
                        <Button
                          size="sm"
                          disabled={busy}
                          data-testid="workforce-accept"
                          onClick={() => void accept(selectedTask, "ACCEPT")}
                        >
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void accept(selectedTask, "REQUEST_EVIDENCE")}
                        >
                          Request evidence
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void accept(selectedTask, "RE_EXECUTE")}
                        >
                          Re-run
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void accept(selectedTask, "BLOCK")}
                        >
                          Block
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void accept(selectedTask, "CANCEL")}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : null}
                    {selectedTask.executionStatus !== "COMPLETED" &&
                    !(
                      selectedTask.executionStatus === "IN_PROGRESS" &&
                      (selectedTask.latestResultStatus === "SUCCESS" ||
                        selectedTask.latestResultStatus === "PARTIAL")
                    ) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void accept(selectedTask, "CANCEL")}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                  {selectedTask.executionStatus !== "COMPLETED" ? (
                    <>
                      <Input
                        className="mt-2"
                        placeholder={t`Acceptance comment (required for evidence/block)`}
                        value={comment}
                        onChange={(event) => setComment(event.target.value)}
                      />
                      <div className="mt-2 flex items-center gap-1.5">
                        <NativeSelect
                          aria-label={t`Reassign task`}
                          value={assignBotId}
                          onChange={(event) => setAssignBotId(event.target.value)}
                        >
                          <NativeSelectOption value="">Reassign to…</NativeSelectOption>
                          {bots.map((bot) => (
                            <NativeSelectOption key={bot.id} value={bot.id}>
                              {bot.name}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy || !assignBotId}
                          onClick={() => {
                            if (!selectedTask || !assignBotId) return;
                            setBusy(true);
                            setError(null);
                            void (
                              selectedTask.source === "MEETING_DECISION"
                                ? rpc.meetings.actions.assign({
                                    meetingId: selectedTask.meetingId!,
                                    actionItemId: selectedTask.id,
                                    assigneeBotId: assignBotId,
                                    clientNonce: crypto.randomUUID(),
                                  })
                                : rpc.workforce.tasks.assign({
                                    taskId: selectedTask.id,
                                    assigneeBotId: assignBotId,
                                    clientNonce: crypto.randomUUID(),
                                  })
                            )
                              .then(() => {
                                setAssignBotId("");
                                return refresh();
                              })
                              .catch((cause: unknown) => {
                                setError(errorText(cause, t`Could not reassign this task`));
                              })
                              .finally(() => setBusy(false));
                          }}
                        >
                          Assign
                        </Button>
                      </div>
                    </>
                  ) : null}
                </section>
                <section>
                  <h3 className="text-label font-medium uppercase tracking-wide text-muted-foreground">
                    Execution history
                  </h3>
                  <div className="mt-2 space-y-2">
                    {selectedTask.attempts.length === 0 ? (
                      <p className="text-body-sm text-muted-foreground">No execution yet.</p>
                    ) : (
                      selectedTask.attempts.map((attempt) => (
                        <div key={attempt.id} className="rounded-lg border bg-background p-2.5">
                          <div className="flex items-center justify-between gap-2 text-label">
                            <span className="font-medium">
                              Attempt {attempt.attemptNumber}
                              {selectedTask.continuationRunId === attempt.botRunId
                                ? " · Continuation"
                                : attempt.attemptNumber === 1
                                  ? " · Original"
                                  : ""}
                            </span>
                            <span className={statusTone(attempt.resultStatus ?? attempt.status)}>
                              {attempt.resultStatus ?? attempt.status}
                            </span>
                          </div>
                          <div className="mt-1 text-label text-muted-foreground">
                            Task {attempt.taskId ?? "—"} · Run {attempt.botRunId ?? "—"}
                          </div>
                          {attempt.runStatus || attempt.runTrigger ? (
                            <div className="text-label text-muted-foreground">
                              Run status {attempt.runStatus ?? "—"} ·{" "}
                              {attempt.runTrigger ?? "trigger unknown"}
                            </div>
                          ) : null}
                          <div className="text-label text-muted-foreground">
                            {formatTime(attempt.startedAt)} – {formatTime(attempt.completedAt)}
                          </div>
                          {attempt.resultSummary ? (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-label text-muted-foreground">
                                Result details
                              </summary>
                              <p className="mt-1 whitespace-pre-wrap text-body-sm text-muted-foreground">
                                {attempt.resultSummary}
                              </p>
                            </details>
                          ) : null}
                          {attempt.evidence.length ? (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-label text-muted-foreground">
                                Evidence ({attempt.evidence.length})
                              </summary>
                              <div className="mt-1 space-y-0.5 text-label text-muted-foreground">
                                {attempt.evidence.map((item) => (
                                  <p key={item} className="break-words">
                                    {item}
                                  </p>
                                ))}
                              </div>
                            </details>
                          ) : (
                            <p className="mt-1 text-label text-muted-foreground">
                              No evidence recorded.
                            </p>
                          )}
                          {attempt.error ? (
                            <p className="mt-1 text-label text-destructive">{attempt.error}</p>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>
                </section>
                {descendantTasks.length ? (
                  <section>
                    <h3 className="text-label font-medium uppercase tracking-wide text-muted-foreground">
                      Task tree
                    </h3>
                    <div className="mt-2 space-y-1">
                      {descendantTasks.map(({ task: child, depth }) => (
                        <button
                          key={child.id}
                          type="button"
                          onClick={() => setSelectedTaskId(child.id)}
                          style={{ paddingInlineStart: depth * 14 + 8 }}
                          className="w-full rounded-md border bg-background py-1.5 pe-2 text-start text-label hover:bg-accent/30"
                        >
                          <span className="font-medium">{child.title}</span>
                          <span className="ms-2 text-muted-foreground">
                            {child.assigneeBotName ?? "unassigned"} · {child.executionStatus} ·{" "}
                            {child.latestResultStatus ?? "no result"}
                            {child.attempts.some((attempt) => attempt.evidence.length)
                              ? ` · evidence ${child.attempts.reduce(
                                  (count, attempt) => count + attempt.evidence.length,
                                  0,
                                )}`
                              : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}
                {selectedTask.delegations.length || selectedTask.waitingForChildren ? (
                  <section className="rounded-lg border bg-background p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-label font-medium">Delegation wait</span>
                      <span className={cn("text-label", statusTone(selectedTask.executionStatus))}>
                        {selectedTask.waitingForChildren ? "waiting" : "settled"}
                      </span>
                    </div>
                    <p className="mt-1 text-label text-muted-foreground">
                      {selectedTask.delegations.filter((row) => row.status === "WAITING").length}{" "}
                      waiting ·{" "}
                      {selectedTask.delegations.filter((row) => row.status === "COMPLETED").length}{" "}
                      completed ·{" "}
                      {
                        selectedTask.delegations.filter(
                          (row) =>
                            row.status === "FAILED" ||
                            row.status === "BLOCKED" ||
                            row.status === "TIMED_OUT",
                        ).length
                      }{" "}
                      failed
                    </p>
                    {selectedTask.waitingSince ? (
                      <p className="text-label text-muted-foreground">
                        Waiting since {formatTime(selectedTask.waitingSince)}
                        {selectedTask.delegationDeadlineAt
                          ? ` · deadline ${formatTime(selectedTask.delegationDeadlineAt)}`
                          : ""}
                      </p>
                    ) : null}
                    {selectedTask.continuationRunId ? (
                      <p className="text-label text-muted-foreground">
                        Continuation Run {selectedTask.continuationRunId}
                      </p>
                    ) : null}
                    <div className="mt-2 space-y-1">
                      {selectedTask.delegations.map((delegation) => (
                        <div key={delegation.id} className="text-label text-muted-foreground">
                          {delegation.status} ·{" "}
                          {delegation.toolInvocationId
                            ? `real model delegation · invocation ${delegation.toolInvocationId}`
                            : "deterministic demo delegation"}{" "}
                          · child {delegation.childTaskId} · result {delegation.resultStatus ?? "—"}
                          {delegation.error ? ` · ${delegation.error}` : ""}
                          {delegation.timedOutAt
                            ? ` · timed out ${formatTime(delegation.timedOutAt)}`
                            : ""}
                          {delegation.lateResultStatus
                            ? ` · late child ${delegation.lateResultStatus}`
                            : ""}
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}
                {childTasks.length && descendantTasks.length === 0 ? (
                  <section>
                    <h3 className="text-label font-medium uppercase tracking-wide text-muted-foreground">
                      Delegated subtasks
                    </h3>
                    <div className="mt-2 space-y-1">
                      {childTasks.map((child) => (
                        <button
                          key={child.id}
                          type="button"
                          onClick={() => setSelectedTaskId(child.id)}
                          className="w-full rounded-md border bg-background p-2 text-start text-label hover:bg-accent/30"
                        >
                          <span className="font-medium">{child.title}</span>
                          <span className="ms-2 text-muted-foreground">
                            {child.assigneeBotName ?? "unassigned"} · {child.executionStatus}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}
                <section>
                  <h3 className="text-label font-medium uppercase tracking-wide text-muted-foreground">
                    CEO acceptance
                  </h3>
                  {selectedTask.acceptances.length === 0 ? (
                    <p className="mt-2 text-body-sm text-muted-foreground">Not accepted yet.</p>
                  ) : (
                    <div className="mt-2 space-y-1 text-label">
                      {selectedTask.acceptances.map((acceptance) => (
                        <div key={acceptance.id} className="rounded-md border bg-background p-2">
                          <span className="font-medium">{acceptance.actorName}</span> ·{" "}
                          {statusLabel(acceptance.action)} · {formatTime(acceptance.createdAt)}
                          {acceptance.comment ? (
                            <p className="text-muted-foreground">{acceptance.comment}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            ) : (
              <div className="p-6 text-body-sm text-muted-foreground">
                Select a task to inspect its execution history.
              </div>
            )}
          </aside>
        </div>
      )}
      <Dialog open={createOpen} onOpenChange={(next) => !next && setCreateOpen(false)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              <Trans>New CEO task</Trans>
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              aria-label={t`Task title`}
              placeholder={t`Task title`}
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              maxLength={300}
            />
            <Textarea
              aria-label={t`Task description`}
              placeholder={t`What should the bot do?`}
              value={newDescription}
              onChange={(event) => setNewDescription(event.target.value)}
              rows={3}
              maxLength={4000}
            />
            <Textarea
              aria-label={t`Acceptance criteria`}
              placeholder={t`How will the CEO verify completion?`}
              value={newCriteria}
              onChange={(event) => setNewCriteria(event.target.value)}
              rows={2}
              maxLength={4000}
            />
            <NativeSelect
              aria-label={t`Assignee bot`}
              value={newAssignee}
              onChange={(event) => setNewAssignee(event.target.value)}
            >
              <NativeSelectOption value="">Assign to…</NativeSelectOption>
              {bots.map((bot) => (
                <NativeSelectOption key={bot.id} value={bot.id}>
                  {bot.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <div className="flex gap-2">
              <NativeSelect
                aria-label={t`Priority`}
                value={newPriority}
                onChange={(event) => setNewPriority(event.target.value)}
              >
                <NativeSelectOption value="LOW">Low</NativeSelectOption>
                <NativeSelectOption value="NORMAL">Normal</NativeSelectOption>
                <NativeSelectOption value="HIGH">High</NativeSelectOption>
                <NativeSelectOption value="URGENT">Urgent</NativeSelectOption>
              </NativeSelect>
              <Input
                aria-label={t`Due date`}
                type="datetime-local"
                value={newDueAt}
                onChange={(event) => setNewDueAt(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                data-testid="create-direct-task"
                onClick={() => void createTask()}
                disabled={busy || !newTitle.trim() || !newAssignee || !newCriteria.trim()}
              >
                <Trans>Create task</Trans>
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
