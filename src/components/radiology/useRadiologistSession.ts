import { useCallback, useEffect, useRef, useState } from 'react';
import { Conversation, type ConversationStatus, type SubtitleEvent } from '../../voice/conversation';
import { ensureAudioContext } from '../../voice/conversationStore';
import {
  RADIOLOGIST,
  radiologistGreeting,
  buildRadiologistCasePrompt,
  buildRadiologistPersona,
} from '../../voice/radiologistPersona';
import { radiologistBack } from '../../voice/lines';
import { estimateSpeechMs } from '../teach/lesson';
import type { RadCase } from '../../data/radiology';
import { store, useStore } from '../../game/store';
import { LANG_LOCALE } from '../../game/lang';

// The reading room's consultant voice. Same stack as the teacher: a
// Conversation (POST /voice/start with caseId 'radiologist'), /voice/context
// to ground it in the film on the screen, /voice/speak for scripted lines.
// With voice off, the screen asks POST /agent/radiology/probe instead and
// the reply is captioned here with a simulated mouth.

export interface RadLine {
  id: number;
  who: 'consultant' | 'you';
  text: string;
}

const LIVE: ConversationStatus[] = ['ready', 'listening', 'thinking', 'speaking'];
let lineId = 0;

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
  return (await r.json()) as T;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function useRadiologistSession(opts: { onStudentFinal: (text: string) => void }) {
  const [status, setStatus] = useState<ConversationStatus>('uninitialized');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [caption, setCaption] = useState<string>(() => radiologistGreeting(store.getState().lang));
  const [log, setLog] = useState<RadLine[]>([]);
  const [micMuted, setMicMuted] = useState(false);

  const convRef = useRef<Conversation | null>(null);
  const promptRef = useRef(buildRadiologistPersona(store.getState().lang));
  const caseRef = useRef<RadCase | null>(null);
  const localSpeechUntil = useRef(0);
  const lastSpoken = useRef({ text: '', at: 0 });
  const typedEcho = useRef<string | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const pushLine = useCallback((who: RadLine['who'], text: string) => {
    setLog((l) => [...l.slice(-40), { id: ++lineId, who, text }]);
  }, []);

  const isLive = useCallback(() => {
    const c = convRef.current;
    return !!c && LIVE.includes(c.getStatus()) && !!c.getAgentId();
  }, []);

  const listeners = useRef({
    onStatus: (s: ConversationStatus) => setStatus(s),
    onProgress: (m: string) => setProgress(m),
    onError: (e: string) => setError(e),
    onSubtitle: (sub: SubtitleEvent) => {
      if (sub.who === 'patient') {
        if (sub.text === '…') return;
        setCaption(sub.text);
        if (!sub.partial) pushLine('consultant', sub.text);
        return;
      }
      if (sub.partial) return;
      if (typedEcho.current !== null && norm(sub.text) === typedEcho.current) {
        typedEcho.current = null;
        return; // typed path already logged it
      }
      pushLine('you', sub.text);
      optsRef.current.onStudentFinal(sub.text);
    },
  });

  const connect = useCallback(() => {
    if (convRef.current && convRef.current.getStatus() !== 'error') return;
    convRef.current?.dispose();
    let ctx: AudioContext;
    try {
      ctx = ensureAudioContext();
    } catch {
      setError('This browser has no Web Audio support.');
      return;
    }
    setError('');
    const c = caseRef.current;
    const { lang } = store.getState();
    const greeting = c ? radiologistBack(lang, c.study) : radiologistGreeting(lang);
    const conv = new Conversation(ctx, listeners.current, {
      systemPrompt: promptRef.current,
      initialMessage: { role: 'assistant', content: greeting },
      voiceGender: RADIOLOGIST.gender,
      caseId: RADIOLOGIST.caseId,
      locale: LANG_LOCALE[store.getState().lang],
    });
    convRef.current = conv;
    setStatus('loading');
    conv.init().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const hangUp = useCallback(() => {
    convRef.current?.dispose();
    convRef.current = null;
    setStatus('uninitialized');
    setProgress('');
    setMicMuted(false);
  }, []);

  // Language switched mid-call: rebuild the prompt and reconnect.
  const lang = useStore((s) => s.lang);
  const langRef = useRef(lang);
  useEffect(() => {
    if (langRef.current === lang) return;
    langRef.current = lang;
    const c = caseRef.current;
    promptRef.current = c ? buildRadiologistCasePrompt(c, lang) : buildRadiologistPersona(lang);
    const conv = convRef.current;
    if (!conv || conv.getStatus() === 'uninitialized' || conv.getStatus() === 'error') return;
    conv.dispose();
    convRef.current = null;
    connect();
  }, [lang, connect]);

  const toggle = useCallback(() => {
    const c = convRef.current;
    if (c && c.getStatus() !== 'uninitialized' && c.getStatus() !== 'error') hangUp();
    else connect();
  }, [connect, hangUp]);

  const toggleMic = useCallback(() => {
    const c = convRef.current;
    if (!c) return;
    setMicMuted((m) => {
      c.setMicMuted(!m);
      return !m;
    });
  }, []);

  /** Consultant says a line: by the live agent, or captioned locally. */
  const speak = useCallback(
    (text: string, o?: { log?: boolean }) => {
      const clean = text.trim();
      if (!clean) return;
      const now = performance.now();
      if (lastSpoken.current.text === clean && now - lastSpoken.current.at < 800) return;
      lastSpoken.current = { text: clean, at: now };
      setCaption(clean);
      if (o?.log) pushLine('consultant', clean);
      const agentId = isLive() ? convRef.current!.getAgentId() : null;
      if (agentId) {
        postJson('/voice/speak', { agentId, text: clean, priority: 'INTERRUPT' }).catch(() => {
          localSpeechUntil.current = performance.now() + estimateSpeechMs(clean);
        });
      } else {
        localSpeechUntil.current = performance.now() + estimateSpeechMs(clean);
      }
    },
    [isLive, pushLine],
  );

  /** Ground the consultant in the film now on the screen. */
  const setCase = useCallback((c: RadCase | null) => {
    caseRef.current = c;
    const l = store.getState().lang;
    promptRef.current = c ? buildRadiologistCasePrompt(c, l) : buildRadiologistPersona(l);
    const agentId = convRef.current?.getAgentId();
    if (agentId) {
      postJson('/voice/context', { agentId, systemPrompt: promptRef.current }).catch((e) =>
        console.warn('[radiology] context update failed:', e),
      );
    }
  }, []);

  /** Typed line from the student. Returns true when the live agent took it
   *  (it will answer by voice); false means the caller should ask the backend. */
  const sendTyped = useCallback(
    async (text: string): Promise<boolean> => {
      const clean = text.trim();
      if (!clean) return true;
      pushLine('you', clean);
      const c = convRef.current;
      if (isLive() && c) {
        typedEcho.current = norm(clean);
        await c.sendTextMessage(clean);
        return true;
      }
      return false;
    },
    [isLive, pushLine],
  );

  const mouth = useCallback(() => {
    const c = convRef.current;
    const live = c ? c.getMouthAmplitude() : 0;
    if (live > 0) return live;
    const now = performance.now();
    if (now < localSpeechUntil.current) {
      const t = now / 1000;
      return 0.25 + 0.3 * Math.abs(Math.sin(t * 10.7)) * (0.6 + 0.4 * Math.sin(t * 2.9));
    }
    return 0;
  }, []);

  useEffect(
    () => () => {
      convRef.current?.dispose();
      convRef.current = null;
    },
    [],
  );

  return {
    status,
    live: LIVE.includes(status),
    progress,
    error,
    clearError: () => setError(''),
    caption,
    log,
    micMuted,
    connect,
    hangUp,
    toggle,
    toggleMic,
    speak,
    setCase,
    sendTyped,
    isLive,
    mouth,
  };
}

export type RadiologistSession = ReturnType<typeof useRadiologistSession>;
