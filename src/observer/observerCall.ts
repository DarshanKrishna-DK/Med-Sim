/**
 * "Invite Darshan to observe": Asha mints the observer link for the live call,
 * sends it to the contact and phones them (POST /agent/observer/call, Twilio
 * on the backend). The doctor sees the call status and what the observer
 * asked, polled from GET /agent/observer/call/{token}; messages the observer
 * leaves arrive as toasts.
 */

import { useSyncExternalStore } from 'react';
import { CLINIC_LABELS } from '../game/clinic';
import { getProfile } from '../game/profile';
import { POLYCLINIC_BED_INDEX, store } from '../game/store';
import { speakAsNurse } from '../agents/nurseAgent';
import { getExistingConversation } from '../voice/conversationStore';
import { findContact, getContacts, parseInviteCommand, type ObserverContact } from './contacts';
import { getLinkState, inviteObserver, pushObserverMessage } from './studentLink';

const LOG = '[medsim:observer-call]';
const POLL_MS = 2000;
const POLL_MAX_MS = 15 * 60 * 1000;

export type CallStatus =
  | 'idle'
  | 'inviting'
  | 'placing'
  | 'preparing'
  | 'queued'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'busy'
  | 'no-answer'
  | 'failed'
  | 'canceled'
  | 'error';

export interface CallLine {
  who: 'observer' | 'asha';
  text: string;
  at: number;
}

export interface CallMessage {
  id: number;
  from: string;
  text: string;
  at: number;
}

export interface ObserverCallState {
  status: CallStatus;
  token: string;
  contactName: string;
  deliveryChannel: string;
  deliveryOk: boolean;
  error: string;
  transcript: CallLine[];
  messages: CallMessage[];
}

const IDLE: ObserverCallState = {
  status: 'idle',
  token: '',
  contactName: '',
  deliveryChannel: '',
  deliveryOk: false,
  error: '',
  transcript: [],
  messages: [],
};

const TERMINAL = new Set<CallStatus>(['completed', 'busy', 'no-answer', 'failed', 'canceled', 'error', 'idle']);
export const isCallBusy = (s: CallStatus) => !TERMINAL.has(s);

let state: ObserverCallState = IDLE;
const listeners = new Set<() => void>();

function setCall(patch: Partial<ObserverCallState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const getCallState = () => state;
export const useObserverCall = () => useSyncExternalStore(subscribe, getCallState);

export function clearObserverCall() {
  if (isCallBusy(state.status)) return;
  stopPolling();
  setCall(IDLE);
}

// ── "open the popover on the add-contact form" signal ───────────

export interface PopoverRequest {
  seq: number;
  prefillName: string;
}
let popover: PopoverRequest = { seq: 0, prefillName: '' };
const popListeners = new Set<() => void>();
export function requestObserverPopover(prefillName = '') {
  popover = { seq: popover.seq + 1, prefillName };
  for (const l of popListeners) l();
}
const subscribePop = (l: () => void) => {
  popListeners.add(l);
  return () => popListeners.delete(l);
};
const getPop = () => popover;
export const usePopoverRequest = () => useSyncExternalStore(subscribePop, getPop);

// ── polling ─────────────────────────────────────────────────────

let pollTimer: number | null = null;
let seenMessages = 0;

function stopPolling() {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = null;
}

interface CallSnapshot {
  token: string;
  status: CallStatus;
  contact: { name: string };
  delivery: { ok: boolean; channel: string; error: string };
  error: string;
  transcript: CallLine[];
  messages: CallMessage[];
  spoken?: string;
}

function applySnapshot(s: CallSnapshot) {
  for (const m of s.messages) {
    if (m.id > seenMessages) {
      seenMessages = m.id;
      pushObserverMessage(`obs-call-${s.token}-${m.id}`, m.from, m.text);
    }
  }
  setCall({
    status: s.status,
    token: s.token,
    contactName: s.contact.name,
    deliveryChannel: s.delivery.channel,
    deliveryOk: s.delivery.ok,
    error: s.error || (s.delivery.ok ? '' : s.delivery.error),
    transcript: s.transcript,
    messages: s.messages,
  });
}

function startPolling(token: string) {
  stopPolling();
  const started = Date.now();
  let finalPolls = 0;
  pollTimer = window.setInterval(async () => {
    if (state.token !== token || Date.now() - started > POLL_MAX_MS) return stopPolling();
    try {
      const r = await fetch(`/agent/observer/call/${encodeURIComponent(token)}`);
      if (!r.ok) return stopPolling();
      const snap = (await r.json()) as CallSnapshot;
      if (state.token !== token) return;
      applySnapshot(snap);
      // A message can land just after hang-up: poll a few more times.
      if (TERMINAL.has(snap.status) && ++finalPolls > 3) stopPolling();
    } catch (err) {
      console.warn(LOG, 'poll failed:', err);
    }
  }, POLL_MS);
}

// ── main flow ───────────────────────────────────────────────────

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}

