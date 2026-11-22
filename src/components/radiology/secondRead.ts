// The second read of a report as the server streams it (backend/agentroom/reads.py).
// Pure: parsing and wording only, so the Node tests can load it.

import type { SideState } from '../../room/types';

export interface ChainStep {
  at: string;
  who: 'nurse' | 'radiology';
  what: string;
}

export interface SecondRead {
  status: 'waiting' | 'no_reply' | 'agree' | 'discrepancy' | 'calling' | 'acknowledged' | 'closed';
  final: boolean;
  url: string;
  chain: ChainStep[];
  read: {
    outcome: 'agree' | 'discrepancy';
    by: string;
    missed: Array<{ label: string; critical: boolean }>;
    diagnosisAgrees: boolean;
    diagnosis: string;
    spoken: string;
  } | null;
}

const STATUSES = new Set(['waiting', 'no_reply', 'agree', 'discrepancy', 'calling', 'acknowledged', 'closed']);
const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.slice(0, max) : '');
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Null until the room has something to say. */
export function parseSecondRead(side: SideState | null | undefined): SecondRead | null {
  if (!side || !STATUSES.has(side.status)) return null;
  const r = rec(side.read);
  const outcome = str(r?.outcome);
  return {
    status: side.status as SecondRead['status'],
    final: side.final === true,
    url: str(side.url, 200),
    chain: (Array.isArray(side.chain) ? side.chain : [])
      .map(rec)
      .filter((c): c is Record<string, unknown> => !!c && (c.who === 'nurse' || c.who === 'radiology') && !!str(c.what))
      .map((c) => ({ at: str(c.at, 40), who: c.who as ChainStep['who'], what: str(c.what) }))
      .slice(-12),
    read:
      r && (outcome === 'agree' || outcome === 'discrepancy')
        ? {
            outcome,
            by: str(r.by, 60) || 'Radiologist Vikram',
            missed: (Array.isArray(r.missed) ? r.missed : [])
              .map(rec)
              .filter((m): m is Record<string, unknown> => !!m && !!str(m.label))
              .map((m) => ({ label: str(m.label, 200), critical: m.critical === true }))
              .slice(0, 8),
            diagnosisAgrees: r.diagnosisAgrees === true,
            diagnosis: str(r.diagnosis, 160),
            spoken: str(r.spoken, 400),
          }
        : null,
  };
}

/** Headline of the card. Nothing is called agreed, signed or communicated before somebody said so. */
export function headline(s: SecondRead): { text: string; tone: 'wait' | 'good' | 'bad' } {
  switch (s.status) {
    case 'waiting':
      return { text: 'Radiologist Vikram is reading the film', tone: 'wait' };
    case 'no_reply':
      return { text: 'No second read yet: radiology has not replied', tone: 'wait' };
    case 'agree':
      return { text: 'Second read agrees', tone: 'good' };
    case 'discrepancy':
      return { text: 'Second read differs', tone: 'bad' };
    case 'calling':
      return { text: 'Critical finding being called to the ward', tone: 'bad' };
    case 'acknowledged':
      return { text: 'Critical finding read back, waiting for confirmation', tone: 'bad' };
    case 'closed':
      return { text: 'Critical finding communicated, loop closed', tone: 'bad' };
  }
}

export const stepTime = (at: string): string => {
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
};
