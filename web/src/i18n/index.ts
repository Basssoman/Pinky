// Site languages. English is the source and the default; every other language
// is one file with the same keys (`Dict`), so a missing line is a type error.
// To add a language: write `xx.ts` (`export const xx: Dict = {…}`) and add one
// line to LANGS below.
//
// The choice is kept in localStorage only. It never goes into a link: deal and
// key links (`/d#…`, `/k#…`) stay exactly as they are.
import { useSyncExternalStore } from 'react';
import { en, type Dict } from './en';
import { es } from './es';
import { fr } from './fr';
import { ptPT } from './pt-PT';
import { tr as trDict } from './tr';
import { uk } from './uk';

export type { Dict } from './en';

export interface Lang {
  /** BCP 47 code, also set on <html lang>. */
  code: string;
  /** What the switcher chip shows. */
  label: string;
  /** The language's own name, for screen readers and the tooltip. */
  name: string;
  /** Locale for dates and numbers (Intl). */
  locale: string;
  dict: Dict;
}

export const LANGS: readonly Lang[] = [
  { code: 'en', label: 'EN', name: 'English', locale: 'en-US', dict: en },
  { code: 'uk', label: 'UA', name: 'Українська', locale: 'uk-UA', dict: uk },
  // AI translations below, waiting for a native check.
  { code: 'es', label: 'ES', name: 'Español', locale: 'es', dict: es },
  { code: 'pt-PT', label: 'PT', name: 'Português (Portugal)', locale: 'pt-PT', dict: ptPT },
  { code: 'tr', label: 'TR', name: 'Türkçe', locale: 'tr-TR', dict: trDict },
  { code: 'fr', label: 'FR', name: 'Français', locale: 'fr-FR', dict: fr },
];

const KEY = 'kept.lang';
const listeners = new Set<() => void>();

/** Choices stored by an older set of languages. */
const RENAMED: Record<string, string> = { 'pt-BR': 'pt-PT', id: 'en' };

/** The language for a stored code; an old or unknown code never breaks the page. */
export function langFor(code: string | null): Lang {
  const c = code !== null && code in RENAMED ? RENAMED[code] : code;
  return LANGS.find((l) => l.code === c) ?? LANGS[0];
}

function stored(): Lang {
  try {
    const code = window.localStorage.getItem(KEY);
    const lang = langFor(code);
    // Rewrite an old code once, so the menu and storage agree.
    if (code !== null && code !== lang.code && code in RENAMED) window.localStorage.setItem(KEY, lang.code);
    return lang;
  } catch {
    return LANGS[0];
  }
}

let current: Lang = typeof window === 'undefined' ? LANGS[0] : stored();

function apply() {
  if (typeof document !== 'undefined') document.documentElement.lang = current.code;
}
apply();

export function setLang(code: string): void {
  const next = LANGS.find((l) => l.code === code);
  if (!next || next === current) return;
  current = next;
  try {
    window.localStorage.setItem(KEY, code);
  } catch {
    /* private window or blocked storage: the choice lasts for this page only */
  }
  apply();
  listeners.forEach((f) => f());
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** The current language (outside React, e.g. in formatters). */
export const lang = (): Lang => current;
/** The current dictionary (outside React). */
export const tr = (): Dict => current.dict;
/** The current locale for Intl. */
export const locale = (): string => current.locale;

/** The current language; re-renders the component when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, lang, lang);
}

/** The current dictionary; re-renders the component when the language changes. */
export function useT(): Dict {
  return useLang().dict;
}
