import { Trans } from "@lingui/react/macro";
import type { WorkforceCompanyRoleInput, WorkforceCompanyStatus } from "@rakazo/contracts";
import { Button, Input, Textarea } from "@rakazo/ui-web";
import {
  ArrowLeft,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  Landmark,
  LoaderCircle,
  Sparkles,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import type { ModelCatalogEntry } from "../lib/model-auth";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { ModelStep } from "./onboarding/model-step";
import { useOnboardingModel } from "./onboarding/use-onboarding-model";

const DRAFT_KEY = "rakazo:onboarding-company:v1";
const DEFAULT_COMPANY_NAME = "My AI Company";

const WIZARD_ROLES: WorkforceCompanyRoleInput[] = [
  {
    key: "ceo",
    name: "CEO / Chair",
    description: "Chairs the boardroom, coordinates the team and frames decisions for you.",
  },
  {
    key: "research",
    name: "Research",
    description: "Collects evidence, studies the market and checks the facts behind a decision.",
  },
  {
    key: "finance",
    name: "Finance",
    description: "Analyzes budgets, costs and scenarios without inventing financial data.",
  },
  {
    key: "operations",
    name: "Operations",
    description: "Breaks work into steps, coordinates execution and tracks progress.",
  },
];

const STEPS = ["welcome", "profile", "team", "model", "ready"] as const;
type WizardStep = (typeof STEPS)[number];

type Draft = {
  step: WizardStep;
  name: string;
  description: string;
  roles: WorkforceCompanyRoleInput[];
  skippedModel: boolean;
  firstTask: string;
};

function isWizardStep(value: string | null): value is WizardStep {
  return value !== null && (STEPS as readonly string[]).includes(value);
}

function readDraft(): Draft {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as Partial<Draft> | null;
    const roles = Array.isArray(parsed?.roles)
      ? parsed.roles.filter(
          (role): role is WorkforceCompanyRoleInput =>
            Boolean(role) &&
            typeof role === "object" &&
            WIZARD_ROLES.some((candidate) => candidate.key === role.key) &&
            typeof role.name === "string" &&
            typeof role.description === "string",
        )
      : [];
    return {
      step: parsed?.step && isWizardStep(parsed.step) ? parsed.step : "welcome",
      name: typeof parsed?.name === "string" ? parsed.name : DEFAULT_COMPANY_NAME,
      description: typeof parsed?.description === "string" ? parsed.description : "",
      roles:
        roles.length === WIZARD_ROLES.length
          ? WIZARD_ROLES.map(
              (role) => roles.find((candidate) => candidate.key === role.key) ?? role,
            )
          : WIZARD_ROLES,
      skippedModel: parsed?.skippedModel === true,
      firstTask: typeof parsed?.firstTask === "string" ? parsed.firstTask : "",
    };
  } catch {
    return {
      step: "welcome",
      name: DEFAULT_COMPANY_NAME,
      description: "",
      roles: WIZARD_ROLES,
      skippedModel: false,
      firstTask: "",
    };
  }
}

function stepNumber(step: WizardStep) {
  return STEPS.indexOf(step) + 1;
}

