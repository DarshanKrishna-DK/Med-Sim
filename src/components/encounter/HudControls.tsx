import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { Kbd } from '../ui/chrome';

type TipSide = 'top' | 'bottom' | 'left' | 'top-end' | 'bottom-end';

/** Square 40px icon button with a real tooltip (hover + keyboard focus)
 *  that repeats the accessible name and shows the shortcut when there is one. */
export function IconButton({
  label,
  kbd,
  tip = 'bottom',
  className = '',
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  label: string;
  kbd?: string;
  tip?: TipSide;
  children: ReactNode;
}) {
  return (
    <span className={`tip-wrap tip-wrap--${tip}`}>
      <button type="button" className={`icon-btn ${className}`.trim()} aria-label={label} aria-keyshortcuts={kbd} {...rest}>
        {children}
      </button>
      <span className="tip" aria-hidden="true">
        {label}
        {kbd && <Kbd>{kbd}</Kbd>}
      </span>
    </span>
  );
}

/** Small stroke icons used across the HUD (16px, currentColor). */
export const Icon = {
  more: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="currentColor">
      <rect x="7.5" y="2.5" width="3" height="3" />
      <rect x="7.5" y="7.5" width="3" height="3" />
      <rect x="7.5" y="12.5" width="3" height="3" />
    </svg>
  ),
  mic: (muted = false) => (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="6" y="2" width="6" height="9.5" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 9a5.5 5.5 0 0 0 11 0M9 14.5v2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {muted && <path d="m2.5 2.5 13 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  ),
  hangUp: (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M2.5 11.5c4.2-4 10.8-4 15 0l-1.8 2.3-3.2-1.2v-2.2a8.6 8.6 0 0 0-5 0v2.2l-3.2 1.2Z"
        fill="currentColor"
      />
    </svg>
  ),
  send: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square">
      <path d="M3 9h11M9.5 4.5 14 9l-4.5 4.5" />
    </svg>
  ),
  close: (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="m2.5 2.5 7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
    </svg>
  ),
  chevron: (open: boolean) => (
    <svg className={`chev ${open ? 'is-open' : ''}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="m3.5 5.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  ),
  bell: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1.2 1.2H2.8Z" />
      <path d="M6.5 14.2h3" strokeLinecap="round" />
    </svg>
  ),
};

export interface MenuEntry {
  label: string;
  onSelect: () => void;
  kbd?: string;
  disabled?: boolean;
  /** Shown under the label (e.g. why it is disabled). */
  note?: string;
}

/** Kebab (overflow) menu for secondary actions. Opens below its trigger,
 *  focuses the first item, arrow keys move, Esc or an outside click closes
 *  and returns focus to the trigger. `extra` renders below the items. */
export function OverflowMenu({ label, items, extra }: { label: string; items: MenuEntry[]; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const focusables = () =>
    Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>('.hud-menu [role="menuitem"]:not(:disabled), .hud-menu .lang-toggle button') ?? []);

  useEffect(() => {
    if (!open) return;
    focusables()[0]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Keep Esc from also opening the room's pause menu.
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const list = focusables();
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
    list[next]?.focus();
  };

  return (
    <div className="hud-menu-wrap" ref={wrap} onKeyDown={open ? onKey : undefined}>
      <span className="tip-wrap tip-wrap--bottom-end">
        <button
          ref={trigger}
          type="button"
          className={`icon-btn ${open ? 'is-active' : ''}`}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          {Icon.more}
        </button>
        {!open && (
          <span className="tip" aria-hidden="true">
            {label}
          </span>
        )}
      </span>
      {open && (
        <div className="hud-menu" id={menuId} role="menu" aria-label={label}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="hud-menu-item"
              disabled={it.disabled}
              aria-keyshortcuts={it.kbd}
              onClick={() => {
                close(false);
                it.onSelect();
              }}
            >
              <span className="hud-menu-text">
                <span>{it.label}</span>
                {it.note && <span className="hud-menu-note">{it.note}</span>}
              </span>
              {it.kbd && <Kbd>{it.kbd}</Kbd>}
            </button>
          ))}
          {extra && <div className="hud-menu-extra">{extra}</div>}
        </div>
      )}
    </div>
  );
}
