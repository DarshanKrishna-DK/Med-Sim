import { useCallback, useEffect, useRef, useState } from 'react';
import { Conversation, type ConversationStatus, type SubtitleEvent } from '../../voice/conversation';
import { ensureAudioContext } from '../../voice/conversationStore';
import { RECEPTIONIST, buildReceptionistPersona, receptionGreeting } from '../../voice/receptionistPersona';
import { getAssignmentView, localProgressSummary, openAssignment, useAssignment } from '../../assignments/client';
import { runReceptionAction, setReceptionSink, type ReceptionResult } from '../../agents/receptionAgent';
import { toolLine, type AgentEvent } from '../../agents/agentEvents';
import { followDesk, openDeskRoom, setDeskListener } from '../../room/deskWatch';
import { getProfile, useProfile } from '../../game/profile';
import { getPatientContact } from '../../game/patientContact';
import { store, useStore } from '../../game/store';
import { LANG_LOCALE } from '../../game/lang';

// Priya's voice session. A Conversation with caseId 'receptionist' (Agora
// Conversational AI, Murf voice picked server-side). Final transcripts and
// typed text go to the front-desk agent (/agent/reception/act) from inside
// conversation.ts; this hook is the sink that logs and speaks the result.
// When the backend reports the session tool-enabled (custom LLM route), Priya
// runs those tools herself mid-call (agent_toolsets.py): no keyword trigger;
// her tool events arrive through onAgentEvents and are logged here.

export interface DeskLine {
  id: number;
  who: 'priya' | 'you' | 'action';
  text: string;
  ok?: boolean;
}

const LIVE: ConversationStatus[] = ['ready', 'listening', 'thinking', 'speaking'];
let lineId = 0;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function postJson(path: string, body: unknown): Promise<void> {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
}

function persona(): string {
  return buildReceptionistPersona(getProfile(), getAssignmentView(), localProgressSummary(), store.getState().lang);
}

/** What Priya's server-side tools may act on (agent_toolsets.reception_exec). */
function agentContext(): Record<string, unknown> {
  const view = getAssignmentView();
  const p = getProfile();
  const contact = getPatientContact();
  const local = localProgressSummary();
  const deskRoom = openDeskRoom();
  return {
    assignmentCode: view.code,
    ...(deskRoom ? { deskRoom } : {}),
    knownCodes: view.known.slice(0, 20),
    profile: { name: p?.name ?? '', university: p?.university ?? '' },
    localProgress: { ...local, recent: local.recent.slice(0, 8) },
    ...(contact ? { contact } : {}),
    lang: store.getState().lang,
  };
}

