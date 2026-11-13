// Plural forms by the rules of a language (Intl.PluralRules), for dictionaries.
export type Forms = { one: string; few?: string; many?: string; other: string };

export function pluralForm(locale: string, n: number, forms: Forms): string {
  const cat = new Intl.PluralRules(locale).select(n) as keyof Forms;
  return forms[cat] ?? forms.other;
}
