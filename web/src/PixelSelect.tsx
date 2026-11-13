// Our own dropdown in the site style, used instead of the system <select>
// (the system list looked off-style). Same look and
// keys as the language menu in Shell.tsx: arrows, Home/End, Enter/Space,
// Escape, a click outside closes it.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface PixelOption<T extends string> {
  value: T;
  label: string;
}

export function PixelSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  labelledBy,
}: {
  value: T;
  options: readonly PixelOption<T>[];
  onChange: (v: T) => void;
  /** Accessible name when there is no visible label element. */
  label?: string;
  /** id of a visible label element. */
  labelledBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  const show = () => {
    setActive(index);
    setOpen(true);
  };
  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  const pick = (v: T) => {
    onChange(v);
    close();
  };

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
    const last = options.length - 1;
    if (e.key === 'ArrowDown') setActive((i) => (i >= last ? 0 : i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => (i <= 0 ? last : i - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(last);
    else if (e.key === 'Enter' || e.key === ' ') pick(options[active].value);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') close(false);
    else return;
    if (e.key !== 'Tab') e.preventDefault();
  };

  return (
    <div className="psel" ref={box}>
      <button
        ref={button}
        type="button"
        className="psel-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        aria-labelledby={labelledBy}
        onClick={() => (open ? close() : show())}
        onKeyDown={onButtonKey}
      >
        <span className="psel-value">{current.label}</span>
        <span className={open ? 'lang-caret up' : 'lang-caret'} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul id={listId} className="psel-menu" role="listbox" aria-label={label} aria-labelledby={labelledBy} onKeyDown={onListKey}>
          {options.map((o, i) => (
            <li
              key={o.value}
              ref={(el) => {
                items.current[i] = el;
              }}
              role="option"
              tabIndex={i === active ? 0 : -1}
              aria-selected={o.value === value}
              className={i === active ? 'lang-item psel-item active' : 'lang-item psel-item'}
              onClick={() => pick(o.value)}
              onPointerMove={() => i !== active && setActive(i)}
            >
              <span className="lang-name">{o.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
