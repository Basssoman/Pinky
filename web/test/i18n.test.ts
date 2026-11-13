// Every language has every line of English, of the same kind; placeholders
// match; the dates and plurals come out right; and every message the browser's
// own deal checks can show is translated.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { LANGS, langFor, setLang, tr } from '../src/i18n';
import { placeholders } from '../src/i18n/rich';
import { DAY, HOUR, MIN } from '../src/i18n/time';
import { DealError } from '../src/lib/flows';
import { explain } from '../src/ui';

type Leaf = { path: string; value: unknown };

function leaves(o: unknown, path = ''): Leaf[] {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  }
  return [{ path, value: o }];
}

const kind = (v: unknown) => (Array.isArray(v) ? 'array' : typeof v);
const at = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown>)?.[k], o);

describe('dictionaries', () => {
  const source = leaves(en);

  it('English is the first and default language', () => {
    expect(LANGS[0].code).toBe('en');
    expect(LANGS[0].dict).toBe(en);
    expect(tr()).toBe(en);
  });

  for (const lang of LANGS.slice(1)) {
    describe(lang.code, () => {
      const other = leaves(lang.dict);

      it('has exactly the keys of English', () => {
        expect(other.map((l) => l.path).sort()).toEqual(source.map((l) => l.path).sort());
      });

      it('has the same kind of entry for every key', () => {
        for (const { path, value } of source) {
          const v = at(lang.dict, path);
          expect(kind(v), path).toBe(kind(value));
          if (typeof value === 'function') expect((v as (...a: unknown[]) => unknown).length, path).toBe(value.length);
          if (Array.isArray(value)) expect((v as unknown[]).length, path).toBe(value.length);
        }
      });

      it('keeps every {placeholder} of English', () => {
        for (const { path, value } of source) {
          if (typeof value !== 'string') continue;
          expect(placeholders(at(lang.dict, path) as string), path).toEqual(placeholders(value));
        }
      });

      it('has no empty lines and no English left in the functions', () => {
        for (const { path, value } of other) {
          if (typeof value === 'string') expect(value.trim(), path).not.toBe('');
          if (Array.isArray(value)) for (const x of value) expect(typeof x, path).toBe('string');
          if (typeof value === 'function') {
            const out = (value as (...a: unknown[]) => unknown)(...Array.from({ length: value.length }, () => 1));
            const text = Array.isArray(out) ? out.join('\n') : out;
            expect(typeof text, path).toBe('string');
            expect((text as string).trim(), path).not.toBe('');
          }
        }
      });
    });
  }
});

describe('English reads exactly as before', () => {
  it('time spans and time left', () => {
    expect(en.units.span(14 * DAY)).toBe('14 days');
    expect(en.units.span(DAY)).toBe('1 day');
    expect(en.units.span(5 * HOUR)).toBe('5 hours');
    expect(en.units.span(20 * MIN)).toBe('20 minutes');
    expect(en.units.span(30 * 1000)).toBe('1 minute');
    expect(en.units.left(2.1 * DAY)).toBe('3 days left');
    expect(en.units.left(0)).toBe('no time left');
    expect(en.units.revisions(1)).toBe('1 round of changes before delivery');
    expect(en.offer.mobilePrice('300', 14 * DAY)).toBe('300 USDC, delivered 14 days after payment');
    expect(en.deal.refundClient('', '300', false)).toBe('300 USDC went back to you. The deal is closed.');
    expect(en.deal.refundCreator('You agreed on a full refund.')).toBe('You agreed on a full refund. The deal is closed without payment.');
  });
});

describe('Ukrainian grammar', () => {
  const uk = LANGS.find((l) => l.code === 'uk')!.dict;
  it('plural forms', () => {
    expect(uk.units.days(1)).toBe('1 день');
    expect(uk.units.days(3)).toBe('3 дні');
    expect(uk.units.days(5)).toBe('5 днів');
    expect(uk.units.days(21)).toBe('21 день');
    expect(uk.units.span(2 * HOUR)).toBe('2 години');
    expect(uk.units.left(5 * MIN)).toBe('ще 5 хвилин');
    expect(uk.deal.stars(2)).toBe('2 зірки');
  });
  it('cases after prepositions', () => {
    expect(uk.deal.expiredClient(7 * DAY)).toContain('протягом 7 днів');
    expect(uk.deal.expiredClient(DAY)).toContain('протягом 1 дня');
    expect(uk.pay.doneLead('300', null, HOUR, '20 листопада')).toContain('має 1 годину');
    expect(uk.offer.mobilePrice('300', 14 * DAY)).toBe('300 USDC, здача через 14 днів після оплати');
  });
});

