import { Trans, useLingui } from "@lingui/react/macro";
import type { UserNetworkProxySettings as UserNetworkProxyView } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** The signed-in person's own model egress choice; never shows a saved URL or password. */
export function UserNetworkProxySettings() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const queryKey = ["user", "network", "proxy"] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => rpc.userProxy.get(),
    retry: false,
  });
  const [mode, setMode] = useState<"inherit" | "direct" | "custom">("inherit");
  const [url, setUrl] = useState("");
  const [bypass, setBypass] = useState("");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view: UserNetworkProxyView | undefined = query.data;

  function startEdit(next: UserNetworkProxyView) {
    setMode(next.mode);
    setBypass(next.mode === "custom" ? next.bypass.join(", ") : "");
    setUrl("");
    setTestResult(null);
    setError(null);
  }

  useEffect(() => {
    if (view) startEdit(view);
    // Only reinitialize when the server's saved view changes, not while the user types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.dataUpdatedAt, view?.mode, view?.proxyHost, view?.hasCredentials, view?.bypass]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const saved = await rpc.userProxy.update({
        mode,
        ...(mode === "custom" && url.trim() ? { url: url.trim() } : {}),
        ...(mode === "custom"
          ? {
              bypass: bypass
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean),
            }
          : {}),
      });
      queryClient.setQueryData(queryKey, saved);
      startEdit(saved);
    } catch (cause) {
      setError(errorText(cause, t`Could not save your proxy`));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await rpc.userProxy.test();
      setTestResult(result.message);
    } catch (cause) {
      setError(errorText(cause, t`Could not test your proxy`));
    } finally {
      setBusy(false);
    }
  }

  const status =
    view?.mode === "direct"
      ? t`Direct connection`
      : view?.mode === "custom"
        ? t`My proxy: ${view.proxyHost ?? "proxy"}${view.hasCredentials ? " · credentials saved" : ""}`
        : view?.source === "deployment"
          ? t`Inheriting deployment default: ${view.proxyHost ?? "proxy"}`
          : view?.source === "environment"
            ? t`Inheriting deployment environment: ${view.proxyHost ?? "proxy"}`
            : t`Inheriting direct default`;

  return (
    <div
      className="mt-4 rounded-xl border border-border px-4 py-4"
      data-testid="user-network-proxy"
    >
      {query.isPending ? (
        <p className="text-body-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : query.isError ? (
        <p className="text-body-sm text-destructive">{errorText(query.error, t`Unavailable`)}</p>
      ) : view ? (
        <>
          <p className="text-label text-muted-foreground" data-testid="user-network-proxy-status">
            {status}
          </p>
          <p className="mt-1 text-body-sm text-muted-foreground">
            {view.deploymentProxyConfigured
              ? t`Deployment default: ${view.deploymentProxyHost ?? "proxy"}`
              : t`Deployment default: direct connection`}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel>
                <Trans>My proxy mode</Trans>
              </FieldLabel>
              <NativeSelect
                aria-label={t`My proxy mode`}
                value={mode}
                onChange={(event) => setMode(event.target.value as "inherit" | "direct" | "custom")}
                data-testid="user-network-proxy-mode"
              >
                <NativeSelectOption value="inherit">
                  <Trans>Inherit deployment</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="direct">
                  <Trans>Direct connection</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="custom">
                  <Trans>Custom proxy</Trans>
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            {mode === "custom" ? (
              <Field>
                <FieldLabel>
                  <Trans>Bypass hosts</Trans>
                </FieldLabel>
                <Input
                  value={bypass}
                  placeholder="localhost, 127.0.0.1, .internal"
                  onChange={(event) => setBypass(event.target.value)}
                  data-testid="user-network-proxy-bypass"
                />
              </Field>
            ) : null}
          </div>
          {mode === "custom" ? (
            <Field className="mt-3">
              <FieldLabel>
                <Trans>Custom proxy URL</Trans>
              </FieldLabel>
              <Input
                value={url}
                placeholder={
                  view.mode === "custom" && view.proxyHost
                    ? t`Leave blank to keep the saved proxy`
                    : "http://proxy.example.com:3128"
                }
                onChange={(event) => setUrl(event.target.value)}
                autoComplete="off"
                data-testid="user-network-proxy-url"
              />
              <p className="mt-1 text-label text-muted-foreground">
                <Trans>
                  Include credentials in the URL only when required. Stored encrypted; never shown
                  again.
                </Trans>
              </p>
            </Field>
          ) : null}
          {error ? (
            <p role="alert" className="mt-2 text-body-sm text-destructive">
              {error}
            </p>
          ) : null}
          {testResult ? (
            <p className="mt-2 text-body-sm text-muted-foreground">{testResult}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={busy}
              data-testid="user-network-proxy-save"
            >
              <Trans>Save my proxy</Trans>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void test()}
              disabled={busy || (mode === "direct" && view.mode === "direct")}
              data-testid="user-network-proxy-test"
            >
              <Trans>Test connection</Trans>
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
