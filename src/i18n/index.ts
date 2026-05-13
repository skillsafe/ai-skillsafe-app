import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ICU from "i18next-icu";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
import zhCN from "./locales/zh-CN.json";
import ja from "./locales/ja.json";

export const SUPPORTED = ["en", "es", "fr", "de", "zh-CN", "ja"] as const;
export type Locale = (typeof SUPPORTED)[number];

export const NATIVE_NAME: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  "zh-CN": "简体中文",
  ja: "日本語",
};

const STORAGE_KEY = "skill-manager.locale";

export function isSupported(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED as readonly string[]).includes(value);
}

export function matchLocale(raw: string | null | undefined): Locale {
  if (!raw) return "en";
  const lc = raw.toLowerCase();
  if (lc.startsWith("zh")) return "zh-CN";
  const base = lc.split(/[-_]/)[0];
  for (const sup of SUPPORTED) {
    if (sup === "zh-CN") continue;
    if (sup.toLowerCase().split("-")[0] === base) return sup;
  }
  return "en";
}

export function readStoredLocale(): Locale | null {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isSupported(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredLocale(l: Locale): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, l);
  } catch {
    /* ignore */
  }
}

async function detectOsLocale(): Promise<string | null> {
  try {
    const mod = await import("@tauri-apps/plugin-os");
    const raw = await mod.locale();
    return raw ?? null;
  } catch {
    return null;
  }
}

export async function detectInitialLocale(): Promise<Locale> {
  const saved = readStoredLocale();
  if (saved) return saved;
  const osLoc = await detectOsLocale();
  if (osLoc) return matchLocale(osLoc);
  return matchLocale(globalThis.navigator?.language);
}

export async function initI18n(): Promise<Locale> {
  const lng = await detectInitialLocale();
  await i18n
    .use(ICU)
    .use(initReactI18next)
    .init({
      lng,
      fallbackLng: "en",
      supportedLngs: SUPPORTED as readonly string[] as string[],
      resources: {
        en: { translation: en },
        es: { translation: es },
        fr: { translation: fr },
        de: { translation: de },
        "zh-CN": { translation: zhCN },
        ja: { translation: ja },
      },
      // Index resources synchronously inside init() so the awaited promise
      // doesn't resolve before the resource store is ready. Default (true)
      // schedules indexing on the event loop, which created a race where
      // React mounted before t() could resolve keys — users saw the raw
      // dotted key strings render. See v0.2.11 i18n regression.
      initImmediate: false,
      // Defensive: disable react-i18next's Suspense path. Even if the very
      // first render somehow lands before `ready` flips, useTranslation
      // falls back to a re-render once resources land instead of suspending
      // (and we have no Suspense boundary in App). The trade is one extra
      // render on cold start, which is invisible at this app's scale.
      react: { useSuspense: false },
      interpolation: { escapeValue: false },
      returnEmptyString: false,
    });
  return lng;
}

export async function setLocale(l: Locale): Promise<void> {
  writeStoredLocale(l);
  await i18n.changeLanguage(l);
}

export { i18n };
