import { useLingui } from "@lingui/react/macro";
import type { DeliveryQuality } from "../lib/delivery-quality";
import { evidenceTrustLabel } from "../lib/delivery-quality";

function evidenceTone(trust: "VERIFIED" | "UNVERIFIED" | "INVALID"): string {
  return trust === "VERIFIED"
    ? "text-success"
    : trust === "INVALID"
      ? "text-destructive"
      : "text-status-working";
}

export function DeliveryQualityNotice({ quality }: { quality: DeliveryQuality }) {
  const { t } = useLingui();
  const incomplete = quality.criteriaStatus === "STRUCTURALLY_INCOMPLETE";
  return (
    <section
      className="rounded-lg border bg-background p-3"
      data-testid="delivery-quality"
      aria-label={t`Delivery quality`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-label font-medium">{t`Delivery quality`}</h3>
        <span className={cnTone(incomplete)} data-testid="delivery-quality-status">
          {incomplete ? t`STRUCTURALLY INCOMPLETE` : t`NOT VERIFIED`}
        </span>
      </div>
      <p className="mt-1 text-label text-muted-foreground">
        {t`Execution success does not mean the acceptance criteria were met or the evidence is verified.`}
      </p>
      <dl className="mt-2 grid gap-1 text-label">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">{t`Findings`}</dt>
          <dd>
            {quality.findings.required === null
              ? t`Not required by criteria`
              : `${quality.findings.found} / ${quality.findings.required}${quality.findings.met ? "" : ` · ${t`missing`}`}`}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">{t`Verification note`}</dt>
          <dd>
            {!quality.verificationNote.required
              ? t`Not required by criteria`
              : quality.verificationNote.found
                ? t`Structure present; content not independently verified`
                : t`Missing`}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">{t`Evidence`}</dt>
          <dd>
            {quality.evidence.count === 0
              ? t`No evidence recorded`
              : `${quality.evidence.count} · ${quality.evidence.invalid} ${t`invalid`} · ${quality.evidence.unverified} ${t`unverified`}`}
          </dd>
        </div>
      </dl>
      {quality.evidenceItems.length ? (
        <ul className="mt-2 space-y-1 text-label">
          {quality.evidenceItems.map((item) => (
            <li
              key={item.raw}
              className="flex flex-wrap items-baseline gap-x-2"
              data-testid="delivery-evidence-item"
            >
              <span className={evidenceTone(item.trust)} data-testid="evidence-trust">
                {evidenceTrustLabel(item.trust)}
              </span>
              <span className="min-w-0 break-words text-muted-foreground">{item.raw}</span>
              {item.reason ? <span className="text-muted-foreground">— {item.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {quality.warnings.length ? (
        <ul
          className="mt-2 list-disc space-y-0.5 ps-5 text-label text-status-working"
          role="status"
        >
          {quality.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function cnTone(incomplete: boolean): string {
  return incomplete ? "text-destructive" : "text-status-working";
}
