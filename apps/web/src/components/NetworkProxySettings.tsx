import { Trans, useLingui } from "@lingui/react/macro";
import type { NetworkProxySettings as NetworkProxyView } from "@rakazo/contracts";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/**
 * Deployment-owner outbound proxy. The URL is write-only: it may contain a password,
 * so the server returns only its host and whether credentials are present.
 */
export function NetworkProxySettings() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const queryKey = ["network", "proxy"] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => rpc.networkProxy.get(),
    retry: false,
  });
  const [mode, setMode] = useState<"direct" | "proxy">("direct");
  const [url, setUrl] = useState("");
  const [bypass, setBypass] = useState("");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view: NetworkProxyView | undefined = query.data;

  function startEdit(next: NetworkProxyView) {
    setMode(next.mode);
    setBypass(next.bypass.join(", "));
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
      const saved = await rpc.networkProxy.update({
        mode,
        ...(mode === "proxy" && url.trim() ? { url: url.trim() } : {}),
        bypass: bypass
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      });
      queryClient.setQueryData(queryKey, saved);
      startEdit(saved);
    } catch (cause) {
      setError(errorText(cause, t`Could not save network proxy`));
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
      const result = await rpc.networkProxy.test();
      setTestResult(result.message);
    } catch (cause) {
      setError(errorText(cause, t`Could not test network proxy`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-border px-4 py-4" data-testid="network-proxy">
      <SectionHeading variant="heading">
        <Trans>Outbound network</Trans>
      </SectionHeading>
      <p className="mt-1 text-body-sm text-muted-foreground">
        <Trans>
          Route server-side model, web fetch and search traffic through an HTTP or HTTPS proxy. This
          does not configure bot computers or their browsers.
        </Trans>
      </p>
      {query.isPending ? (
        <p className="mt-3 text-body-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : query.isError ? (
        <p className="mt-3 text-body-sm text-destructive">
          {errorText(query.error, t`Unavailable`)}
        </p>
      ) : view ? (
        <>
          <p className="mt-3 text-label text-muted-foreground" data-testid="network-proxy-status">
            {view.source === "saved"
              ? view.mode === "direct"
                ? t`Saved: direct connection`
                : t`Saved: ${view.proxyHost ?? "proxy"}${view.hasCredentials ? " · credentials saved" : ""}`
              : view.source === "environment"
                ? t`Using deployment environment: ${view.proxyHost ?? "proxy"}`
                : t`Direct connection (default)`}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel>
                <Trans>Connection</Trans>
              </FieldLabel>
              <NativeSelect
                aria-label={t`Network proxy mode`}
                value={mode}
                onChange={(event) => setMode(event.target.value as "direct" | "proxy")}
                data-testid="network-proxy-mode"
              >
                <NativeSelectOption value="direct">
                  <Trans>Direct connection</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="proxy">
                  <Trans>HTTP / HTTPS proxy</Trans>
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel>
                <Trans>Bypass hosts</Trans>
              </FieldLabel>
              <Input
                value={bypass}
                placeholder="localhost, 127.0.0.1, .internal"
                onChange={(event) => setBypass(event.target.value)}
                data-testid="network-proxy-bypass"
              />
            </Field>
          </div>
          {mode === "proxy" ? (
            <Field className="mt-3">
              <FieldLabel>
                <Trans>Proxy URL</Trans>
              </FieldLabel>
              <Input
                value={url}
                placeholder={
                  view.mode === "proxy" && view.proxyHost
                    ? t`Leave blank to keep the saved proxy`
                    : "http://proxy.example.com:3128"
                }
                onChange={(event) => setUrl(event.target.value)}
                autoComplete="off"
                data-testid="network-proxy-url"
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
              data-testid="network-proxy-save"
            >
              <Trans>Save network proxy</Trans>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void test()}
              disabled={busy || (mode === "direct" && view.mode === "direct")}
              data-testid="network-proxy-test"
            >
              <Trans>Test connection</Trans>
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
