import { useEffect, useRef, useState, type ReactNode } from 'react';
import { store, useScreen } from '../../game/store';
import { HAS_CORRIDOR } from '../corridorRoute';

// ── Navigation helpers ───────────────────────────────────────────────

/** "Enter the hospital": the 3D corridor when the 3D layer ships its
 *  screen, otherwise the case library. Call from a click handler. */
export function enterHospital() {
  if (HAS_CORRIDOR) store.enterCorridor();
  else store.setScreen('library');
}

/** Jump to a section on the landing page from any screen. */
export function goToLandingSection(id: string) {
  const scroll = () => document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  if (store.getState().screen === 'home' || store.getState().screen === 'splash') scroll();
  else {
    store.setScreen('home');
    window.setTimeout(scroll, 60);
  }
}

// ── Brand ────────────────────────────────────────────────────────────

/** Pixel cross in a square: the MedSim mark. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true" className="brand-mark">
      <rect x="0" y="0" width="8" height="8" fill="var(--primary)" />
      <rect x="1" y="1" width="6" height="6" fill="var(--on-primary)" />
      <rect x="3" y="2" width="2" height="4" fill="var(--primary)" />
      <rect x="2" y="3" width="4" height="2" fill="var(--primary)" />
    </svg>
  );
}

export function Brand({ onClick }: { onClick?: () => void }) {
  const content = (
    <>
      <BrandMark />
      <span className="brand-word">MedSim</span>
    </>
  );
  if (!onClick) return <span className="brand">{content}</span>;
  return (
    <button type="button" className="brand brand-btn" onClick={onClick} aria-label="MedSim home">
      {content}
    </button>
  );
}

// ── App header ───────────────────────────────────────────────────────

/** Fixed 64px nav. On the landing it starts transparent over the hero and
 *  turns solid once scrolled; on every page it hides while scrolling down
 *  and returns on scroll up. */
export function AppHeader({ overlay = false }: { overlay?: boolean }) {
  const screen = useScreen();
  const [solid, setSolid] = useState(!overlay);
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setSolid(!overlay || y > 24);
      setHidden(y > 160 && y > lastY.current + 4);
      if (y < lastY.current - 4 || y < 160) setHidden(false);
      lastY.current = y;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [overlay]);

  const links: Array<{ label: string; active: boolean; go: () => void }> = [
    { label: 'Cases', active: screen === 'library' || screen === 'brief', go: () => store.setScreen('library') },
    { label: 'Specialties', active: false, go: () => goToLandingSection('specialties') },
    { label: 'How it works', active: false, go: () => goToLandingSection('how') },
    { label: 'Debriefs', active: screen === 'history' || screen === 'debrief', go: () => store.setScreen('history') },
  ];

  return (
    <header className={`nav night ${solid ? 'is-solid' : ''} ${hidden ? 'is-hidden' : ''}`}>
      <div className="nav-inner">
        <Brand onClick={() => { store.setScreen('home'); window.scrollTo(0, 0); }} />
        <nav className="nav-links" aria-label="Main">
          {links.map((l) => (
            <button
              key={l.label}
              type="button"
              className="nav-link"
              aria-current={l.active ? 'page' : undefined}
              onClick={l.go}
            >
              {l.label}
            </button>
          ))}
        </nav>
        <button type="button" className="btn btn-primary btn-sm nav-cta" onClick={enterHospital}>
          Enter the hospital
        </button>
      </div>
    </header>
  );
}

/** 3px route-progress line that steps across on every screen change. */
export function RouteProgress() {
  const screen = useScreen();
  const [run, setRun] = useState(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setRun((r) => r + 1);
  }, [screen]);
  if (run === 0) return null;
  return <div key={run} className="route-progress" aria-hidden="true" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Kept for API compatibility; MedSim's banded night/paper system has no
 *  global theme switch. */
export function ThemeToggle() {
  return null;
}

/** Shared reduced-motion check for JS-driven animation. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
