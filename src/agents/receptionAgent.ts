// Client for POST /agent/reception/act (Priya at Reception). Triggered by the
// receptionist voice session's final transcripts and typed text (see
// voice/conversation.ts, caseId 'receptionist'). The open Reception panel
// registers a sink that logs the result and speaks the confirmation in
// Priya's Murf voice (/voice/speak when live, /voice/tts when voice is off).

import { getProfile } from '../game/profile';
import { store } from '../game/store';
import { getAssignmentView, localProgressSummary, openAssignment } from '../assignments/client';
import { looksLikeReceptionRequest } from '../assignments/core';
import { followDesk, openDeskRoom } from '../room/deskWatch';

export { looksLikeReceptionRequest };

export interface ReceptionStep {
  tool: string;
  ok: boolean;
  summary: string;
}

export interface ReceptionResult {
  runId: string;
  intent: 'action' | 'none';
  source: string;
  steps: ReceptionStep[];
  emailed: { ok: boolean; to?: string; via?: string; teacherName?: string; reason?: string } | null;
  /** A BAND side room to follow: faculty or Dr Iyer answers there. */
  desk?: Record<string, unknown> | null;
  spokenConfirmation: string;
}

export interface ReceptionSink {
  onStart?: (utterance: string, source: 'voice' | 'typed') => void;
  onResult: (res: ReceptionResult, source: 'voice' | 'typed') => void;
  onError?: (message: string) => void;
}

let sink: ReceptionSink | null = null;
let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

export function setReceptionSink(s: ReceptionSink | null): void {
  sink = s;
  if (!s) history = [];
}

export async function runReceptionAction(utterance: string, source: 'voice' | 'typed'): Promise<ReceptionResult | null> {
  const clean = utterance.trim();
  if (!clean) return null;
  sink?.onStart?.(clean, source);
  const view = getAssignmentView();
  const p = getProfile();
  try {
    const r = await fetch('/agent/reception/act', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        utterance: clean.slice(0, 600),
        profile: { name: p?.name ?? '', university: p?.university ?? '' },
        assignmentCode: view.code,
        knownCodes: view.known,
        localProgress: localProgressSummary(),
        lang: store.getState().lang,
        history: history.slice(-6),
        deskRoom: openDeskRoom(),
      }),
    });
    if (!r.ok) throw new Error(`Reception desk unavailable (${r.status})`);
    const res = (await r.json()) as ReceptionResult;
    history = [...history, { role: 'user' as const, content: clean }, { role: 'assistant' as const, content: res.spokenConfirmation }].slice(-8);
    if (res.emailed?.ok && view.code) void openAssignment(view.code);
    followDesk(res.desk);
    sink?.onResult(res, source);
    return res;
  } catch (e) {
    sink?.onError?.(e instanceof Error ? e.message : String(e));
    return null;
  }
}
