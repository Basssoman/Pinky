// What the contract allows for a new deal: the link
// lifetimes the "New deal" form may offer. The test contract allows a client
// link of 1 hour, the final one days; the form never offers more than that.

const DAY = 24 * 3600_000;

export const LINK_DAYS = ['1', '2', '3', '7'] as const;
/** "As long as the contract allows": only when the contract allows less than a day. */
export const LINK_MAX = 'max';
export type LinkChoice = (typeof LINK_DAYS)[number] | typeof LINK_MAX;

/** What the contract allows, read from the chain (or our server); null = not known. */
export interface Limits {
  /** Longest a client link may work. */
  maxLinkMs: number | null;
  /** Time the client has to pay after accepting. */
  payWithinMs: number | null;
}

/** Link lifetimes the contract allows, and the one picked by default (3 days when allowed). */
export function linkChoices(limits: Limits | undefined): { options: LinkChoice[]; preferred: LinkChoice } {
  const max = limits?.maxLinkMs ?? null;
  const fit = max === null ? [...LINK_DAYS] : LINK_DAYS.filter((d) => Number(d) * DAY <= max);
  const options: LinkChoice[] = fit.length ? fit : [LINK_MAX];
  return { options, preferred: options.includes('3') ? '3' : options[options.length - 1] };
}
