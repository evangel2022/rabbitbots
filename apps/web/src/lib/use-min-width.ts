import { useSyncExternalStore } from "react";

/**
 * Whether the viewport is at least `px` wide. Reads `matchMedia` so layout choices that depend on
 * the column layout (rather than CSS alone) stay in step with the browser's actual width.
 */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
