import type { CSSProperties, ReactNode } from 'react';

// In-world HUD styling. Follows the site design system (night surface,
// pixel bevel, Jersey 10 headings, amarna labels) via CSS variables with
// hard fallbacks, so it renders correctly before the global stylesheet.

export const UI = {
  bg: 'var(--bg, #0b1f4b)',
  surface: 'var(--surface, #112a60)',
  text: 'var(--text, #f3f1e2)',
  line: 'var(--line, #2b4c8a)',
  primary: 'var(--primary, #a8e27c)',
  amber: '#ffc46b',
  bevel: '0 0 0 2px var(--line, #2b4c8a), 4px 4px 0 0 #061431',
  heading: '"Jersey 10", "VT323", ui-monospace, monospace',
  label: '"amarna", "Inter", system-ui, sans-serif',
};

export const labelStyle: CSSProperties = {
  fontFamily: UI.label,
  textTransform: 'uppercase',
  fontWeight: 600,
  letterSpacing: '.14em',
  fontSize: 12,
};

export const panel: CSSProperties = {
  background: UI.surface,
  color: UI.text,
  border: `2px solid ${UI.line}`,
  borderRadius: 0,
  boxShadow: UI.bevel,
};

export function KeyCap({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        ...labelStyle,
        display: 'inline-block',
        minWidth: 22,
        padding: '2px 6px',
        marginRight: 8,
        background: UI.primary,
        color: '#0b1f4b',
        textAlign: 'center',
        boxShadow: '2px 2px 0 0 #061431',
        letterSpacing: '.06em',
      }}
    >
      {children}
    </span>
  );
}

export function PromptPill({ title, sub, tone = 'go' }: { title: ReactNode; sub?: ReactNode; tone?: 'go' | 'soon' }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...panel,
        position: 'absolute',
        left: '50%',
        bottom: 96,
        transform: 'translateX(-50%)',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <KeyCap>E</KeyCap>
      <span style={{ fontFamily: UI.heading, fontSize: 26, lineHeight: 1 }}>{title}</span>
      {sub && (
        <span style={{ ...labelStyle, marginLeft: 12, color: tone === 'go' ? UI.primary : UI.amber }}>{sub}</span>
      )}
    </div>
  );
}

export function Toast({ title, body }: { title: string; body: string }) {
  return (
    <div
      role="alert"
      style={{
        ...panel,
        position: 'absolute',
        top: 84,
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '14px 20px',
        maxWidth: 440,
        borderColor: UI.amber,
        boxShadow: `0 0 0 2px ${UI.amber}, 4px 4px 0 0 #061431`,
        pointerEvents: 'none',
        animation: 'medsim-toast-in .22s steps(4) both',
      }}
    >
      <div style={{ ...labelStyle, color: UI.amber, marginBottom: 6 }}>Coming soon</div>
      <div style={{ fontFamily: UI.heading, fontSize: 30, lineHeight: 1 }}>{title}</div>
      <div style={{ fontFamily: UI.label, fontSize: 14, marginTop: 6, opacity: 0.85 }}>{body}</div>
      <style>{'@keyframes medsim-toast-in{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}'}</style>
    </div>
  );
}

export function Fade({ opacity }: { opacity: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        background: '#050b1a',
        opacity,
        transition: 'opacity .6s ease',
        pointerEvents: opacity > 0.5 ? 'auto' : 'none',
        zIndex: 30,
      }}
    />
  );
}

export function MenuButton({ children, onClick, primary, autoFocus }: { children: ReactNode; onClick: () => void; primary?: boolean; autoFocus?: boolean }) {
  return (
    <button
      type="button"
      autoFocus={autoFocus}
      onClick={onClick}
      style={{
        ...labelStyle,
        fontSize: 13,
        width: '100%',
        padding: '12px 14px',
        border: `2px solid ${UI.line}`,
        borderRadius: 0,
        background: primary ? UI.primary : UI.bg,
        color: primary ? '#0b1f4b' : UI.text,
        boxShadow: '3px 3px 0 0 #061431',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      {children}
    </button>
  );
}

export function PauseMenu({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{ position: 'absolute', inset: 0, background: 'rgba(5,11,26,.55)', display: 'grid', placeItems: 'center', zIndex: 40 }}
    >
      <div style={{ ...panel, padding: 22, width: 320, display: 'grid', gap: 10 }}>
        <div style={{ fontFamily: UI.heading, fontSize: 36, lineHeight: 1, marginBottom: 6 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

export function ControlsCard({ seated }: { seated?: boolean }) {
  const row = (k: string, v: string) => (
    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 6 }}>
      <KeyCap>{k}</KeyCap>
      <span style={{ ...labelStyle, fontSize: 11, opacity: 0.9 }}>{v}</span>
    </div>
  );
  return (
    <div style={{ ...panel, padding: '10px 12px', pointerEvents: 'none' }}>
      <div style={{ ...labelStyle, color: UI.primary }}>Controls</div>
      {row('WASD', seated ? 'Stand up and walk' : 'Walk')}
      {row('Shift', 'Run')}
      {row('Mouse', 'Look around (click to capture, wheel: zoom)')}
      {row('E', 'Use door')}
      {row('Esc', 'Free cursor, again for menu')}
    </div>
  );
}