export function useReceptionSession() {
  const [status, setStatus] = useState<ConversationStatus>('uninitialized');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [caption, setCaption] = useState(() => receptionGreeting(getProfile(), getAssignmentView()));
  const [youCaption, setYouCaption] = useState('');
  const [log, setLog] = useState<DeskLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [offlineTalking, setOfflineTalking] = useState(false);

  const convRef = useRef<Conversation | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const typedEcho = useRef<string | null>(null);

  const push = useCallback((who: DeskLine['who'], text: string, ok?: boolean) => {
    setLog((l) => [...l.slice(-40), { id: ++lineId, who, text, ok }]);
  }, []);

  const isLive = useCallback(() => {
    const c = convRef.current;
    return !!c && LIVE.includes(c.getStatus()) && !!c.getAgentId();
  }, []);

  const stopAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setOfflineTalking(false);
  }, []);

  /** Priya says a line: through the live agent, or Murf TTS over HTTP when voice is off. */
  const say = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      setCaption(clean);
      push('priya', clean);
      const agentId = isLive() ? convRef.current!.getAgentId() : null;
      if (agentId) {
        try {
          await postJson('/voice/speak', { agentId, text: clean, priority: 'APPEND' });
        } catch {
          await postJson('/voice/speak', { agentId, text: clean, priority: 'INTERRUPT' }).catch(() => undefined);
        }
        return;
      }
      stopAudio();
      try {
        const r = await fetch('/voice/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean, voice: 'F', caseId: RECEPTIONIST.caseId, gender: 'F', locale: LANG_LOCALE[store.getState().lang] }),
        });
        if (!r.ok) return;
        const url = URL.createObjectURL(await r.blob());
        const audio = new Audio(url);
        audioRef.current = audio;
        const done = () => {
          URL.revokeObjectURL(url);
          if (audioRef.current === audio) audioRef.current = null;
          setOfflineTalking(false);
        };
        audio.addEventListener('ended', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        setOfflineTalking(true);
        await audio.play().catch(done);
      } catch {
        setOfflineTalking(false);
      }
    },
    [isLive, push, stopAudio],
  );

  // The front-desk agent reports here while the panel is open.
  useEffect(() => {
    setReceptionSink({
      onStart: () => setBusy(true),
      onResult: (res: ReceptionResult, source) => {
        setBusy(false);
        for (const s of res.steps) push('action', s.summary, s.ok);
        // Live and no action: the voice agent already answered this turn itself.
        if (res.intent === 'none' && isLive()) return;
        void source;
        void say(res.spokenConfirmation);
      },
      onError: (m) => {
        setBusy(false);
        setError(m);
      },
    });
    return () => setReceptionSink(null);
  }, [push, say, isLive]);

  // A faculty reply or Dr Iyer's plan that arrives while the student is at the desk.
  useEffect(() => {
    setDeskListener((n) => {
      push('action', n.shown, n.id !== 'failed');
      void say(n.spoken || n.shown);
    });
    return () => setDeskListener(null);
  }, [push, say]);

  const listeners = useRef({
    onStatus: (s: ConversationStatus) => setStatus(s),
    onProgress: (m: string) => setProgress(m),
    onError: (e: string) => setError(e),
    onSubtitle: (sub: SubtitleEvent) => {
      if (sub.who === 'patient') {
        if (sub.text === '…') return;
        setCaption(sub.text);
        if (!sub.partial) push('priya', sub.text);
        return;
      }
      setYouCaption(sub.text);
      if (sub.partial) return;
      if (typedEcho.current !== null && norm(sub.text) === typedEcho.current) {
        typedEcho.current = null;
        return;
      }
      push('you', sub.text);
    },
    onAgentEvents: (events: AgentEvent[]) => {
      for (const e of events) {
        const line = toolLine(e);
        if (line) push('action', line.summary, line.ok);
        if (e.type === 'desk_room') followDesk(e.data);
        if (e.type === 'report_emailed') {
          const code = getAssignmentView().code;
          if (code) void openAssignment(code);
        }
      }
    },
  });

  const connect = useCallback(() => {
    stopAudio();
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
    const conv = new Conversation(ctx, listeners.current, {
      systemPrompt: persona(),
      initialMessage: { role: 'assistant', content: receptionGreeting(getProfile(), getAssignmentView()) },
      voiceGender: RECEPTIONIST.gender,
      caseId: RECEPTIONIST.caseId,
      locale: LANG_LOCALE[store.getState().lang],
      avatar: false,
      agentContext: agentContext(),
    });
    convRef.current = conv;
    setStatus('loading');
    conv.init().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [stopAudio]);

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

  /** Typed message: over RTM to the live agent (which also triggers the desk
   *  agent), or straight to the desk agent when voice is off. */
  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      setYouCaption(clean);
      const c = convRef.current;
      if (isLive() && c) {
        typedEcho.current = norm(clean);
        push('you', clean);
        await c.sendTextMessage(clean);
        return;
      }
      push('you', clean);
      await runReceptionAction(clean, 'typed');
    },
    [isLive, push],
  );

  // Keep the live agent's context current: assignment progress, profile, language.
  const view = useAssignment();
  const profile = useProfile();
  const lang = useStore((s) => s.lang);
  const live = LIVE.includes(status);
  useEffect(() => {
    const agentId = isLive() ? convRef.current?.getAgentId() : null;
    if (!agentId) return;
    const t = window.setTimeout(() => {
      const c = convRef.current;
      const body = c?.isToolEnabled() ? { agentId, systemPrompt: persona(), agentContext: agentContext() } : { agentId, systemPrompt: persona() };
      postJson('/voice/context', body).catch((e) => console.warn('[reception] context update failed:', e));
    }, 400);
    return () => window.clearTimeout(t);
  }, [view, profile, lang, isLive, live]);

  useEffect(
    () => () => {
      convRef.current?.dispose();
      convRef.current = null;
      audioRef.current?.pause();
    },
    [],
  );

  return {
    status,
    live,
    talking: status === 'speaking' || offlineTalking,
    progress,
    error,
    clearError: () => setError(''),
    caption,
    youCaption,
    log,
    busy,
    micMuted,
    toggle,
    toggleMic,
    hangUp,
    send,
    say,
  };
}

export type ReceptionSession = ReturnType<typeof useReceptionSession>;
