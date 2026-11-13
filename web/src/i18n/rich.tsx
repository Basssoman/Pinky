// Dictionary lines with pieces of markup: "Deal with {nick}" + { nick: <a…/> }.
// The words stay in the dictionary; the markup stays in the component.
import { Fragment, type ReactNode } from 'react';

export function rich(template: string, parts: Record<string, ReactNode>): ReactNode {
  return template.split(/(\{\w+\})/).map((piece, i) => {
    const m = /^\{(\w+)\}$/.exec(piece);
    return <Fragment key={i}>{m && m[1] in parts ? parts[m[1]] : piece}</Fragment>;
  });
}

/** The `{name}` placeholders of a template, sorted (used by the dictionary test). */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}
