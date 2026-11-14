import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/**
 * The onboarding entry point is a server-data gate, not a local tutorial flag:
 * only a user without an AI company enters the wizard, and an existing company
 * always goes to the app.
 */
export function OnboardingPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    rpc.workforce.company
      .status()
      .then((status) => {
        if (cancelled) return;
        navigate(status.created ? "/app" : "/onboarding/company", { replace: true });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause, "Could not check your AI company."));
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, attempt]);

  if (error) {
    return (
      <div className="min-h-full bg-background px-6 py-12" data-rakazo-surface="onboarding">
        <div className="mx-auto w-full max-w-[520px] rounded-xl border border-destructive/30 bg-card p-5">
          <p role="alert" className="text-body text-destructive">
            {error}
          </p>
          <Button className="mt-4" onClick={() => setAttempt((value) => value + 1)}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      </div>
    );
  }
  return <PageLoading />;
}
