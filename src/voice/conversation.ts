/**
 * Real-time voice conversation, backed by Agora Conversational AI.
 *
 * Public API surface kept from the previous LiveKit implementation so
 * existing consumers (FloatingVoicePanel, DockedVoicePanel, ExamineOverlay,
 * conversationStore) keep compiling without changes.
 *
 * Pipeline:
 *   1. `init()` → POST /voice/start. The backend starts an Agora
 *      Conversational AI agent in a fresh channel (ASR = ARES,
 *      LLM = patient persona, TTS = Murf Falcon, data_channel = "rtm") and
 *      returns an RTC+RTM token for our uid.
 *   2. RTM login + subscribe to the channel name → transcripts and agent
 *      state arrive as RTM channel messages / presence events.
 *   3. RTC join, publish mic, subscribe to the agent's audio and play it.
 *      `getMouthAmplitude()` reads the remote track's volume for lip-sync.
 *
 * Transcript wire format (agent → RTM channel message, JSON string):
 *   { object: "user.transcription", text, final: boolean, turn_id, stream_id, user_id }
 *   { object: "assistant.transcription", text, turn_status: 0|1|2, turn_id, quiet, words }
 *       turn_status: 0 = in progress, 1 = end, 2 = interrupted. In text mode
 *       `text` is the cumulative text of the turn so far.
 *   { object: "message.interrupt", turn_id }
 * Agent state arrives as RTM presence REMOTE_STATE_CHANGED with
 *   stateChanged = { state: "idle"|"listening"|"thinking"|"speaking"|"silent", turn_id }.
 * (Same format as agora-agent-client-toolkit's CovSubRenderController.)
 */

import AgoraRTC, {
  type IAgoraRTCClient,
  type IAgoraRTCRemoteUser,
  type IMicrophoneAudioTrack,
  type IRemoteAudioTrack,
} from 'agora-rtc-sdk-ng';
import AgoraRTM, { type RTMClient } from 'agora-rtm';
import { voiceMetrics } from './voiceMetrics';
import { streamClaude, type ChatMessage } from './claude';
import { decodeRtmJson, mergeTurnText, parseAgentMessage, type AgentRtmMessage } from './transcriptParser';

const LOG = '[medsim:voice]';

const FALLBACK_PERSONA =
  'You are a patient speaking to a doctor. Keep replies to 1–2 short spoken sentences. ' +
  'Output spoken dialogue only, no stage directions, no asterisks, no brackets.';
const FALLBACK_INITIAL: { role: 'assistant'; content: string } = {
  role: 'assistant',
  content: 'Hi doc.',
};

const FAREWELL_LINES = [
  'Okay, thank you so much, doctor. Goodbye.',
  'Thanks, doctor. Take care.',
  'Alright... thank you. Bye now.',
  'Okay. Thanks for your help, doctor. Bye.',
];

export type ConversationStatus =
  | 'uninitialized'
  | 'loading'
  | 'ready'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface SubtitleEvent {
  who: 'patient' | 'you';
  text: string;
  partial?: boolean;
}

export type PatientEmotion = 'neutral' | 'pain' | 'fear' | 'relief' | 'confused';

export interface ConversationListeners {
  onStatus?: (status: ConversationStatus, detail?: string) => void;
  onProgress?: (msg: string) => void;
  onSubtitle?: (sub: SubtitleEvent) => void;
  onError?: (err: string) => void;
  onEmotion?: (e: PatientEmotion) => void;
}