describe('the other languages', () => {
  const by = (code: string) => LANGS.find((l) => l.code === code)!.dict;
  it('are all there, Russian is not', () => {
    expect(LANGS.map((l) => l.code)).toEqual(['en', 'uk', 'es', 'pt-PT', 'tr', 'fr']);
    expect(LANGS.map((l) => l.label)).toEqual(['EN', 'UA', 'ES', 'PT', 'TR', 'FR']);
    expect(LANGS.find((l) => l.code === 'pt-PT')!.name).toBe('Português (Portugal)');
    expect(LANGS.find((l) => l.code === 'fr')!.name).toBe('Français');
  });
  it('an old stored choice still opens a page', () => {
    expect(langFor('pt-BR').code).toBe('pt-PT');
    expect(langFor('id').code).toBe('en');
    expect(langFor('fr').code).toBe('fr');
    expect(langFor('xx').code).toBe('en');
    expect(langFor(null).code).toBe('en');
  });
  it('time spans read right', () => {
    expect(by('es').units.span(DAY)).toBe('1 día');
    expect(by('es').units.left(3 * DAY)).toBe('quedan 3 días');
    expect(by('pt-PT').units.span(14 * DAY)).toBe('14 dias');
    expect(by('pt-PT').units.left(MIN)).toBe('falta 1 minuto');
    expect(by('tr').units.span(14 * DAY)).toBe('14 gün');
    expect(by('tr').deal.shareCreator(70)).toBe('%70 size, %3 komisyon kesildi');
    expect(by('fr').units.span(DAY)).toBe('1 jour');
    expect(by('fr').units.left(5 * HOUR)).toBe('il reste 5 heures');
  });
  it('French puts "le" / "jusqu’au" before a date, not before "the deadline"', () => {
    const fr = by('fr');
    expect(fr.deal.lateClient('20 novembre')).toBe('Le travail n’a pas été livré avant le 20 novembre.');
    expect(fr.deal.lateClient(fr.units.theDeadline)).toBe('Le travail n’a pas été livré avant l’échéance.');
    expect(fr.deal.untilDay('20 novembre')).toBe('jusqu’au 20 novembre');
    expect(fr.deal.untilDay(fr.units.theDeadline)).toBe('jusqu’à l’échéance');
  });
  it('Portugal Portuguese, not Brazilian', () => {
    const pt = by('pt-PT');
    expect(pt.key.download).toBe('Transferir o ficheiro da chave');
    expect(pt.deal.lateClient(pt.units.theDeadline)).toBe('O trabalho não foi entregue até ao fim do prazo.');
    const all = leaves(pt).flatMap((l) => (typeof l.value === 'string' ? [l.value] : Array.isArray(l.value) ? l.value : [])).join(' | ');
    // Brazilian words (whole words only: "vocês", the plural, is fine in Portugal).
    for (const br of ['arquivo', 'salvar', 'baixar', 'cadastro', 'senha', 'equipe', 'golpe', 'você', 'usuário', 'tela']) {
      expect(new RegExp(`(^|[^\\p{L}])${br}($|[^\\p{L}])`, 'iu').test(all), br).toBe(false);
    }
  });
  it('the home v2 is translated in every language', () => {
    for (const lang of LANGS.slice(1)) {
      expect(lang.dict.home.v2.title, lang.code).not.toBe(en.home.v2.title);
      expect(lang.dict.home.v2.faqA, lang.code).not.toEqual(en.home.v2.faqA);
    }
  });
  it('the marketplace is translated in every language', () => {
    for (const lang of LANGS.slice(1)) {
      const m = lang.dict.market;
      expect(m.catalog.lead, lang.code).not.toBe(en.market.catalog.lead);
      expect(m.editor.keyLead, lang.code).not.toBe(en.market.editor.keyLead);
      expect(m.errors.unreachable, lang.code).not.toBe(en.market.errors.unreachable);
      expect(m.dealsDone(2), lang.code).not.toBe(en.market.dealsDone(2));
    }
  });
  it('dates use each locale', async () => {
    const { fmtDate } = await import('../src/deal');
    const d = new Date('2026-11-20T12:00:00Z');
    const far = d.getTime() - 10 * DAY;
    const want: Record<string, string> = { es: '20 de noviembre', 'pt-PT': '20 de novembro', tr: '20 Kasım', fr: '20 novembre' };
    try {
      for (const [code, text] of Object.entries(want)) {
        setLang(code);
        expect(fmtDate(d, far), code).toBe(text);
      }
    } finally {
      setLang('en');
    }
  });
});

describe('switching the language', () => {
  it('dates use Intl in the chosen language; amounts and codes do not change', async () => {
    const { fmtDate, usd } = await import('../src/deal');
    const d = new Date('2026-11-20T12:00:00Z');
    const far = d.getTime() - 10 * DAY;
    expect(fmtDate(d, far)).toBe('November 20');
    setLang('uk');
    try {
      expect(fmtDate(d, far)).toBe('20 листопада');
      expect(usd(291_500_000n)).toBe('291.50');
    } finally {
      setLang('en');
    }
    expect(tr()).toBe(en);
  });

  it('every message of the browser deal checks is translated, in every language', () => {
    const src = readFileSync(new URL('../src/lib/flows.ts', import.meta.url), 'utf8');
    const msgs = [...src.matchAll(/new DealError\('\w+', '([^']+)'\)/g)].map((m) => m[1]);
    msgs.push('the offer has a bad amount', 'this browser does not hold the client key of this deal');
    expect(msgs.length).toBeGreaterThan(15);
    for (const lang of LANGS.slice(1)) {
      setLang(lang.code);
      try {
        for (const m of msgs) {
          const shown = explain(new DealError('state', m));
          expect(shown, `${lang.code}: ${m}`).not.toContain(m);
        }
        if (lang.code === 'uk') expect(explain(new DealError('state', msgs[0]))).toMatch(/[а-яіїєґ]/i);
      } finally {
        setLang('en');
      }
    }
    // English keeps the exact sentence as before.
    expect(explain(new DealError('tampered', 'the terms are not readable'))).toBe('The terms are not readable.');
  });
});
