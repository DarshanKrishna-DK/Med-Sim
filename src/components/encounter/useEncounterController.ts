import { useEffect, useState } from 'react';
import { store, useStore, POLYCLINIC_BED_INDEX } from '../../game/store';
import type { ActivePatient } from '../../game/types';
import { getExistingConversation, disposePatientConversation } from '../../voice/conversationStore';
import { interactionBus } from '../three/interactions';
import { useVoiceSession, type VoiceSession } from './useVoiceSession';

function useElapsed(since: number | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (!since) return '0:00';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** Farewell can hang if the voice backend dies; never block ending on it. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => window.setTimeout(() => r(undefined), ms))]);
}

export interface EncounterController {
  patient: ActivePatient | null;
  voice: VoiceSession;
  elapsed: string;
  pointerLocked: boolean;
  ending: boolean;
  confirmEnd: boolean;
  setConfirmEnd: (v: boolean) => void;
  endConsultation: () => Promise<void>;
}

/** Everything the encounter needs except the 3D canvas: the voice session,
 *  timer, pointer-lock state, T-to-talk, and the end-consultation flow.
 *  Any 3D scene can host it: pass `voice.toggle` to the scene's talk key
 *  and render <EncounterHud ctl={ctl} /> on top of the canvas. */
export function useEncounterController(): EncounterController {
  const patient = useStore((s) => s.polyclinic.patient);
  const selectedCaseId = useStore((s) => s.selectedCaseId);
  const voice = useVoiceSession(patient);
  const elapsed = useElapsed(patient?.arrivedAt);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [ending, setEnding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  // Arriving without a seated patient (e.g. deep link) → seat the selected case.
  useEffect(() => {
    if (!store.getState().polyclinic.patient) store.loadPolyclinicPatient(selectedCaseId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onChange = () => setPointerLocked(!!document.pointerLockElement);
    document.addEventListener('pointerlockchange', onChange);
    return () => {
      document.removeEventListener('pointerlockchange', onChange);
      if (document.pointerLockElement) document.exitPointerLock();
    };
  }, []);

  // T toggles voice. While pointer-locked the Player handles T itself
  // (and calls onTalk), so skip here to avoid a double toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 't' && e.key !== 'T') return;
      if (e.repeat || isTyping(e.target) || document.pointerLockElement || ending) return;
      e.preventDefault();
      voice.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [voice, ending]);

  const endConsultation = async () => {
    if (ending) return;
    setConfirmEnd(false);
    setEnding(true);
    if (document.pointerLockElement) document.exitPointerLock();
    interactionBus.setActive(null);
    const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
    if (conv && conv.getStatus() !== 'uninitialized' && conv.getStatus() !== 'error') {
      try {
        await withTimeout(conv.sayFarewell(), 15000);
      } catch {
        /* voice failure, finish anyway */
      }
    }
    store.finishPolyclinicCase();
    disposePatientConversation(POLYCLINIC_BED_INDEX);
    store.setScreen('debrief');
  };


  return { patient, voice, elapsed, pointerLocked, ending, confirmEnd, setConfirmEnd, endConsultation };
}