function detectEmotion(text: string): PatientEmotion {
  const t = text.toLowerCase();
  if (/\b(hurts?|pain(?:ful)?|ache|aching|ow|ouch|sore|burn(?:s|ing)?|sharp|throb|stab|rip(?:ping)?|tear(?:ing)?|crush(?:ing)?|killing me|agony|can'?t breathe|chest)\b/.test(t)) return 'pain';
  if (/\b(scared|afraid|frightened|terrified|worr(?:ied|y)|nervous|anxious|help me|please help|dying|die|gonna die|save me)\b/.test(t)) return 'fear';
  if (/\b(okay|i'?m okay|fine|better|good now|thanks|thank you|relieved?|easier|breathing better|no more pain)\b/.test(t)) return 'relief';
  if (/\b(i don'?t (?:know|understand)|not sure|confused|what does that mean|what do you mean|sorry what)\b/.test(t)) return 'confused';
  return 'neutral';
}

/** Sessions that are NOT a patient consultation. Their utterances must never
 *  reach the clinical agents (nurse orders, exam detection): a viva answer
 *  like "give atropine" is not an order for the patient in the clinic. */
const NON_PATIENT_SESSIONS = new Set(['teacher', 'viva-examiner', 'radiologist']);

export interface ConversationOptions {
  /** Run the nurse/exam agents on this session's utterances. Defaults to true
   *  for patient consultations and false for teacher, viva and radiology. */
  clinicalAgents?: boolean;
  systemPrompt?: string;
  initialMessage?: { role: 'assistant'; content: string };
  /** Speaker gender ('M'|'F'), used by backend voice picker. */
  voiceGender?: 'M' | 'F';
  /** Stable case id, backend uses this for logging + voice slot pick. */
  caseId?: string;
  /** Preserved for back-compat. Ignored, voice ID is chosen server-side. */
  voice?: string;
  /** If set, persist/restore the conversation history to localStorage under this key. */
  storageKey?: string;
  /** BCP-47 locale hint for ASR/TTS (backend default if omitted). */
  locale?: string;
}

interface VoiceStartResponse {
  appId: string;
  channel: string;
  uid: number;
  token: string;
  agentUid: number;
  agentId: string;
}

// ── backend helpers ─────────────────────────────────────────────

class VoiceBackendError extends Error {}

function friendlyBackendError(status: number, body: string): string {
  const b = body.toLowerCase();
  if (
    status === 503 ||
    /not configured|missing .*key|agora_app|murf|no app ?id|app_certificate/.test(b)
  ) {
    return 'Voice backend not configured, add Agora/Murf keys to backend/.env.local.';
  }
  if (status === 502 || status === 504 || (status === 500 && body.trim() === '')) {
    return 'Voice backend unreachable, start backend/server.py on :8787.';
  }
  const detail = body.replace(/\s+/g, ' ').slice(0, 160);
  return `Voice backend error ${status}${detail ? `: ${detail}` : ''}`;
}

async function postVoice<T>(path: string, body: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: opts.keepalive,
    });
  } catch {
    throw new VoiceBackendError('Voice backend unreachable, start backend/server.py on :8787.');
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new VoiceBackendError(friendlyBackendError(r.status, text));
  }
  const ct = r.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? await r.json() : (undefined as unknown)) as T;
}

function friendlyMediaError(err: unknown): string | null {
  const code = (err as { code?: string })?.code ?? '';
  const name = (err as { name?: string })?.name ?? '';
  const msg = (err as { message?: string })?.message ?? '';
  if (code === 'PERMISSION_DENIED' || name === 'NotAllowedError' || /permission denied/i.test(msg)) {
    return 'Microphone permission denied, allow mic access and press T to retry.';
  }
  if (code === 'DEVICE_NOT_FOUND' || name === 'NotFoundError') {
    return 'No microphone found.';
  }
  if (code === 'INVALID_PARAMS' && /appid/i.test(msg)) {
    return 'Voice backend not configured, invalid Agora App ID.';
  }
  if (/token|dynamic key|CAN_NOT_GET_GATEWAY_SERVER/i.test(`${code} ${msg}`)) {
    return `Agora rejected the session token (${code || msg}). Check AGORA_APP_ID / AGORA_APP_CERTIFICATE.`;
  }
  return null;
}

// ── page-unload safety net: stop any agents we started ─────────

const liveAgentIds = new Set<string>();
let unloadHookInstalled = false;
function installUnloadHook() {
  if (unloadHookInstalled || typeof window === 'undefined') return;
  unloadHookInstalled = true;
  window.addEventListener('pagehide', () => {
    for (const agentId of liveAgentIds) {
      try {
        const blob = new Blob([JSON.stringify({ agentId })], { type: 'application/json' });
        navigator.sendBeacon('/voice/stop', blob);
      } catch { /* noop */ }
    }
    liveAgentIds.clear();
  });
}

// Agora's SDK is chatty at INFO. Warnings and errors only.
try { AgoraRTC.setLogLevel(2); } catch { /* noop */ }

// Remote audio play() can be blocked by autoplay policy if the gesture
// chain was broken. Resume all pending tracks on the next user gesture.
const pendingAutoplay = new Set<IRemoteAudioTrack>();
AgoraRTC.onAutoplayFailed = () => {
  const resume = () => {
    for (const t of pendingAutoplay) { try { t.play(); } catch { /* noop */ } }
    pendingAutoplay.clear();
  };
  window.addEventListener('pointerdown', resume, { once: true });
  window.addEventListener('keydown', resume, { once: true });
};

function normWords(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'silent';

export class Conversation {
  private messages: ChatMessage[] = [];
  private listeners: ConversationListeners = {};
  private status: ConversationStatus = 'uninitialized';

  private rtc: IAgoraRTCClient | null = null;
  private rtm: RTMClient | null = null;
  private micTrack: IMicrophoneAudioTrack | null = null;
  private remoteAudio: IRemoteAudioTrack | null = null;
  private session: VoiceStartResponse | null = null;
  private disposed = false;
  private micMuted = false;

  private audioCtx: AudioContext;
  private smoothedAmp = 0;

  private systemPrompt: string;
  private basePrompt: string;
  private contextNotes: string[] = [];
  private initialMessage: { role: 'assistant'; content: string };
  private voiceGender: 'M' | 'F';
  private caseId: string;
  private clinicalAgents: boolean;
  private locale: string | undefined;
  private storageKey: string | null = null;

  private messageSubscribers = new Set<(msgs: ReadonlyArray<ChatMessage>) => void>();

  // Latest agent text spoken, drives the 3D face emotion.
  private currentEmotion: PatientEmotion = 'neutral';

  // Transcript assembly. Key = `${role}:${turn_id}` → index into messages.
  private turnIndex = new Map<string, number>();
  /** True once we've seen an RTM presence agent-state event. When present
   *  it is the authority for speaking → ready, because text-mode transcripts
   *  can be marked final before the TTS audio has finished. */
  private hasAgentStateFeed = false;
  private agentState: AgentState = 'idle';

  // Nurse prefilter debounce, a user turn can arrive as several finals.
  private nurseTimer: number | null = null;
  private nurseCandidate = '';
  /** Normalised typed messages sent over RTM, awaiting a possible echo. */
  private pendingTyped: string[] = [];

  constructor(
    audioCtx: AudioContext,
    listeners: ConversationListeners = {},
    options: ConversationOptions = {}
  ) {
    this.audioCtx = audioCtx;
    this.listeners = listeners;
    this.systemPrompt = options.systemPrompt ?? FALLBACK_PERSONA;
    this.basePrompt = this.systemPrompt;
    this.initialMessage = options.initialMessage ?? FALLBACK_INITIAL;
    this.voiceGender = options.voiceGender ?? 'M';
    this.caseId = options.caseId ?? 'unknown';
    this.clinicalAgents = options.clinicalAgents ?? !NON_PATIENT_SESSIONS.has(this.caseId);
    this.locale = options.locale;
    this.storageKey = options.storageKey ?? null;

    const restored = this.loadMessages();
    this.messages = restored && restored.length > 0 ? restored : [this.initialMessage];
  }

  private saveMessages() {
    if (!this.storageKey) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.messages));
    } catch { /* quota or privacy-mode, silently ignore */ }
  }

  private loadMessages(): ChatMessage[] | null {
    if (!this.storageKey) return null;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed.filter(
        (m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
      );
    } catch {
      return null;
    }
  }

  setListeners(listeners: ConversationListeners) {
    this.listeners = listeners;
  }

  getStatus(): ConversationStatus {
    return this.status;
  }

  getMessages(): ReadonlyArray<ChatMessage> {
    return [...this.messages];
  }

  subscribeMessages(fn: (msgs: ReadonlyArray<ChatMessage>) => void): () => void {
    this.messageSubscribers.add(fn);
    return () => { this.messageSubscribers.delete(fn); };
  }

  private emitMessages() {
    const snap = [...this.messages];
    this.messageSubscribers.forEach((fn) => fn(snap));
  }

  /** Live mouth amplitude from the agent's remote audio track volume.
   *  0..1, usable directly as a mouth-open factor. Cheap, safe to call
   *  every animation frame. */
  getMouthAmplitude(): number {
    const t = this.remoteAudio;
    if (!t) return 0;
    let level = 0;
    try { level = t.getVolumeLevel(); } catch { level = 0; }
    // Speech typically sits at 0.05–0.5 on Agora's scale; boost into a
    // visible mouth range, then smooth to avoid flicker.
    const target = Math.min(1, level * 2.4);
    this.smoothedAmp = this.smoothedAmp * 0.45 + target * 0.55;
    return this.smoothedAmp < 0.02 ? 0 : this.smoothedAmp;
  }

  getCurrentEmotion(): PatientEmotion {
    return this.currentEmotion;
  }

  // ── additions (non-breaking) used by the nurse agent ──────────

  /** Agora agent id for this session, or null if voice isn't live. */
  getAgentId(): string | null {
    return this.session?.agentId ?? null;
  }

  /** Agora channel identity of the live call (observer invites), or null. */
  getSessionInfo(): { appId: string; channel: string; uid: number; agentUid: number } | null {
    const s = this.session;
    return s ? { appId: s.appId, channel: s.channel, uid: s.uid, agentUid: s.agentUid } : null;
  }

  getCaseId(): string {
    return this.caseId;
  }

  /** Mute/unmute the doctor's mic without changing conversation status.
   *  Used while the nurse TTS plays so it isn't transcribed as the doctor. */
  isMicMuted(): boolean {
    return this.micMuted;
  }

  setMicMuted(muted: boolean) {
    this.micMuted = muted;
    if (this.micTrack) this.micTrack.setMuted(muted).catch(() => undefined);
  }

  /** Append a note to the patient persona (e.g. "The nurse just drew blood
   *  for a CBC") and push the updated prompt to the live agent. Also
   *  updates the prompt used by the typed-chat path. */
  async appendContextNote(note: string): Promise<void> {
    const clean = note.trim();
    if (!clean) return;
    this.contextNotes.push(clean);
    this.systemPrompt =
      `${this.basePrompt}\n\nWHAT HAS HAPPENED DURING THIS VISIT (you are aware of these; mention them naturally only if relevant):\n` +
      this.contextNotes.map((n) => `- ${n}`).join('\n');
    const agentId = this.getAgentId();
    if (!agentId) return;
    try {
      await postVoice('/voice/context', { agentId, systemPrompt: this.systemPrompt });
    } catch (err) {
      console.warn(LOG, 'context update failed:', err);
    }
  }

  private setEmotion(e: PatientEmotion) {
    if (e === this.currentEmotion) return;
    this.currentEmotion = e;
    this.listeners.onEmotion?.(e);
  }

  private setStatus(s: ConversationStatus, detail?: string) {
    this.status = s;
    this.listeners.onStatus?.(s, detail);
  }

  // ── transcript handling ──────────────────────────────────────

  private upsertTurnMessage(role: 'user' | 'assistant', turnId: unknown, text: string) {
    const key = turnId === undefined || turnId === null ? null : `${role}:${String(turnId)}`;
    const idx = key ? this.turnIndex.get(key) : undefined;
    if (idx !== undefined && this.messages[idx]?.role === role) {
      // Cumulative updates replace; segmented finals append.
      const next = mergeTurnText(this.messages[idx].content, text, role);
      this.messages[idx] = { role, content: next };
      return next;
    }
    this.messages.push({ role, content: text });
    if (key) this.turnIndex.set(key, this.messages.length - 1);
    return text;
  }

  private handleUserTranscription(msg: Extract<AgentRtmMessage, { kind: 'user' }>) {
    const { text } = msg;
    if (!msg.final) {
      this.listeners.onSubtitle?.({ who: 'you', text, partial: true });
      if (this.status !== 'listening') this.setStatus('listening');
      return;
    }
    // A typed message injected over RTM may be echoed back as a user
    // transcription, it's already in the transcript, so swallow it.
    const echoAt = this.pendingTyped.indexOf(normWords(text));
    if (echoAt >= 0) {
      this.pendingTyped.splice(echoAt, 1);
      return;
    }
    const full = this.upsertTurnMessage('user', msg.turnId, text);
    this.listeners.onSubtitle?.({ who: 'you', text: full });
    this.saveMessages();
    this.emitMessages();
    if (!this.hasAgentStateFeed || this.agentState !== 'speaking') {
      this.setStatus('thinking', 'Thinking…');
    }
    this.scheduleNurseCheck(full);
  }

  private handleAgentTranscription(msg: Extract<AgentRtmMessage, { kind: 'assistant' }>) {
    const { text } = msg;
    if (msg.turnStatus === 0) {
      this.setEmotion(detectEmotion(text));
      this.listeners.onSubtitle?.({ who: 'patient', text, partial: true });
      if (this.status !== 'speaking') this.setStatus('speaking');
      return;
    }
    // END (1) or INTERRUPTED (2)
    const full = this.upsertTurnMessage('assistant', msg.turnId, text);
    this.setEmotion(detectEmotion(full));
    this.listeners.onSubtitle?.({ who: 'patient', text: full });
    this.saveMessages();
    this.emitMessages();
    if (!this.hasAgentStateFeed) {
      this.setStatus('ready');
    } else if (this.status !== 'speaking' && this.agentState === 'speaking') {
      this.setStatus('speaking');
    }
  }

  private handleAgentState(state: string) {
    this.hasAgentStateFeed = true;
    const s = state.toLowerCase() as AgentState;
    this.agentState = s;
    if (s === 'speaking') {
      if (this.status !== 'speaking') this.setStatus('speaking');
    } else if (s === 'thinking') {
      if (this.status !== 'thinking') this.setStatus('thinking', 'Thinking…');
    } else if (s === 'listening' || s === 'idle' || s === 'silent') {
      if (this.status === 'speaking' || this.status === 'thinking') this.setStatus('ready');
    }
  }

  private handleRtmPayload(raw: string | Uint8Array) {
    const msg = decodeRtmJson(raw);
    if (!msg) return;
    voiceMetrics.ingestRtm(this.caseId, msg); // diagnostics panel + debrief stats
    const m = parseAgentMessage(msg);
    if (!m) return;
    switch (m.kind) {
      case 'user':
        this.handleUserTranscription(m);
        break;
      case 'assistant':
        this.handleAgentTranscription(m);
        break;
      case 'interrupt':
        if (this.status === 'speaking') this.setStatus('listening');
        break;
      case 'error':
        console.warn(LOG, 'agent error:', m.raw);
        break;
    }
  }

  private scheduleNurseCheck(text: string) {
    this.nurseCandidate = text;
    if (this.nurseTimer !== null) window.clearTimeout(this.nurseTimer);
    this.nurseTimer = window.setTimeout(() => {
      this.nurseTimer = null;
      const utterance = this.nurseCandidate;
      this.nurseCandidate = '';
      if (this.disposed || !utterance || !this.clinicalAgents) return;
      // Dynamic import breaks the conversation ↔ nurseAgent ↔ store cycle.
      void Promise.all([import('../agents/examAgent'), import('../agents/nurseAgent'), import('../agents/coach')])
        .then(([ex, m, coach]) => {
          if (coach.isHintRequest(utterance)) return void coach.requestHint();
          // An exam request ("let me check your abdomen") is not a nurse order.
          if (ex.maybeRunExamFromSpeech(utterance)) return;
          if (m.looksLikeOrder(utterance)) void m.runNurseAction(utterance, 'voice');
        })
        .catch((err) => console.warn(LOG, 'nurse agent load failed:', err));
    }, 700);
  }

  // ── lifecycle ────────────────────────────────────────────────

  async init() {
    if (this.status !== 'uninitialized' || this.disposed) return;
    this.setStatus('loading');
    installUnloadHook();

    try {
      this.listeners.onProgress?.('Starting voice agent…');
      const initialLine = this.initialMessage.content;
      const session = await postVoice<VoiceStartResponse>('/voice/start', {
        caseId: this.caseId,
        systemPrompt: this.systemPrompt,
        initialLine,
        gender: this.voiceGender,
        ...(this.locale ? { locale: this.locale } : {}),
      });
      if (!session || !session.appId || !session.channel || !session.token) {
        throw new VoiceBackendError('Voice backend not configured, /voice/start returned no Agora session.');
      }
      this.session = session;
      liveAgentIds.add(session.agentId);
      if (this.disposed) return this.teardown();

      // 1. RTM first so we don't miss the greeting transcript.
      this.listeners.onProgress?.('Connecting transcript channel…');
      try {
        const rtm = new AgoraRTM.RTM(session.appId, String(session.uid));
        this.rtm = rtm;
        rtm.addEventListener('message', (ev) => {
          if (ev.channelName && ev.channelName !== session.channel) return;
          this.handleRtmPayload(ev.message);
        });
        rtm.addEventListener('presence', (ev) => {
          const st = ev.stateChanged as Record<string, unknown> | null | undefined;
          if (!st || typeof st.state !== 'string') return;
          if (String(ev.publisher) !== String(session.agentUid)) {
            // The agent may publish under its own uid; accept anything
            // that isn't us.
            if (String(ev.publisher) === String(session.uid)) return;
          }
          this.handleAgentState(st.state);
        });
        await rtm.login({ token: session.token });
        if (this.disposed) return this.teardown();
        await rtm.subscribe(session.channel, { withMessage: true, withPresence: true });
      } catch (err) {
        // Transcripts are nice-to-have; audio still works without them.
        console.warn(LOG, 'RTM unavailable, continuing without transcripts:', err);
        this.listeners.onProgress?.('Transcripts unavailable, audio only.');
      }
      if (this.disposed) return this.teardown();

      // 2. RTC: join, subscribe to agent audio, publish mic.
      this.listeners.onProgress?.('Joining voice channel…');
      const rtc = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      this.rtc = rtc;
      rtc.on('user-published', async (user: IAgoraRTCRemoteUser, mediaType) => {
        if (mediaType !== 'audio') return;
        try {
          await rtc.subscribe(user, 'audio');
          const track = user.audioTrack;
          if (!track) return;
          this.remoteAudio = track;
          pendingAutoplay.add(track);
          track.play();
        } catch (err) {
          console.warn(LOG, 'subscribe failed:', err);
        }
      });
      rtc.on('user-unpublished', (user: IAgoraRTCRemoteUser, mediaType) => {
        if (mediaType === 'audio' && user.audioTrack === this.remoteAudio) {
          if (this.remoteAudio) pendingAutoplay.delete(this.remoteAudio);
          this.remoteAudio = null;
        }
      });
      rtc.on('user-left', (user: IAgoraRTCRemoteUser) => {
        if (String(user.uid) === String(session.agentUid) && !this.disposed) {
          this.remoteAudio = null;
          this.listeners.onError?.('The patient voice agent left the call. Press T to reconnect.');
          this.setStatus('error', 'agent left');
        }
      });
      rtc.on('connection-state-change', (cur) => {
        if (cur === 'DISCONNECTED' && !this.disposed && this.status !== 'error') {
          this.setStatus('uninitialized');
        }
      });

      await rtc.join(session.appId, session.channel, session.token, session.uid);
      if (this.disposed) return this.teardown();

      if (this.audioCtx.state === 'suspended') {
        try { await this.audioCtx.resume(); } catch { /* noop */ }
      }

      this.listeners.onProgress?.('Enabling microphone…');
      const mic = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
      this.micTrack = mic;
      if (this.disposed) return this.teardown();
      await rtc.publish([mic]);
      if (this.micMuted) await mic.setMuted(true);

      this.listeners.onProgress?.('Live.');
      this.setStatus('ready');

      // Placeholder until the agent's greeting transcript arrives.
      this.listeners.onSubtitle?.({ who: 'patient', text: '…' });
      this.setEmotion(detectEmotion(initialLine));
    } catch (err: any) {
      const msg =
        err instanceof VoiceBackendError
          ? err.message
          : friendlyMediaError(err) ?? (err?.message ?? String(err));
      console.error(LOG, 'init failed:', err);
      this.teardown();
      if (this.disposed) return;
      this.setStatus('error', msg);
      this.listeners.onError?.(msg);
      throw new Error(msg);
    }
  }

  /** Back-compat. Real-time means the mic is always live; this unmutes it. */
  async startListening() {
    if (this.status === 'uninitialized') return;
    this.micMuted = false;
    if (this.micTrack) {
      try { await this.micTrack.setMuted(false); } catch { /* noop */ }
    }
  }

  /** Back-compat no-op. The agent decides turn boundaries via VAD. */
  async stopListeningAndRespond() {
    /* no-op */
  }

  cancel() {
    // Best-effort: mute mic. Real-time has no abort we own client-side.
    this.micMuted = true;
    if (this.micTrack) this.micTrack.setMuted(true).catch(() => undefined);
    this.setStatus('ready');
  }

  /** Have the patient speak ONE short farewell out loud via the agent's
   *  TTS and resolve once the audio has finished (7 s hard cap). Falls back
   *  to a subtitle-only goodbye when voice isn't connected. */
  async sayFarewell(): Promise<void> {
    const line = FAREWELL_LINES[Math.floor(Math.random() * FAREWELL_LINES.length)];
    this.setStatus('thinking', 'Saying goodbye…');

    // Stop the doctor's mic so the farewell can't trigger another turn.
    this.micMuted = true;
    if (this.micTrack) {
      try { await this.micTrack.setMuted(true); } catch { /* noop */ }
    }

    const agentId = this.getAgentId();
    if (agentId && this.rtc) {
      let spoke = false;
      try {
        await postVoice('/voice/speak', { agentId, text: line, priority: 'INTERRUPT' });
        spoke = true;
      } catch (err) {
        console.warn(LOG, 'farewell speak failed:', err);
      }
      this.setEmotion(detectEmotion(line));
      this.listeners.onSubtitle?.({ who: 'patient', text: line });

      if (spoke) {
        // Wait for speaking to start, then stop. Uses both the agent-state
        // feed and the actual audio level so a missing RTM feed still works.
        const deadline = Date.now() + 7000;
        let sawSpeaking = false;
        let quietSince = 0;
        while (Date.now() < deadline) {
          const audible = this.getMouthAmplitude() > 0.04;
          const speakingNow = this.status === 'speaking' || audible;
          if (speakingNow) { sawSpeaking = true; quietSince = 0; }
          else if (sawSpeaking) {
            if (!quietSince) quietSince = Date.now();
            if (Date.now() - quietSince > 700) break;
          }
          await new Promise((r) => window.setTimeout(r, 100));
        }
        await new Promise((r) => window.setTimeout(r, 300));
      }
    } else {
      this.setEmotion(detectEmotion(line));
      this.listeners.onSubtitle?.({ who: 'patient', text: line });
      this.messages.push({ role: 'assistant', content: line });
      this.emitMessages();
    }
    // Wipe persisted history so a re-encounter with this case doesn't
    // pop the farewell as the "last assistant message" on greeting.
    if (this.storageKey) {
      try { localStorage.removeItem(this.storageKey); } catch { /* noop */ }
    }
    this.setStatus('ready');
  }

  /** Text-chat turn. When the voice agent is live, the text is injected
   *  into the agent's LLM as a user turn over RTM (peer message,
   *  customType "user.transcription"), the reply is spoken and arrives
   *  through the normal transcript path. Otherwise falls back to the
   *  backend text path (/agent/patient/stream). Typed orders also go to
   *  the nurse agent. */
  async sendTextMessage(text: string, opts?: { speak?: boolean }): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    // Accept typed text in any live state (listening/speaking/thinking are
    // normal mid-conversation); only refuse while the session is connecting.
    if (this.status === 'loading') return;

    this.listeners.onSubtitle?.({ who: 'you', text: clean });
    this.messages.push({ role: 'user', content: clean });
    this.saveMessages();
    this.emitMessages();
    this.setStatus('thinking', 'Thinking…');

    if (this.clinicalAgents) {
      void Promise.all([import('../agents/examAgent'), import('../agents/nurseAgent'), import('../agents/coach')])
        .then(([ex, m, coach]) => {
          if (coach.isHintRequest(clean)) return void coach.requestHint();
          if (ex.maybeRunExamFromSpeech(clean)) return;
          if (m.looksLikeOrder(clean)) void m.runNurseAction(clean, 'typed');
        })
        .catch(() => undefined);
    }

    const session = this.session;
    if (this.rtm && session && opts?.speak !== false) {
      this.pendingTyped.push(normWords(clean));
      try {
        await this.rtm.publish(
          String(session.agentUid),
          JSON.stringify({ priority: 'interrupted', interruptable: true, message: clean }),
          { channelType: 'USER', customType: 'user.transcription' },
        );
        return; // reply arrives via assistant.transcription
      } catch (err) {
        console.warn(LOG, 'RTM text send failed, falling back to HTTP:', err);
        this.pendingTyped.pop();
      }
    }

    const controller = new AbortController();
    let assistantText = '';
    try {
      for await (const token of streamClaude(this.systemPrompt, this.messages, controller.signal)) {
        assistantText += token;
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error(LOG, 'text-chat LLM error:', err);
        this.listeners.onError?.(`Patient reply failed: ${err?.message ?? err}`);
        this.setStatus('ready');
        return;
      }
    }

    const trimmed = assistantText.trim();
    if (trimmed) {
      this.setEmotion(detectEmotion(trimmed));
      this.listeners.onSubtitle?.({ who: 'patient', text: trimmed });
      this.messages.push({ role: 'assistant', content: trimmed });
      this.saveMessages();
      this.emitMessages();
    }
    this.setStatus('ready');
  }

  reset() {
    this.cancel();
    this.messages = [this.initialMessage];
    this.turnIndex.clear();
    this.emitMessages();
    if (this.storageKey) {
      try { localStorage.removeItem(this.storageKey); } catch { /* noop */ }
    }
  }

  /** Release Agora resources and stop the backend agent. Safe to call
   *  more than once and while init() is still in flight. */
  private teardown() {
    if (this.nurseTimer !== null) {
      window.clearTimeout(this.nurseTimer);
      this.nurseTimer = null;
    }
    if (this.micTrack) {
      try { this.micTrack.close(); } catch { /* noop */ }
      this.micTrack = null;
    }
    if (this.remoteAudio) {
      pendingAutoplay.delete(this.remoteAudio);
      try { this.remoteAudio.stop(); } catch { /* noop */ }
      this.remoteAudio = null;
    }
    if (this.rtc) {
      const rtc = this.rtc;
      this.rtc = null;
      rtc.removeAllListeners();
      rtc.leave().catch(() => undefined);
    }
    if (this.rtm) {
      const rtm = this.rtm;
      this.rtm = null;
      rtm.logout().catch(() => undefined);
    }
    if (this.session) {
      const { agentId } = this.session;
      this.session = null;
      liveAgentIds.delete(agentId);
      postVoice('/voice/stop', { agentId }, { keepalive: true }).catch(() => undefined);
    }
    this.smoothedAmp = 0;
  }

  dispose() {
    this.disposed = true;
    this.teardown();
    this.setStatus('uninitialized');
  }
}
