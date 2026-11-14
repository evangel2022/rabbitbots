import { AppLocaleSchema } from "@rakazo/contracts";
import { matchUiLocale } from "@rakazo/core";
import { readableLocalStorage } from "./stored-preference";

export const UI_LOCALES = AppLocaleSchema.options;

export type UiLocale = (typeof UI_LOCALES)[number];

export const UI_LOCALE_STORAGE_KEY = "rakazo.uiLocale";

/** Normalize BCP-47 tags (`de-DE`, `ko-KR`, `pt-BR`, `zh-CN`, `es-ES`) to a supported UI locale, else `en`. */
export function normalizeUiLocale(raw: string | null | undefined): UiLocale {
  return matchUiLocale(raw, UI_LOCALES);
}

function readStoredLocale(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readEnvDefault(env: { VITE_DEFAULT_UI_LOCALE?: string } | undefined): string | null {
  const value = env?.VITE_DEFAULT_UI_LOCALE;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type ResolveUiLocaleOptions = {
  stored?: string | null;
  envDefault?: string | null;
  navigatorLanguage?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
  env?: { VITE_DEFAULT_UI_LOCALE?: string };
  navigator?: Pick<Navigator, "language" | "languages"> | null;
};

/**
 * Order: saved choice (`localStorage`) → `VITE_DEFAULT_UI_LOCALE` → English.
 *
 * The product UI ships in English. Navigator language is deliberately not used to
 * choose a locale automatically: doing so mixed translated strings with the
 * English source strings throughout the interface. A user can still choose a
 * locale in Settings, which is persisted here and overrides this default.
 */
export function resolveUiLocale(options: ResolveUiLocaleOptions = {}): UiLocale {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredLocale(options.storage ?? readableLocalStorage());
  if (stored) return normalizeUiLocale(stored);

  const envDefault =
    options.envDefault !== undefined
      ? options.envDefault
      : readEnvDefault(
          options.env ??
            (typeof import.meta !== "undefined"
              ? {
                  VITE_DEFAULT_UI_LOCALE: (import.meta as ImportMeta).env?.VITE_DEFAULT_UI_LOCALE,
                }
              : undefined),
        );
  if (envDefault) return normalizeUiLocale(envDefault);

  return "en";
}

export function persistUiLocale(
  locale: UiLocale,
  storage: Pick<Storage, "setItem"> | null = readableLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore quota / private-mode failures; in-memory locale still applies.
  }
}
