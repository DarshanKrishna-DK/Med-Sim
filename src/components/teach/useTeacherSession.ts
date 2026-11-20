import { useCallback, useEffect, useRef, useState } from 'react';
import { Conversation, type ConversationStatus, type SubtitleEvent } from '../../voice/conversation';
import { ensureAudioContext } from '../../voice/conversationStore';
import { TEACHER, TEACHER_GREETING, buildTeacherLessonPrompt, buildTeacherPersona } from '../../voice/teacherPersona';
import { estimateSpeechMs, type Lesson } from './lesson';

// The classroom's teacher voice session. Reuses the patient voice stack as
// is: a Conversation (POST /voice/start with caseId 'teacher'), then
// /voice/context to ground it in the lesson and /voice/speak for each
// whiteboard step's narration. Typed questions go over RTM when live, or
// to POST /teach/ask when voice is off.

export interface ClassLine {
  id: number;
  who: 'teacher' | 'you';
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

export function useTeacherSession(opts: { onStudentFinal: (text: string, typed: boolean) => void; onStudentPartial?: () => void }) {
  const [status, setStatus] = useState<ConversationStatus>('uninitialized');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [teacherCaption, setTeacherCaption] = useState<string>(TEACHER_GREETING);
  const [studentCaption, setStudentCaption] = useState<string>('');
  const [log, setLog] = useState<ClassLine[]>([]);
  const [micMuted, setMicMuted] = useState(false);
  const [thinking, setThinking] = useState(false);

  const convRef = useRef<Conversation | null>(null);
  const promptRef = useRef(buildTeacherPersona());
  const lessonRef = useRef<Lesson | null>(null);
  const localSpeechUntil = useRef(0);
  const lastSpoken = useRef({ text: '', at: 0 });
  const typedEcho = useRef<string | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const logRef = useRef(log);
  logRef.current = log;

  const pushLine = useCallback((who: ClassLine['who'], text: string) => {
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
        setTeacherCaption(sub.text);
        if (!sub.partial) pushLine('teacher', sub.text);
        return;
      }
      setStudentCaption(sub.text);
      if (sub.partial) {
        optsRef.current.onStudentPartial?.();
        return;
      }
      const wasTyped = typedEcho.current !== null && norm(sub.text) === typedEcho.current;
      if (wasTyped) {
        typedEcho.current = null;
        return; // typed path already logged + routed it
      }
      pushLine('you', sub.text);
      optsRef.current.onStudentFinal(sub.text, false);
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
    const lesson = lessonRef.current;
    const greeting = lesson
      ? `Achha, welcome back. We are on ${lesson.title}. Ask me anything about the board, or tell me a new topic.`
      : TEACHER_GREETING;
    const conv = new Conversation(ctx, listeners.current, {
      systemPrompt: promptRef.current,
      initialMessage: { role: 'assistant', content: greeting },
      voiceGender: TEACHER.gender,
      caseId: TEACHER.caseId,
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

  /** Ground the teacher in the lesson on the board (or back to the bare persona). */
  const setLesson = useCallback((lesson: Lesson | null) => {
    lessonRef.current = lesson;
    promptRef.current = lesson ? buildTeacherLessonPrompt(lesson) : buildTeacherPersona();
    const agentId = convRef.current?.getAgentId();
    if (agentId) {
      postJson('/voice/context', { agentId, systemPrompt: promptRef.current }).catch((e) =>
        console.warn('[teacher] context update failed:', e),
      );
    }
  }, []);

  /** Teacher says a line: spoken by the live agent, or captioned with a
   *  simulated mouth when voice is off. */
  const speak = useCallback(
    (text: string, opts?: { log?: boolean }) => {
      const clean = text.trim();
      if (!clean) return;
      // StrictMode re-runs effects; never send the same line twice in a row.
      const now = performance.now();
      if (lastSpoken.current.text === clean && now - lastSpoken.current.at < 800) return;
      lastSpoken.current = { text: clean, at: now };
      setTeacherCaption(clean);
      if (opts?.log) pushLine('teacher', clean);
      const agentId = isLive() ? convRef.current!.getAgentId() : null;
      if (agentId) {
        postJson('/voice/speak', { agentId, text: clean, priority: 'INTERRUPT' }).catch((e) => {
          console.warn('[teacher] speak failed:', e);
          localSpeechUntil.current = performance.now() + estimateSpeechMs(clean);
        });
      } else {
        localSpeechUntil.current = performance.now() + estimateSpeechMs(clean);
      }
    },
    [isLive, pushLine],
  );

  /** Typed question. Topic routing happens in the caller (onStudentFinal). */
  const ask = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      pushLine('you', clean);
      setStudentCaption(clean);
      optsRef.current.onStudentFinal(clean, true);
    },
    [pushLine],
  );

  /** Send a question to the teacher (after the caller decided it is not a topic request). */
  const sendQuestion = useCallback(
    async (text: string, typed: boolean) => {
      const c = convRef.current;
      if (isLive() && c) {
        if (typed) {
          typedEcho.current = norm(text);
          await c.sendTextMessage(text);
        }
        return; // spoken questions are already in the agent's turn
      }
      if (!typed) return;
      setThinking(true);
      try {
        const history = [...logRef.current, { id: 0, who: 'you' as const, text }]
          .slice(-12)
          .map((l) => ({ role: l.who === 'you' ? ('user' as const) : ('assistant' as const), content: l.text.slice(0, 1800) }));
        while (history.length && history[0].role === 'assistant') history.shift();
        const merged: typeof history = [];
        for (const m of history) {
          const last = merged[merged.length - 1];
          if (last && last.role === m.role) last.content += '\n' + m.content;
          else merged.push({ ...m });
        }
        const { reply } = await postJson<{ reply: string }>('/teach/ask', { system: promptRef.current, messages: merged });
        speak(reply, { log: true });
      } catch (e) {
        setError(e instanceof Error ? `Teacher reply failed: ${e.message}` : 'Teacher reply failed.');
      } finally {
        setThinking(false);
      }
    },
    [isLive, speak],
  );


  /** 0..1 mouth opening for the teacher's lip-sync. */
  const mouth = useCallback(() => {
    const c = convRef.current;
    const live = c ? c.getMouthAmplitude() : 0;
    if (live > 0) return live;
    const now = performance.now();
    if (now < localSpeechUntil.current) {
      const t = now / 1000;
      return 0.25 + 0.3 * Math.abs(Math.sin(t * 11.3)) * (0.6 + 0.4 * Math.sin(t * 3.1));
    }
    return 0;
  }, []);

  /** True while the teacher is (or should be) talking. */
  const isSpeaking = useCallback(() => {
    const c = convRef.current;
    if (c && (c.getStatus() === 'speaking' || c.getMouthAmplitude() > 0.04)) return true;
    return performance.now() < localSpeechUntil.current;
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
    teacherCaption,
    studentCaption,
    log,
    micMuted,
    thinking,
    connect,
    hangUp,
    toggle,
    toggleMic,
    setLesson,
    speak,
    ask,
    sendQuestion,
    mouth,
    isSpeaking,
  };
}

export type TeacherSession = ReturnType<typeof useTeacherSession>;
