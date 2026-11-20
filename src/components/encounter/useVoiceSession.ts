import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivePatient } from '../../game/types';
import { POLYCLINIC_BED_INDEX } from '../../game/store';
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
    const conv = getOrCreatePatientConversation(POLYCLINIC_BED_INDEX, p.case, listenersRef.current);
    unsubRef.current?.();
    unsubRef.current = conv.subscribeMessages((m) => setMessages([...m]));
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

  const toggleMic = useCallback(() => {
    const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
    if (!conv) return;
    setMicMuted((m) => {
      conv.setMicMuted(!m);
      return !m;
    });
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