/** The five-step first-run path. Company rows exist only after the explicit create action. */
export function OnboardingCompanyPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const draft = useMemo(readDraft, []);
  const routeStep = search.get("step");
  const [step, setStepState] = useState<WizardStep>(() =>
    isWizardStep(routeStep) ? routeStep : draft.step,
  );
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [roles, setRoles] = useState<WorkforceCompanyRoleInput[]>(draft.roles);
  const [skippedModel, setSkippedModel] = useState(draft.skippedModel);
  const [firstTask, setFirstTask] = useState(draft.firstTask);
  const [company, setCompany] = useState<WorkforceCompanyStatus | null>(null);
  const [me, setMe] = useState<{ needsModel: boolean; billingEnabled: boolean } | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [modelConnected, setModelConnected] = useState(false);
  const [showTask, setShowTask] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [createdTask, setCreatedTask] = useState<Awaited<
    ReturnType<typeof rpc.workforce.tasks.create>
  > | null>(null);
  const [overview, setOverview] = useState(false);
  const createLock = useRef(false);
  const bootLock = useRef(false);

  const model = useOnboardingModel({
    catalog,
    billingEnabled: me?.billingEnabled ?? false,
    onConnected: () => {
      setModelConnected(true);
      setSkippedModel(false);
      go("ready");
    },
  });
  const modelReady = Boolean(me && (!me.needsModel || modelConnected));
  const displayName = company?.name?.trim() || name.trim() || DEFAULT_COMPANY_NAME;
  const ceo = company?.bots.find((bot) => bot.roleKey === "ceo") ?? company?.bots[0];

  useEffect(() => {
    if (bootLock.current) return;
    bootLock.current = true;
    let cancelled = false;
    void Promise.all([rpc.me(), rpc.workforce.company.status(), rpc.models.list().catch(() => [])])
      .then(([account, status, models]) => {
        if (cancelled) return;
        setMe({ needsModel: account.needsModel, billingEnabled: account.billingEnabled });
        setCatalog(models);
        setCompany(status);
        if (status.created && !isWizardStep(search.get("step"))) {
          navigate("/app", { replace: true });
          return;
        }
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorText(cause, "Could not load your AI company."));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      // StrictMode remounts effects in development: let the next mount start the load.
      bootLock.current = false;
    };
  }, [navigate, loadAttempt, search]);

  useEffect(() => {
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          step,
          name,
          description,
          roles,
          skippedModel,
          firstTask,
        } satisfies Draft),
      );
    } catch {
      // Browsers that block storage still get a working wizard for this visit.
    }
  }, [step, name, description, roles, skippedModel, firstTask]);

  useEffect(() => {
    if (isWizardStep(routeStep) && routeStep !== step) setStepState(routeStep);
  }, [routeStep, step]);

  function go(next: WizardStep) {
    setStepState(next);
    setSearch({ step: next }, { replace: true });
    setCreateError(null);
  }

  async function createCompany() {
    if (creating || createLock.current || company?.created) return;
    if (!name.trim()) {
      setCreateError("Give your company a name first.");
      go("profile");
      return;
    }
    if (roles.some((role) => !role.name.trim() || !role.description.trim())) {
      setCreateError("Every AI employee needs a name and a responsibility.");
      go("team");
      return;
    }
    createLock.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await rpc.workforce.company.create({
        name: name.trim(),
        description: description.trim() || undefined,
        roles: roles.map((role) => ({
          key: role.key,
          name: role.name.trim(),
          description: role.description.trim(),
        })),
      });
      setCompany(created);
      go("ready");
    } catch (cause: unknown) {
      // A timeout can hide a successful create. Ask the server before offering retry.
      const recovered = await rpc.workforce.company.status().catch(() => null);
      if (recovered?.created) {
        setCompany(recovered);
        go("ready");
      } else {
        setCreateError(errorText(cause, "Could not create your AI company."));
      }
    } finally {
      createLock.current = false;
      setCreating(false);
    }
  }

  async function startFirstTask() {
    if (!company?.created || !ceo || !firstTask.trim() || taskBusy) return;
    if (!modelReady) {
      setTaskError(
        "Connect a model before starting a task. Your company is ready, but no work can run yet.",
      );
      return;
    }
    setTaskBusy(true);
    setTaskError(null);
    try {
      const text = firstTask.trim();
      const task = await rpc.workforce.tasks.create({
        title: text.slice(0, 300),
        description: text,
        acceptanceCriteria:
          "A clear, useful result that answers the request. Include the work done and any evidence needed for the CEO to review it.",
        assigneeBotId: ceo.id,
        priority: "NORMAL",
      });
      setCreatedTask(task);
      try {
        const executed = await rpc.workforce.tasks.execute({
          taskId: task.id,
          clientNonce: crypto.randomUUID(),
        });
        setCreatedTask(executed);
      } catch {
        setTaskError(
          "Your task was created, but execution did not start. Open Workforce to retry safely.",
        );
      }
    } catch (cause: unknown) {
      setTaskError(errorText(cause, "Could not create your first task."));
    } finally {
      setTaskBusy(false);
    }
  }

  function retryLoad() {
    bootLock.current = false;
    setLoadAttempt((attempt) => attempt + 1);
    setLoading(true);
  }

  function updateRole(
    key: WorkforceCompanyRoleInput["key"],
    patch: Partial<WorkforceCompanyRoleInput>,
  ) {
    setRoles((current) => current.map((role) => (role.key === key ? { ...role, ...patch } : role)));
  }

  if (loading) return <PageLoading />;
  if (loadError) {
    return (
      <div className="min-h-full bg-background px-6 py-12" data-rakazo-surface="onboarding">
        <div className="mx-auto w-full max-w-[520px] rounded-xl border border-destructive/30 bg-card p-5">
          <p role="alert" className="text-body text-destructive">
            {loadError}
          </p>
          <Button className="mt-4" onClick={retryLoad}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      </div>
    );
  }

  const progress = (
    <div className="mb-8 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 text-label font-medium text-muted-foreground">
        <Sparkles size={14} aria-hidden />
        <Trans>Build your AI company</Trans>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="sr-only">Step {stepNumber(step)} of 5</span>
        {STEPS.map((candidate, index) => (
          <span
            key={candidate}
            className={
              index + 1 <= stepNumber(step)
                ? "h-1.5 w-6 rounded-full bg-primary"
                : "h-1.5 w-6 rounded-full bg-muted"
            }
          />
        ))}
      </div>
    </div>
  );

  return (
    <div
      className="min-h-full overflow-y-auto bg-background px-5 py-10 sm:px-8 sm:py-14"
      data-rakazo-surface="onboarding"
    >
      <div className="mx-auto w-full max-w-[720px]" data-testid="onboarding-wizard">
        {step === "welcome" ? (
          <section>
            <div className="grid size-12 place-items-center rounded-2xl bg-primary text-primary-foreground">
              <Landmark size={22} />
            </div>
            <h1 className="mt-7 text-display font-medium text-foreground">
              <Trans>Welcome to RabbitBots</Trans>
            </h1>
            <p className="mt-2 text-heading3 text-muted-foreground">
              <Trans>Build Your Own AI Company.</Trans>
            </p>
            <p className="mt-5 max-w-[520px] text-body leading-relaxed text-muted-foreground">
              <Trans>
                Create your AI team, assign work, and let your AI employees collaborate to deliver
                real results.
              </Trans>
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button
                size="lg"
                data-testid="onboarding-start"
                onClick={() => go("profile")}
                className="sm:min-w-56"
              >
                <Trans>Create Your AI Company</Trans>
                <ArrowRight size={16} />
              </Button>
              <Button size="lg" variant="secondary" onClick={() => setOverview((value) => !value)}>
                <Trans>Explore RabbitBots</Trans>
              </Button>
            </div>
            {overview ? (
              <div className="mt-8 grid gap-3 sm:grid-cols-3" data-testid="onboarding-explore">
                <ExploreItem icon={<Landmark size={15} />} title="Boardroom">
                  Your AI team debates decisions while you stay the Human CEO.
                </ExploreItem>
                <ExploreItem icon={<Users size={15} />} title="AI employees">
                  Four focused roles research, plan and coordinate work.
                </ExploreItem>
                <ExploreItem icon={<BriefcaseBusiness size={15} />} title="Workforce">
                  Real tasks, visible progress and approval before anything is accepted.
                </ExploreItem>
              </div>
            ) : null}
          </section>
        ) : null}

        {step !== "welcome" ? progress : null}

        {step === "profile" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) {
                setCreateError("Give your company a name first.");
                return;
              }
              setCreateError(null);
              go("team");
            }}
          >
            <h1 className="text-heading2 font-medium">
              <Trans>Name your AI company</Trans>
            </h1>
            <p className="mt-2 text-body text-muted-foreground">
              <Trans>This is what your team will call home. You can change it later.</Trans>
            </p>
            <label
              className="mt-8 block text-body font-medium text-foreground"
              htmlFor="company-name"
            >
              <Trans>Company Name</Trans>
            </label>
            <Input
              id="company-name"
              data-testid="onboarding-company-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              autoFocus
              className="mt-2"
            />
            <label
              className="mt-6 block text-body font-medium text-foreground"
              htmlFor="company-description"
            >
              <Trans>Company Description</Trans>
              <span className="ms-1.5 font-normal text-muted-foreground">
                <Trans>Optional</Trans>
              </span>
            </label>
            <Textarea
              id="company-description"
              data-testid="onboarding-company-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={2_000}
              rows={3}
              placeholder="What should your AI company focus on?"
              className="mt-2"
            />
            {createError ? (
              <p role="alert" className="mt-4 text-body-sm text-destructive">
                {createError}
              </p>
            ) : null}
            <WizardFooter onBack={() => go("welcome")} backLabel="Back" primaryLabel="Continue" />
          </form>
        ) : null}

        {step === "team" ? (
          <div>
            <h1 className="text-heading2 font-medium">
              <Trans>Build your AI team</Trans>
            </h1>
            <p className="mt-2 text-body text-muted-foreground">
              <Trans>Four employees join your company. Keep the defaults or make them yours.</Trans>
            </p>
            <div className="mt-7 grid gap-3">
              {roles.map((role) => (
                <div key={role.key} className="rounded-xl border bg-card p-4" data-role={role.key}>
                  <div className="flex items-center gap-2">
                    <div className="grid size-7 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <Users size={14} />
                    </div>
                    <Input
                      aria-label={`Name for ${role.key}`}
                      value={role.name}
                      onChange={(event) => updateRole(role.key, { name: event.target.value })}
                      maxLength={80}
                      className="h-8 border-0 bg-transparent px-1 font-medium shadow-none focus-visible:ring-0"
                    />
                  </div>
                  <Textarea
                    aria-label={`Responsibility for ${role.key}`}
                    value={role.description}
                    onChange={(event) => updateRole(role.key, { description: event.target.value })}
                    maxLength={500}
                    rows={2}
                    className="mt-2 border-0 bg-transparent px-1 text-body-sm text-muted-foreground shadow-none focus-visible:ring-0"
                  />
                </div>
              ))}
            </div>
            {createError ? (
              <p role="alert" className="mt-4 text-body-sm text-destructive">
                {createError}
              </p>
            ) : null}
            <WizardFooter
              onBack={() => go("profile")}
              backLabel="Back"
              primaryLabel="Continue"
              onPrimary={() => {
                if (roles.some((role) => !role.name.trim() || !role.description.trim())) {
                  setCreateError("Every AI employee needs a name and a responsibility.");
                  return;
                }
                setCreateError(null);
                go("model");
              }}
            />
          </div>
        ) : null}

        {step === "model" ? (
          <div>
            <h1 className="text-heading2 font-medium">
              <Trans>Connect your AI model</Trans>
            </h1>
            <p className="mt-2 text-body text-muted-foreground">
              {modelReady ? (
                <Trans>A model is connected. Your AI employees can start work.</Trans>
              ) : (
                <Trans>
                  Bring your own model or skip for now. You need a model before a task can run.
                </Trans>
              )}
            </p>
            {modelReady ? (
              <div className="mt-7 rounded-xl border border-success/30 bg-success/5 p-4">
                <p className="flex items-center gap-2 text-body font-medium">
                  <Check size={16} className="text-success" />
                  <Trans>Model connected</Trans>
                </p>
              </div>
            ) : (
              <div className="mt-7 rounded-xl border bg-card p-4 sm:p-6">
                <ModelStep model={model} fieldId="onboarding-model" />
              </div>
            )}
            <WizardFooter
              onBack={() => go("team")}
              backLabel="Back"
              primaryLabel={modelReady ? "Continue" : "Skip for now"}
              onPrimary={() => {
                if (modelReady) {
                  go("ready");
                  return;
                }
                setSkippedModel(true);
                go("ready");
              }}
              secondary={!modelReady}
            />
          </div>
        ) : null}

        {step === "ready" ? (
          <div>
            {company?.created ? (
              <ReadyView
                company={company}
                displayName={displayName}
                modelReady={modelReady}
                modelSkipped={skippedModel}
                showTask={showTask}
                firstTask={firstTask}
                taskBusy={taskBusy}
                taskError={taskError}
                createdTask={createdTask}
                onStartTask={() => setShowTask(true)}
                onFirstTaskChange={setFirstTask}
                onTaskSubmit={() => void startFirstTask()}
                onConfigureModel={() => go("model")}
                onDashboard={() => navigate("/app")}
              />
            ) : (
              <CreateReview
                displayName={displayName}
                description={description}
                roles={roles}
                modelReady={modelReady}
                creating={creating}
                error={createError}
                onCreate={() => void createCompany()}
                onBack={() => go("model")}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ExploreItem({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-body-sm font-medium">
        {icon}
        <Trans>{title}</Trans>
      </div>
      <p className="mt-1 text-label leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

function WizardFooter({
  onBack,
  backLabel,
  primaryLabel,
  onPrimary,
  secondary = false,
}: {
  onBack: () => void;
  backLabel: string;
  primaryLabel: string;
  onPrimary?: () => void;
  secondary?: boolean;
}) {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
      <Button type="button" variant="ghost" onClick={onBack}>
        <ArrowLeft size={15} />
        <Trans>{backLabel}</Trans>
      </Button>
      <Button
        type={onPrimary ? "button" : "submit"}
        variant={secondary ? "secondary" : "default"}
        onClick={onPrimary}
      >
        <Trans>{primaryLabel}</Trans>
        <ArrowRight size={15} />
      </Button>
    </div>
  );
}

function CreateReview({
  displayName,
  description,
  roles,
  modelReady,
  creating,
  error,
  onCreate,
  onBack,
}: {
  displayName: string;
  description: string;
  roles: WorkforceCompanyRoleInput[];
  modelReady: boolean;
  creating: boolean;
  error: string | null;
  onCreate: () => void;
  onBack: () => void;
}) {
  return (
    <section>
      <div className="grid size-12 place-items-center rounded-2xl bg-primary text-primary-foreground">
        <Landmark size={22} />
      </div>
      <h1 className="mt-7 text-heading2 font-medium">
        <Trans>Your AI company is ready to create</Trans>
      </h1>
      <p className="mt-2 text-body text-muted-foreground">
        <Trans>One company, four AI employees and a boardroom. Nothing runs until you ask.</Trans>
      </p>
      <div className="mt-6 rounded-xl border bg-card p-4">
        <p className="text-body-lg font-medium">{displayName}</p>
        {description ? (
          <p className="mt-1 text-body-sm text-muted-foreground">{description}</p>
        ) : null}
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {roles.map((role) => (
            <div key={role.key} className="rounded-lg border bg-background p-3">
              <p className="text-label font-medium">{role.name}</p>
              <p className="mt-0.5 text-label text-muted-foreground">{role.description}</p>
            </div>
          ))}
        </div>
      </div>
      {!modelReady ? (
        <p className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3 text-body-sm text-foreground">
          <Trans>
            No model is connected. You can create the company now, but a task needs a model before
            it can run.
          </Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onBack} disabled={creating}>
          <ArrowLeft size={15} />
          <Trans>Back</Trans>
        </Button>
        <Button
          type="button"
          data-testid="onboarding-create-company"
          onClick={onCreate}
          disabled={creating}
        >
          {creating ? <LoaderCircle size={15} className="animate-spin" /> : <Landmark size={15} />}
          {creating ? <Trans>Creating…</Trans> : <Trans>Create Your AI Company</Trans>}
        </Button>
      </div>
    </section>
  );
}

function ReadyView({
  company,
  displayName,
  modelReady,
  modelSkipped,
  showTask,
  firstTask,
  taskBusy,
  taskError,
  createdTask,
  onStartTask,
  onFirstTaskChange,
  onTaskSubmit,
  onConfigureModel,
  onDashboard,
}: {
  company: WorkforceCompanyStatus;
  displayName: string;
  modelReady: boolean;
  modelSkipped: boolean;
  showTask: boolean;
  firstTask: string;
  taskBusy: boolean;
  taskError: string | null;
  createdTask: Awaited<ReturnType<typeof rpc.workforce.tasks.create>> | null;
  onStartTask: () => void;
  onFirstTaskChange: (value: string) => void;
  onTaskSubmit: () => void;
  onConfigureModel: () => void;
  onDashboard: () => void;
}) {
  return (
    <section>
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-success/15 text-success">
          <Check size={19} />
        </div>
        <div>
          <p className="text-label font-medium uppercase tracking-wide text-muted-foreground">
            <Trans>Company ready</Trans>
          </p>
          <h1 className="text-heading2 font-medium">{displayName}</h1>
        </div>
      </div>
      {company.description ? (
        <p className="mt-3 max-w-[560px] text-body text-muted-foreground">{company.description}</p>
      ) : null}

      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {company.bots.map((bot) => (
          <div key={bot.id} className="rounded-xl border bg-card p-3">
            <div className="flex items-center gap-2 text-body-sm font-medium">
              <Users size={14} />
              {bot.name}
            </div>
            <p className="mt-1 text-label text-muted-foreground">{bot.description}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
        <span className={modelReady ? "text-success" : "text-warning"}>
          {modelReady ? <Check size={15} /> : <Sparkles size={15} />}
        </span>
        <span className="text-body-sm font-medium">
          {modelReady ? (
            <Trans>Model connected</Trans>
          ) : modelSkipped ? (
            <Trans>Model not connected yet</Trans>
          ) : (
            <Trans>Model not connected</Trans>
          )}
        </span>
        {!modelReady ? (
          <Button size="sm" variant="secondary" className="ms-auto" onClick={onConfigureModel}>
            <Trans>Connect a model</Trans>
          </Button>
        ) : null}
      </div>

      {company.meetingId ? (
        <Link
          to={`/app/meetings?meeting=${company.meetingId}`}
          className="mt-3 inline-flex items-center gap-1.5 text-body-sm font-medium text-primary hover:underline"
        >
          <Landmark size={14} />
          <Trans>Open the Executive Boardroom</Trans>
        </Link>
      ) : null}

      <div className="mt-8 rounded-2xl border bg-card p-5 sm:p-6">
        <h2 className="text-heading3 font-medium">
          <Trans>What would you like your AI company to accomplish?</Trans>
        </h2>
        <p className="mt-1 text-body-sm text-muted-foreground">
          <Trans>Start with one clear outcome. Your CEO Assistant will organize the work.</Trans>
        </p>
        {!showTask && !createdTask ? (
          <Button className="mt-5" onClick={onStartTask}>
            <Sparkles size={15} />
            <Trans>Start Your First Task</Trans>
            <ArrowRight size={15} />
          </Button>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          {[
            "Research a market opportunity",
            "Analyze a business idea",
            "Create a product launch plan",
            "Organize a project",
          ].map((example) => (
            <button
              key={example}
              type="button"
              className="rounded-full border bg-background px-3 py-1.5 text-label text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                onStartTask();
                onFirstTaskChange(example);
              }}
            >
              {example}
            </button>
          ))}
        </div>
        {showTask || createdTask ? (
          <div className="mt-5">
            <label className="text-body-sm font-medium" htmlFor="first-task">
              <Trans>Your first task</Trans>
            </label>
            <Textarea
              id="first-task"
              value={firstTask}
              onChange={(event) => onFirstTaskChange(event.target.value)}
              rows={3}
              maxLength={4_000}
              placeholder="Describe the outcome you want."
              className="mt-2"
            />
            {taskError ? (
              <p role="alert" className="mt-2 text-body-sm text-destructive">
                {taskError}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                disabled={!firstTask.trim() || taskBusy || Boolean(createdTask)}
                onClick={onTaskSubmit}
              >
                {taskBusy ? (
                  <LoaderCircle size={15} className="animate-spin" />
                ) : (
                  <ArrowRight size={15} />
                )}
                {taskBusy ? <Trans>Starting…</Trans> : <Trans>Send to your AI company</Trans>}
              </Button>
              {!modelReady ? (
                <Button type="button" variant="secondary" onClick={onConfigureModel}>
                  <Trans>Connect a model first</Trans>
                </Button>
              ) : null}
            </div>
            {createdTask ? (
              <div
                className="mt-4 rounded-xl border border-success/30 bg-success/5 p-4"
                role="status"
              >
                <p className="text-body-sm font-medium">
                  <Trans>Task created</Trans>
                </p>
                <p className="mt-1 text-label text-muted-foreground">
                  {createdTask.title} · {createdTask.executionStatus.replaceAll("_", " ")}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    to="/app/workforce"
                    className="inline-flex h-8 items-center gap-1 rounded-lg bg-secondary px-3 text-label font-medium text-secondary-foreground"
                  >
                    <Trans>Open Workforce</Trans>
                    <ArrowRight size={13} />
                  </Link>
                  {company.meetingId ? (
                    <Link
                      to={`/app/meetings?meeting=${company.meetingId}`}
                      className="inline-flex h-8 items-center gap-1 rounded-lg border px-3 text-label font-medium"
                    >
                      <Landmark size={13} />
                      <Trans>Open Boardroom</Trans>
                    </Link>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/app"
          className="inline-flex h-9 items-center rounded-lg bg-secondary px-4 text-body-sm font-medium text-secondary-foreground"
          onClick={onDashboard}
        >
          <Trans>Go to Dashboard</Trans>
        </Link>
        <p className="text-label text-muted-foreground">
          <Trans>You stay the Human CEO. Nothing is approved automatically.</Trans>
        </p>
      </div>
    </section>
  );
}
