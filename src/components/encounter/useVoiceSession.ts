import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivePatient } from '../../game/types';
import { POLYCLINIC_BED_INDEX, store, useStore } from '../../game/store';
import type { ConversationStatus, SubtitleEvent } from '../../voice/conversation';
import type { ChatMessage } from '../../voice/claude';
import {
  disposePatientConversation,
  ensureAudioContext,
  getExistingConversation,
  getOrCreatePatientConversation,
} from '../../voice/conversationStore';

export interface VoiceSession {
  status: ConversationStatus;
  /** True once the user has asked to connect (until hang-up). */
  engaged: boolean;
  progress: string;
  error: string;
  patientLine: SubtitleEvent | null;
  doctorLine: SubtitleEvent | null;
  messages: ReadonlyArray<ChatMessage>;
  micMuted: boolean;
  connect: () => void;
  hangUp: () => void;
  toggle: () => void;
  toggleMic: () => void;
  sendText: (text: string) => Promise<boolean>;
}

const LIVE: ConversationStatus[] = ['ready', 'listening', 'thinking', 'speaking'];
export const isLive = (s: ConversationStatus) => LIVE.includes(s);

/** Owns the encounter's patient conversation. Voice never auto-starts:
 *  `connect()` must run inside a click/keydown so the browser lets the
 *  AudioContext + mic start (autoplay policy). */
export function useVoiceSession(patient: ActivePatient | null): VoiceSession {
  const [status, setStatus] = useState<ConversationStatus>('uninitialized');
  const [engaged, setEngaged] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [patientLine, setPatientLine] = useState<SubtitleEvent | null>(null);
  const [doctorLine, setDoctorLine] = useState<SubtitleEvent | null>(null);
  const [messages, setMessages] = useState<ReadonlyArray<ChatMessage>>([]);
  const [micMuted, setMicMuted] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  const caseId = patient?.case.id ?? null;
  const patientRef = useRef(patient);
  patientRef.current = patient;
  const micMutedRef = useRef(micMuted);
  micMutedRef.current = micMuted;

  const listenersRef = useRef({
    onStatus: (s: ConversationStatus) => setStatus(s),
    onProgress: (m: string) => setProgress(m),
    onSubtitle: (sub: SubtitleEvent) => {
      if (sub.who === 'patient') setPatientLine(sub);
      else setDoctorLine(sub);
    },
    onError: (e: string) => setError(e),
  });

  const reset = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    setStatus('uninitialized');
    setEngaged(false);
    setProgress('');
    setError('');
    setPatientLine(null);
    setDoctorLine(null);
    setMessages([]);
    setMicMuted(false);
  }, []);

  // New patient (or patient leaves) → tear down the previous conversation.
  useEffect(() => {
    reset();
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
      disposePatientConversation(POLYCLINIC_BED_INDEX);
    };
  }, [caseId, reset]);

  const connect = useCallback(() => {
    const p = patientRef.current;
    if (!p) return;
    try {
      ensureAudioContext();
    } catch {
      /* no Web Audio; init() will surface the error */
    }
    setError('');
    setEngaged(true);
    const conv = getOrCreatePatientConversation(POLYCLINIC_BED_INDEX, p.case, listenersRef.current, store.getState().lang);
    unsubRef.current?.();
    unsubRef.current = conv.subscribeMessages((m) => setMessages([...m]));
    // A reconnect (language switch, retry) must not unmute a muted doctor.
    conv.setMicMuted(micMutedRef.current);
    const current = conv.getStatus();
    setStatus(current);
    if (current === 'uninitialized') {
      conv.init().catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    }
  }, []);

  const hangUp = useCallback(() => {
    disposePatientConversation(POLYCLINIC_BED_INDEX);
    unsubRef.current?.();
    unsubRef.current = null;
    setStatus('uninitialized');
    setEngaged(false);
    setProgress('');
    setMicMuted(false);
  }, []);

  const toggle = useCallback(() => {
    const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
    if (conv && conv.getStatus() !== 'uninitialized' && conv.getStatus() !== 'error') hangUp();
    else {
      if (conv) disposePatientConversation(POLYCLINIC_BED_INDEX);
      connect();
    }
  }, [connect, hangUp]);

  // Language switched mid-call: drop the live conversation and reconnect with
  // the new persona, ASR/TTS locale and voice.
  const lang = useStore((s) => s.lang);
  const langRef = useRef(lang);
  useEffect(() => {
    if (langRef.current === lang) return;
    langRef.current = lang;
    const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
    if (!conv || conv.getStatus() === 'uninitialized' || conv.getStatus() === 'error') return;
    disposePatientConversation(POLYCLINIC_BED_INDEX);
    unsubRef.current?.();
    unsubRef.current = null;
    setPatientLine(null);
    setDoctorLine(null);
    connect();
  }, [lang, connect]);

  const toggleMic = useCallback(() => {
    const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
    if (!conv) return;
    const next = !micMutedRef.current;
    conv.setMicMuted(next);
    setMicMuted(next);
  }, []);

  const sendText = useCallback(async (text: string) => {
    const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
    if (!conv || !isLive(conv.getStatus())) return false;
    await conv.sendTextMessage(text);
    return true;
  }, []);

  return {
    status,
    engaged,
    progress,
    error,
    patientLine,
    doctorLine,
    messages,
    micMuted,
    connect,
    hangUp,
    toggle,
    toggleMic,
    sendText,
  };
}
