// Header and the fixed safety footer shared by every screen.
// The language switcher lives here: one small chip with the current
// language; it opens our own list in the site style (the system list looked
// off-style). The choice stays in this browser and never goes
// into a link.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { LANGS, setLang, useLang } from './i18n';
import { rich } from './i18n/rich';
import { SUPPORT_CONTACT } from './lib/config';
import { PixelBackground } from './pixel';
import { navigate } from './real/ctx';
import { BotLine } from './TelegramNotify';

function LangSwitch() {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const label = lang.dict.shell.language;

  const show = (index = LANGS.indexOf(lang)) => {
    setActive(index < 0 ? 0 : index);
    setOpen(true);
  };
  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  const pick = (code: string) => {
    setLang(code);
    close();
  };

  // Close on a click or tap outside.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  useEffect(() => {
    if (open) items.current[active]?.focus();
  }, [open, active]);

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show();
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    const last = LANGS.length - 1;
    if (e.key === 'ArrowDown') setActive((i) => (i >= last ? 0 : i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => (i <= 0 ? last : i - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(last);
    else if (e.key === 'Enter' || e.key === ' ') pick(LANGS[active].code);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') close(false);
    else return;
    if (e.key !== 'Tab') e.preventDefault();
  };

  return (
    <div className="lang-switch" ref={box}>
      <button
        ref={button}
        type="button"
        className="chip lang-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${lang.name}`}
        title={label}
        onClick={() => (open ? close() : show())}
        onKeyDown={onButtonKey}
      >
        {lang.label}
        <span className={open ? 'lang-caret up' : 'lang-caret'} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="lang-menu" role="listbox" aria-label={label} onKeyDown={onListKey}>
          {LANGS.map((l, i) => (
            <li
              key={l.code}
              ref={(el) => {
                items.current[i] = el;
              }}
              role="option"
              lang={l.code}
              tabIndex={i === active ? 0 : -1}
              aria-selected={l.code === lang.code}
              className={i === active ? 'lang-item active' : 'lang-item'}
              onClick={() => pick(l.code)}
              onPointerMove={() => i !== active && setActive(i)}
            >
              <span className="lang-code">{l.label}</span>
              <span className="lang-name">{l.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** `bleed`: the page goes edge to edge (the home page's bands); header and footer stay centred. */
export function Shell({ children, bleed = false }: { children: ReactNode; bleed?: boolean }) {
  const dict = useLang().dict;
  const t = dict.shell;
  const nav = dict.market.nav;
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate('/creators');
  };
  return (
    <>
      {!bleed && <PixelBackground />}
    <div className={bleed ? 'page page-bleed' : 'page'}>
      <header className="top">
        <a className="logo" href="/" aria-label={t.homeLabel}>
          {/* lang="en": the logo is uppercased in CSS, and Turkish rules would make it "PİNKY". */}
          <span lang="en">Pinky</span>
        </a>
        <nav className="top-nav">
          <a href="/creators" onClick={go} aria-current={window.location.pathname.startsWith('/creators') ? 'page' : undefined}>
            {nav}
          </a>
        </nav>
        <LangSwitch />
      </header>

      {children}

      <footer className="foot">
        <p>{t.neverAsk}</p>
        <BotLine />
        {/* the site's own address, not a hard-coded domain (none is bought yet) */}
        <p>{rich(t.realLink, { url: <code>{`${window.location.origin}/d#`}</code> })}</p>
        {SUPPORT_CONTACT && <p>{t.support(SUPPORT_CONTACT)}</p>}
        <p>
          <a href="/status">{t.statusLink}</a> · <a href="/disputes">{t.disputesLink}</a>
        </p>
      </footer>
    </div>
    </>
  );
}