function titleCase(s: string) {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// ── Asha's feed: the invite shows as an agent run with tool steps ─────────

type Step = { tool: string; args: Record<string, unknown>; ok: boolean; summary: string; result?: unknown };

function startRun(utterance: string, caseId: string) {
  const id = `obs-${Date.now().toString(36)}`;
  const steps: Step[] = [];
  store.pushAgentRun({ id, caseId, utterance, source: 'voice', status: 'running', startedAt: Date.now(), steps: [] });
  return {
    step(st: Step) {
      steps.push(st);
      store.updateAgentRun(id, { steps: [...steps] });
    },
    finish(ok: boolean, spoken: string) {
      store.updateAgentRun(id, {
        status: ok ? 'done' : 'error',
        intent: 'order',
        plan: 'Invite an observer: find the contact, create the Agora link, send it and phone them.',
        steps: [...steps],
        spokenConfirmation: spoken,
        ...(ok ? {} : { error: spoken }),
        finishedAt: Date.now(),
      });
    },
  };
}

/** Mint (or reuse) the observer link, send it, and have Asha phone `contact`. */
export async function callObserver(contact: ObserverContact, note = '', utterance = ''): Promise<void> {
  if (isCallBusy(state.status)) {
    void speakAsNurse(`I'm still on the call with ${state.contactName ? firstName(state.contactName) : 'them'}, doctor.`);
    return;
  }
  const s = store.getState();
  const patient = s.polyclinic.patient;
  const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
  const info = conv?.getSessionInfo();
  stopPolling();
  seenMessages = 0;
  if (!patient || !conv || !info) {
    setCall({ ...IDLE, status: 'error', contactName: contact.name, error: 'Start voice first (press T): the observer listens to the live call.' });
    void speakAsNurse(`Start voice first, doctor. Press T, then ask me again to invite ${firstName(contact.name)}.`);
    return;
  }
  setCall({ ...IDLE, status: 'inviting', contactName: contact.name });
  const run = startRun(utterance || `Invite ${contact.name} to observe`, patient.case.id);
  run.step({
    tool: 'find_contact',
    args: { name: contact.name },
    ok: true,
    summary: `${contact.name} (${contact.relation})${contact.telegram ? ', Telegram on file' : ''}`,
  });

  let link = getLinkState();
  const reusable = link.status === 'live' && link.caseId === patient.case.id && link.channel === info.channel;
  if (!reusable) {
    await inviteObserver();
    link = getLinkState();
  }
  if (link.status !== 'live' || !link.inviteUrl) {
    setCall({ status: 'error', error: link.error || 'Could not create the observer link.' });
    run.step({ tool: 'create_observer_link', args: { channel: info.channel }, ok: false, summary: link.error || 'Could not create the observer link' });
    run.finish(false, "Sorry doctor, I couldn't create the observer link.");
    void speakAsNurse("Sorry doctor, I couldn't create the observer link.");
    return;
  }
  run.step({
    tool: 'create_observer_link',
    args: { channel: info.channel },
    ok: true,
    summary: reusable ? 'Reused the live Agora observer link (listen-only)' : 'Agora observer link created (listen-only audience)',
  });

  setCall({ status: 'placing' });
  const profile = getProfile();
  const clinic = s.polyclinic.clinic;
  try {
    const r = await fetch('/agent/observer/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact: { name: contact.name, relation: contact.relation, phone: contact.phone, telegram: contact.telegram || null },
        inviteUrl: link.inviteUrl,
        student: { name: profile?.name ?? '', university: profile?.university ?? '', gender: profile?.gender ?? '' },
        case: {
          specialty: clinic,
          specialtyLabel: CLINIC_LABELS[clinic] ?? clinic,
          chiefComplaint: patient.case.chiefComplaint,
          caseId: patient.case.id,
        },
        available: false,
        ...(note ? { note } : {}),
      }),
    });
    if (!r.ok) {
      let detail = '';
      try { detail = ((await r.json()) as { detail?: string }).detail ?? ''; } catch { /* non-JSON */ }
      throw new Error(typeof detail === 'string' && detail ? detail : `Call failed (${r.status})`);
    }
    const snap = (await r.json()) as CallSnapshot;
    applySnapshot(snap);
    const d = (snap as unknown as { delivery?: { ok?: boolean; channel?: string; error?: string } }).delivery;
    run.step({
      tool: 'send_invite',
      args: { channel: d?.channel || 'auto' },
      ok: !!d?.ok,
      summary: d?.ok ? `Invite link sent on ${d.channel}` : `Link not sent${d?.error ? `: ${d.error}` : ''}`,
    });
    const called = !TERMINAL.has(snap.status) || snap.status === 'completed';
    run.step({
      tool: 'place_call',
      args: { to: (snap as unknown as { contact?: { phone?: string } }).contact?.phone ?? contact.phone, via: 'Twilio' },
      ok: called,
      summary: called ? `Calling ${firstName(contact.name)}: Asha speaks in her Murf voice and answers questions` : `Call not placed${(snap as unknown as { error?: string }).error ? `: ${(snap as unknown as { error?: string }).error}` : ''}`,
    });
    run.finish(called || !!d?.ok, snap.spoken || `Calling ${firstName(contact.name)} now.`);
    if (snap.spoken) void speakAsNurse(snap.spoken);
    if (!TERMINAL.has(snap.status)) startPolling(snap.token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(LOG, 'call failed:', msg);
    setCall({ status: 'error', error: msg });
    run.step({ tool: 'place_call', args: { via: 'Twilio' }, ok: false, summary: msg });
    run.finish(false, `Sorry doctor, I couldn't call ${firstName(contact.name)}.`);
    void speakAsNurse(`Sorry doctor, I couldn't call ${firstName(contact.name)}.`);
  }
}

/**
 * Voice or typed line from the doctor. True when it was an observer request
 * ("invite Darshan to observe", "Asha, call Darshan to watch") and has been
 * handled, so the caller skips the nurse / exam agents.
 */
export function maybeHandleObserverCommand(text: string): boolean {
  const cmd = parseInviteCommand(text);
  if (!cmd || !store.getState().polyclinic.patient) return false;
  const contact = findContact(cmd.name, getContacts());
  if (!contact && !cmd.explicit) return false;
  if (!contact) {
    const name = titleCase(cmd.name);
    void speakAsNurse(`I don't have ${name} in your contacts yet. Add their number and I'll call.`);
    requestObserverPopover(name);
    return true;
  }
  void callObserver(contact, '', text.trim());
  return true;
}
