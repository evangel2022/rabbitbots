import { cn } from "@rakazo/ui-web";

/**
 * The RabbitBots mark: a rabbit head drawn from the same simple geometry as the app icon.
 * The body uses `currentColor`; the eyes and mouth use the foreground token so the mark can
 * sit on an inverted plate (ink in light, paper in dark) without a second asset.
 */
export function RabbitBotsMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="10.6" cy="9.6" rx="3.5" ry="8" transform="rotate(-14 10.6 9.6)" />
      <ellipse cx="21.4" cy="9.6" rx="3.5" ry="8" transform="rotate(14 21.4 9.6)" />
      <ellipse cx="16" cy="21" rx="9.8" ry="8.6" />
      <g className="fill-foreground">
        <circle cx="12.15" cy="20.1" r="1.55" />
        <circle cx="19.85" cy="20.1" r="1.55" />
        <path
          d="M14.5 24.3q1.5 1.25 3 0"
          fill="none"
          className="stroke-foreground"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

/** The product lockup: an ink plate with the mark, then the RabbitBots name. */
export function RabbitBotsWordmark({
  className,
  showText = true,
}: {
  className?: string;
  showText?: boolean;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <span className="grid size-[22px] shrink-0 place-items-center rounded-[7px] bg-foreground text-background">
        <RabbitBotsMark className="size-4" />
      </span>
      {showText ? (
        <span className="truncate text-body font-semibold tracking-[-0.01em] text-foreground">
          RabbitBots
        </span>
      ) : null}
    </span>
  );
}
