import { useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ThinkingOrb } from 'thinking-orbs';
import { MedicineTrayArt } from '../ui/pixel/MedArt';
import type { NurseRun, NurseStep } from '../../agents/nurseAgent';
import { prefersReducedMotion } from '../ui/chrome';

function formatValue(v: unknown): string {
  if (typeof v === 'string') return `"${v.length > 40 ? v.slice(0, 39) + '…' : v}"`;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`;
  try {
    const s = JSON.stringify(v);
    return s.length > 48 ? s.slice(0, 47) + '…' : s;
  } catch {
    return '…';
  }
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args ?? {})
    .map(([k, v]) => `${k}: ${formatValue(v)}`)
    .join(', ');
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

type Link = { label: string; href: string };

/** Evidence links for the real-world tools: drug database sources, the FHIR
 *  records, the calendar invite and the voice note that went to the phone. */
function stepLinks(step: NurseStep): Link[] {
  const r = (step.result ?? {}) as Record<string, any>;
  const out: Link[] = [];
  const add = (label: string, href: unknown) => {
    if (typeof href === 'string' && /^(https?:\/\/|\/rx\/)/.test(href)) out.push({ label, href });
  };
  if (step.tool === 'check_allergies_and_interactions' && r.realCheck?.ok) {
    for (const s of (r.realCheck.sources ?? []) as Array<{ name?: string; url?: string }>) add(s.name ?? 'Source', s.url);
  }
  if (step.tool === 'schedule_follow_up' && r.calendar) {
    add('Add to Google Calendar', r.calendar.googleCalendarUrl);
    add('Download .ics', r.calendar.icsUrl);
  }
  if (step.tool === 'record_to_ehr') {
    for (const rec of (r.records ?? []) as Array<{ resourceType?: string; id?: string; url?: string }>) add(`FHIR ${rec.resourceType}/${rec.id}`, rec.url);
  }
  if (step.tool === 'send_to_patient') add('Murf voice note', r.audioUrl);
  return out;
}

function StepLinks({ step }: { step: NurseStep }) {
  const links = stepLinks(step);
  const r = (step.result ?? {}) as Record<string, any>;
  const classes: string[] = step.tool === 'check_allergies_and_interactions' && r.realCheck?.ok ? r.realCheck.classes ?? [] : [];
  if (!links.length && !classes.length) return null;
  return (
    <p className="step-links">
      {classes.length > 0 && <span className="step-tag">NIH class: {classes.slice(0, 2).join(', ')}</span>}
      {links.map((l) => (
        <a key={l.href} href={l.href} target="_blank" rel="noreferrer noopener" className="step-link">
          {l.label}
        </a>
      ))}
    </p>
  );
}

function Step({ step }: { step: NurseStep }) {
  return (
    <li className={`step ${step.ok ? 'step--ok' : 'step--fail'}`} data-step>
      <span className="step-mark" aria-hidden="true">
        {step.ok ? (
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="m2.5 6.2 2.4 2.4 4.6-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        )}
      </span>
      <div className="step-body">
        <code className="step-call">
          <span className="step-tool">{step.tool}</span>
          <span className="step-args">({formatArgs(step.args)})</span>
        </code>
        <p className="step-summary">
          <span className="sr-only">{step.ok ? 'Succeeded: ' : 'Failed: '}</span>
          {step.summary}
        </p>
        <StepLinks step={step} />
      </div>
    </li>
  );
}

export function RunCard({ run }: { run: NurseRun }) {
  const ref = useRef<HTMLLIElement>(null);
  const seen = useRef(0);

  // Animate each newly-arrived step: it slides in from the trace line,
  // so the eye follows the agent's work in order. Explains causality;
  // skipped under reduced motion.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const steps = Array.from(el.querySelectorAll<HTMLElement>('[data-step]'));
    const fresh = steps.slice(seen.current);
    seen.current = steps.length;
    if (fresh.length === 0 || prefersReducedMotion()) return;
    const tween = gsap.fromTo(
      fresh,
      { opacity: 0, x: -8 },
      { opacity: 1, x: 0, duration: 0.32, ease: 'power3.out', stagger: 0.12, clearProps: 'transform,opacity' },
    );
    return () => {
      // Jump to the end state (which clears the inline styles) so a
      // StrictMode re-run or unmount never leaves a step invisible.
      tween.progress(1).kill();
    };
  }, [run.steps.length]);

  const elapsed = run.finishedAt ? ((run.finishedAt - run.startedAt) / 1000).toFixed(1) : null;

  return (
    <li ref={ref} className={`run run--${run.status}`}>
      <div className="run-head">
        <span className="run-source" title={run.source === 'voice' ? 'Spoken order' : 'Typed order'}>
          {run.source === 'voice' ? (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="4.5" y="1.5" width="5" height="7.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M2.5 7a4.5 4.5 0 0 0 9 0M7 11.5V13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1" y="3" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M3.5 5.5h1M6.5 5.5h1M9.5 5.5h1M4 8.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
          )}
          <span className="sr-only">{run.source === 'voice' ? 'You said' : 'You typed'}</span>
        </span>
        <q className="run-utterance">{run.utterance}</q>
        <time className="run-time" dateTime={new Date(run.startedAt).toISOString()}>
          {clock(run.startedAt)}
        </time>
      </div>

      {run.plan && <p className="run-plan">{run.plan}</p>}

      {run.steps.length > 0 && (
        <ol className="trace" aria-label="Tool calls">
          {run.steps.map((s, i) => (
            <Step key={i} step={s} />
          ))}
        </ol>
      )}

      {run.status === 'running' && (
        <div className="run-working" role="status">
          <ThinkingOrb state="working" size={20} theme="dark" aria-label="Nurse is working" />
          <span>{run.steps.length === 0 ? 'Reading the order…' : 'Working…'}</span>
        </div>
      )}

      {run.spokenConfirmation && (
        <p className="run-say">
          <span className="run-say-who">Nurse</span>
          <span>“{run.spokenConfirmation}”</span>
        </p>
      )}

      {run.status === 'error' && run.error && (
        <p className="run-error" role="alert">{run.error}</p>
      )}

      {elapsed && run.status !== 'running' && (
        <p className="run-foot">
          {run.steps.length} tool {run.steps.length === 1 ? 'call' : 'calls'}
          {run.steps.some((s) => !s.ok) ? `, ${run.steps.filter((s) => !s.ok).length} refused` : ''} in {elapsed} s
        </p>
      )}
    </li>
  );
}

/** Runs the agent classified as "not an order" (intent 'none') are hidden. */
export function visibleRuns(runs: NurseRun[]): NurseRun[] {
  return runs.filter((r) => r.intent !== 'none');
}

export function NurseFeed({ runs: allRuns }: { runs: NurseRun[] }) {
  const runs = visibleRuns(allRuns);
  if (runs.length === 0) {
    return (
      <div className="feed-empty">
        <div className="feed-empty-figure">
          <MedicineTrayArt />
        </div>
        <p className="empty-title">No orders yet</p>
        <p className="empty-body">
          Say an order out loud (“Let's do a full blood count and an ECG”) or type it below. Each
          tool the nurse calls appears here as it happens.
        </p>
      </div>
    );
  }
  // Newest first: the run you just gave is always at the top.
  const ordered = [...runs].reverse();
  return (
    <ol className="feed" aria-label="Nurse agent actions" aria-live="polite">
      {ordered.map((r) => (
        <RunCard key={r.id} run={r} />
      ))}
    </ol>
  );
}
