import { useCallback, useEffect, useRef, useState } from 'react';
import { Conversation, type ConversationStatus, type SubtitleEvent } from '../../voice/conversation';
import { ensureAudioContext } from '../../voice/conversationStore';
import { EXAMINER, buildVivaPersona, buildVivaPlanPrompt, examinerGreeting, timeUpLine } from '../../voice/vivaPersona';
import { LANG_LOCALE } from '../../game/lang';
import { estimateSpeechMs } from '../teach/lesson';
import { advanceQuestion, askHistory, isClosingLine, type VivaLine, type VivaQuestion, type VivaSetup } from './vivaCore';
import { upsertGrade, vivaAction, type AgentEvent, type LiveGrade } from '../../agents/agentEvents';

// The examiner's voice session. Reuses the patient voice stack: a
// Conversation (POST /voice/start with caseId 'viva-examiner'), then
// /voice/context to push the hidden question plan and /voice/speak for the
// time-up line. Typed answers go over RTM when live; with voice off they go
// to POST /agent/viva/ask and the reply is read out with Murf (/voice/tts).
// Tool-enabled sessions: the examiner marks each answer, picks the next
// question and ends the viva himself (agent_toolsets.py); his events arrive
// through onAgentEvents (live marks, question counter, final marking).

const LIVE: ConversationStatus[] = ['ready', 'listening', 'thinking', 'speaking'];

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
  return (await r.json()) as T;
}

/** What the examiner's tools act on: subject, year and the hidden plan. */
function vivaContext(setup: VivaSetup, plan: VivaQuestion[]): Record<string, unknown> {
  return {
    subject: setup.subject,
    year: setup.year,
    topic: setup.topic,
    plan: plan.slice(0, 12).map((q) => ({ q: q.q.slice(0, 300), difficulty: q.difficulty })),
    lang: setup.lang,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-ൿ]+/g, ' ').trim();

