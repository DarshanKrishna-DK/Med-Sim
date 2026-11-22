// The theatre room's state as the server streams it (backend/agentroom/theatre.py),
// turned into events for the drill engine and into words for the strip. Pure.

import type { BloodRequest, OTState, TheatreEvent } from './engine.ts';
import type { SideState } from '../room/types';

export interface TheatreBlood {
  n: number;
  status: 'waiting' | 'sample' | 'matching' | 'released' | 'emergency' | 'incompatible' | 'unavailable' | 'no_reply';
  group: string;
  units: string[];
  text: string;
}

export interface TheatreSide {
  blood: TheatreBlood | null;
  rx: { status: string; text: string } | null;
  help: { status: string; name: string; text: string; n: number } | null;
  url: string;
}

const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.slice(0, max) : '');
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const BLOOD = new Set(['waiting', 'sample', 'matching', 'released', 'emergency', 'incompatible', 'unavailable', 'no_reply']);

/** What we understand of a side state. Anything malformed is left out. */
export function parseSide(side: SideState | null | undefined): TheatreSide {
  const b = rec(side?.blood);
  const r = rec(side?.rx);
  const h = rec(side?.help);
  return {
    blood:
      b && typeof b.n === 'number' && BLOOD.has(str(b.status))
        ? {
            n: b.n,
            status: b.status as TheatreBlood['status'],
            group: str(b.group, 30),
            units: Array.isArray(b.units) ? b.units.map((u) => str(rec(u)?.unit, 20)).filter(Boolean).slice(0, 4) : [],
            text: str(b.text),
          }
        : null,
    rx: r && str(r.status) ? { status: str(r.status), text: str(r.text) } : null,
    help: h && str(h.status) ? { status: str(h.status), name: str(h.name, 60), text: str(h.text), n: typeof h.n === 'number' ? h.n : 0 } : null,
    url: str(side?.url),
  };
}

/** The engine events that lead from one room state to the next. */
export function eventsBetween(prev: TheatreSide | null, next: TheatreSide): TheatreEvent[] {
  const out: TheatreEvent[] = [];
  const b = next.blood;
  if (b && (prev?.blood?.n !== b.n || prev.blood.status !== b.status)) {
    const base = { kind: 'blood' as const, n: b.n, group: b.group, units: b.units, text: b.text };
    if (b.status === 'sample' || b.status === 'matching' || b.status === 'released') out.push({ ...base, status: b.status });
    else if (b.status === 'emergency') out.push({ ...base, status: 'recorded' });
    else if (b.status === 'incompatible' || b.status === 'unavailable') out.push({ ...base, status: 'refused' });
    // waiting and no_reply change nothing: the drill's own clock decides when to go on.
  }
  const r = next.rx;
  if (r && prev?.rx?.status !== r.status && (r.status === 'release' || r.status === 'hold' || r.status === 'clarify' || r.status === 'no_reply')) {
    out.push({ kind: 'rx', verdict: r.status, text: r.text });
  }
  const h = next.help;
  if (h && (prev?.help?.status !== h.status || prev.help.n !== h.n) && (h.status === 'called' || h.status === 'unreachable' || h.status === 'replied')) {
    out.push({ kind: 'help', status: h.status, name: h.name, text: h.text });
  }
  return out;
}

const BLOOD_WORD: Record<BloodRequest['status'], string> = {
  waiting: 'Waiting for Lab cross-match',
  sample: 'Lab wants a labelled sample',
  matching: 'Sample with the lab, cross-matching',
  released: 'Released by the lab',
  refused: 'Not released by the lab',
  unconfirmed: 'Issued without cross-match confirmation',
  emergency: 'Emergency O negative, no cross-match',
};

/** One line about the blood, with the seconds left before the fallback. */
export function bloodLine(s: OTState, waitS: number): { text: string; left: number | null; tone: 'wait' | 'good' | 'warn' } | null {
  const b = s.blood;
  if (!b) return null;
  const open = b.status === 'waiting' || b.status === 'sample' || b.status === 'matching';
  const detail = b.status === 'released' && b.group ? ` (patient ${b.group})` : '';
  return {
    text: BLOOD_WORD[b.status] + detail,
    left: open ? Math.max(0, Math.ceil(waitS - (s.t - b.waitFrom))) : null,
    tone: open ? 'wait' : b.status === 'released' ? 'good' : 'warn',
  };
}

/** The pharmacist's word for the checklist card. */
export function rxLine(s: OTState): { text: string; tone: 'wait' | 'good' | 'warn' } | null {
  switch (s.rx.status) {
    case 'none':
      return null;
    case 'waiting':
      return { text: 'Pharmacy is checking the antibiotic against the allergy. Sign-in waits for the answer.', tone: 'wait' };
    case 'release':
      return { text: s.rx.text || 'The antibiotic can be given.', tone: 'good' };
    case 'hold':
    case 'clarify':
      return { text: s.rx.text || 'Not cleared by pharmacy.', tone: 'warn' };
    case 'unconfirmed':
      return { text: s.rx.text, tone: 'warn' };
  }
}
