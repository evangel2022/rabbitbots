import { t } from "@lingui/core/macro";
import type { ReactNode, RefObject } from "react";
import { useRef } from "react";

export type OutlineHeading = { level: number; text: string };

/** The report headings that make a long answer navigable. */
export function outlineHeadings(text: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  for (const match of text.matchAll(/^(#{1,3})\s+(.+?)\s*#*\s*$/gm)) {
    const level = (match[1] ?? "").length;
    const label = (match[2] ?? "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .trim();
    if (label) headings.push({ level, text: label });
  }
  return headings;
}

function normalized(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * A lightweight contents list for a long bot answer. It uses the headings already rendered in the
 * message, so no extra markdown ids or report structure are required.
 */
export function MessageOutline({
  text,
  containerRef,
}: {
  text: string;
  containerRef: RefObject<HTMLElement | null>;
}) {
  const headings = outlineHeadings(text).slice(0, 12);
  if (text.length < 1600 || headings.length < 3) return null;

  function jump(heading: OutlineHeading) {
    const container = containerRef.current;
    if (!container) return;
    const target = [...container.querySelectorAll<HTMLElement>("h1, h2, h3")].find(
      (node) => normalized(node.textContent) === normalized(heading.text),
    );
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  return (
    <details
      data-testid="message-outline"
      className="mb-2.5 rounded-lg border border-border/70 bg-background/50 px-2.5 py-2 text-body-sm"
    >
      <summary className="cursor-pointer select-none text-muted-foreground">{t`Contents`}</summary>
      <ol className="mt-1.5 space-y-0.5">
        {headings.map((heading) => (
          <li
            key={`${heading.level}:${heading.text}`}
            className={heading.level === 3 ? "ps-3" : undefined}
          >
            <button
              type="button"
              className="max-w-full truncate text-start text-foreground/80 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => jump(heading)}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Keeps the contents and the rendered headings in one queryable subtree. */
export function TextWithOutline({ text, children }: { text: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref}>
      <MessageOutline text={text} containerRef={ref} />
      {children}
    </div>
  );
}