export function useVivaSession() {
  const [status, setStatus] = useState<ConversationStatus>('uninitialized');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [examinerCaption, setExaminerCaption] = useState('');
  const [studentCaption, setStudentCaption] = useState('');
  const [lines, setLines] = useState<VivaLine[]>([]);
  const [qIndex, setQIndex] = useState(-1);
  const [closed, setClosed] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [liveGrades, setLiveGrades] = useState<LiveGrade[]>([]);
  const toolQuestions = useRef(0);

  const convRef = useRef<Conversation | null>(null);
  const setupRef = useRef<VivaSetup | null>(null);
  const planRef = useRef<VivaQuestion[]>([]);
  const promptRef = useRef('');
  const pushedPromptRef = useRef('');
  const startedAt = useRef(0);
  const examinerTurns = useRef(0);
  const qRef = useRef(-1);
  const typedEcho = useRef<string | null>(null);
  const linesRef = useRef<VivaLine[]>([]);
  const localSpeechUntil = useRef(0);
  const ttsAnalyser = useRef<AnalyserNode | null>(null);
  const ttsAudio = useRef<HTMLAudioElement | null>(null);
  const ttsBuf = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const pushLine = useCallback((who: VivaLine['who'], text: string) => {
    const at = startedAt.current ? Math.round(performance.now() - startedAt.current) : 0;
    const next = [...linesRef.current, { who, text, at }].slice(-200);
    linesRef.current = next;
    setLines(next);
  }, []);

  /** Every final examiner line: transcript, question counter, end detection. */
  const onExaminerFinal = useCallback(
    (text: string) => {
      pushLine('examiner', text);
      examinerTurns.current += 1;
      if (examinerTurns.current > 1) {
        const next = advanceQuestion(qRef.current, text, planRef.current);
        if (next !== qRef.current) {
          qRef.current = next;
          setQIndex(next);
        }
      }
      if (isClosingLine(text)) setClosed(true);
    },
    [pushLine],
  );

  const isLive = useCallback(() => {
    const c = convRef.current;
    return !!c && LIVE.includes(c.getStatus()) && !!c.getAgentId();
  }, []);

  /** Push the current prompt to the live agent if it has not seen it yet. */
  const syncPrompt = useCallback(() => {
    const agentId = convRef.current?.getAgentId();
    if (!agentId || pushedPromptRef.current === promptRef.current) return;
    pushedPromptRef.current = promptRef.current;
    postJson('/voice/context', { agentId, systemPrompt: promptRef.current }).catch((e) => {
      pushedPromptRef.current = '';
      console.warn('[viva] context update failed:', e);
    });
  }, []);

  const listeners = useRef({
    onStatus: (s: ConversationStatus) => {
      setStatus(s);
      if (LIVE.includes(s)) syncPromptRef.current();
    },
    onProgress: (m: string) => setProgress(m),
    onError: (e: string) => setError(e),
    onSubtitle: (sub: SubtitleEvent) => {
      if (sub.who === 'patient') {
        if (sub.text === '…') return;
        setExaminerCaption(sub.text);
        if (!sub.partial) onExaminerFinalRef.current(sub.text);
        return;
      }
      setStudentCaption(sub.text);
      if (sub.partial) return;
      if (typedEcho.current !== null && norm(sub.text) === typedEcho.current) {
        typedEcho.current = null;
        return; // the typed path already logged it
      }
      pushLine('student', sub.text);
    },
    onAgentEvents: (events: AgentEvent[]) => {
      for (const e of events) {
        const a = vivaAction(e);
        if (!a) continue;
        if (a.kind === 'grade') setLiveGrades((g) => upsertGrade(g, a.grade));
        else if (a.kind === 'question') {
          toolQuestions.current += 1;
          const next = Math.max(qRef.current, toolQuestions.current - 1);
          qRef.current = next;
          setQIndex(next);
        } else setClosed(true); // end_viva: the screen's existing final marking runs
      }
    },
  });
  const syncPromptRef = useRef(syncPrompt);
  syncPromptRef.current = syncPrompt;
  const onExaminerFinalRef = useRef(onExaminerFinal);
  onExaminerFinalRef.current = onExaminerFinal;

  /** Murf read-out for typed mode, with a real analyser for the lip-sync bars. */
  const speakLocal = useCallback((text: string) => {
    localSpeechUntil.current = performance.now() + estimateSpeechMs(text);
    const lang = setupRef.current?.lang ?? 'en';
    fetch('/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, caseId: EXAMINER.caseId, gender: EXAMINER.gender, locale: LANG_LOCALE[lang] }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`tts ${r.status}`);
        const url = URL.createObjectURL(await r.blob());
        ttsAudio.current?.pause();
        const audio = new Audio(url);
        ttsAudio.current = audio;
        try {
          const ctx = ensureAudioContext();
          const src = ctx.createMediaElementSource(audio);
          const an = ctx.createAnalyser();
          an.fftSize = 512;
          src.connect(an);
          an.connect(ctx.destination);
          ttsAnalyser.current = an;
        } catch {
          ttsAnalyser.current = null;
        }
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (ttsAudio.current === audio) ttsAnalyser.current = null;
        };
        localSpeechUntil.current = 0;
        await audio.play();
      })
      .catch(() => {
        /* captions + simulated mouth carry on without audio */
      });
  }, []);

  const examinerSays = useCallback(
    (text: string) => {
      setExaminerCaption(text);
      onExaminerFinal(text);
      speakLocal(text);
    },
    [onExaminerFinal, speakLocal],
  );

  /** Start the viva. Call from a click (audio needs a user gesture). */
  const start = useCallback(
    (setup: VivaSetup, opts: { voice: boolean }) => {
      convRef.current?.dispose();
      convRef.current = null;
      setupRef.current = setup;
      promptRef.current = planRef.current.length ? buildVivaPlanPrompt(setup, planRef.current) : buildVivaPersona(setup);
      pushedPromptRef.current = '';
      startedAt.current = performance.now();
      examinerTurns.current = 0;
      qRef.current = -1;
      linesRef.current = [];
      typedEcho.current = null;
      setLines([]);
      setQIndex(-1);
      setClosed(false);
      setLiveGrades([]);
      toolQuestions.current = 0;
      setError('');
      setStudentCaption('');
      const greeting = examinerGreeting(setup);
      setExaminerCaption(greeting);
      let ctx: AudioContext | null = null;
      try {
        ctx = ensureAudioContext();
      } catch {
        ctx = null;
      }
      if (!opts.voice || !ctx) {
        if (opts.voice) setError('This browser has no Web Audio support. Type your answers instead.');
        examinerSays(greeting);
        return;
      }
      const conv = new Conversation(ctx, listeners.current, {
        systemPrompt: promptRef.current,
        initialMessage: { role: 'assistant', content: greeting },
        voiceGender: EXAMINER.gender,
        caseId: EXAMINER.caseId,
        locale: LANG_LOCALE[setup.lang],
        agentContext: vivaContext(setup, planRef.current),
      });
      convRef.current = conv;
      pushedPromptRef.current = promptRef.current;
      setStatus('loading');
      conv.init().catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        // Voice failed: carry on as a typed viva.
        if (convRef.current === conv) convRef.current = null;
        if (!linesRef.current.length) examinerSays(greeting);
      });
    },
    [examinerSays],
  );

  /** The hidden plan arrived: ground the examiner in it. */
  const setPlan = useCallback(
    (plan: VivaQuestion[]) => {
      planRef.current = plan;
      const setup = setupRef.current;
      if (!setup) return;
      promptRef.current = buildVivaPlanPrompt(setup, plan);
      syncPrompt();
      void convRef.current?.updateAgentContext({ plan: vivaContext(setup, plan).plan });
    },
    [syncPrompt],
  );

  /** Seed the plan before start() (e.g. a plan fetched while on the setup screen). */
  const primePlan = useCallback((plan: VivaQuestion[]) => {
    planRef.current = plan;
  }, []);

  /** A typed answer: over RTM when live, else the text endpoint. */
  const answer = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      const c = convRef.current;
      if (isLive() && c) {
        typedEcho.current = norm(clean);
        pushLine('student', clean);
        setStudentCaption(clean);
        await c.sendTextMessage(clean);
        return;
      }
      pushLine('student', clean);
      setStudentCaption(clean);
      setThinking(true);
      try {
        const { reply } = await postJson<{ reply: string }>('/agent/viva/ask', {
          system: promptRef.current,
          lang: setupRef.current?.lang ?? 'en',
          messages: askHistory(linesRef.current),
        });
        examinerSays(reply);
      } catch (e) {
        setError(e instanceof Error ? `Examiner reply failed: ${e.message}` : 'Examiner reply failed.');
      } finally {
        setThinking(false);
      }
    },
    [examinerSays, isLive, pushLine],
  );

  /** Clock ran out: the examiner closes the viva politely. */
  const timeUp = useCallback(() => {
    const lang = setupRef.current?.lang ?? 'en';
    const line = timeUpLine(lang);
    const agentId = isLive() ? convRef.current!.getAgentId() : null;
    if (agentId) {
      setExaminerCaption(line);
      postJson('/voice/speak', { agentId, text: line, priority: 'INTERRUPT' }).catch(() => undefined);
      // The agent's transcript of this line closes the viva; this is the backstop.
      window.setTimeout(() => setClosed(true), 6000);
    } else {
      examinerSays(line);
    }
  }, [examinerSays, isLive]);

  const hangUp = useCallback(() => {
    convRef.current?.dispose();
    convRef.current = null;
    ttsAudio.current?.pause();
    setStatus('uninitialized');
    setProgress('');
    setMicMuted(false);
  }, []);

  const toggleMic = useCallback(() => {
    const c = convRef.current;
    if (!c) return;
    setMicMuted((m) => {
      c.setMicMuted(!m);
      return !m;
    });
  }, []);

  /** 0..1 mouth opening for the examiner portrait. */
  const mouth = useCallback(() => {
    const c = convRef.current;
    const live = c ? c.getMouthAmplitude() : 0;
    if (live > 0) return live;
    const an = ttsAnalyser.current;
    if (an && ttsAudio.current && !ttsAudio.current.paused) {
      if (!ttsBuf.current || ttsBuf.current.length !== an.fftSize) ttsBuf.current = new Uint8Array(an.fftSize);
      const buf = ttsBuf.current;
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / buf.length) * 4);
    }
    const now = performance.now();
    if (now < localSpeechUntil.current) {
      const t = now / 1000;
      return 0.25 + 0.3 * Math.abs(Math.sin(t * 11.3)) * (0.6 + 0.4 * Math.sin(t * 3.1));
    }
    return 0;
  }, []);

  useEffect(
    () => () => {
      convRef.current?.dispose();
      convRef.current = null;
      ttsAudio.current?.pause();
    },
    [],
  );

  return {
    status,
    live: LIVE.includes(status),
    progress,
    error,
    clearError: () => setError(''),
    examinerCaption,
    studentCaption,
    lines,
    qIndex,
    closed,
    liveGrades,
    thinking,
    micMuted,
    start,
    setPlan,
    primePlan,
    answer,
    timeUp,
    hangUp,
    toggleMic,
    mouth,
    elapsedMs: () => (startedAt.current ? performance.now() - startedAt.current : 0),
  };
}

export type VivaSession = ReturnType<typeof useVivaSession>;
