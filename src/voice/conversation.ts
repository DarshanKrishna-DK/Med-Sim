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
  type IRemoteVideoTrack,
} from 'agora-rtc-sdk-ng';
import AgoraRTM, { type RTMClient } from 'agora-rtm';
import { voiceMetrics } from './voiceMetrics';
import { streamClaude, type ChatMessage } from './claude';
import { decodeRtmJson, mergeTurnText, parseAgentMessage, type AgentRtmMessage } from './transcriptParser';
import { startAgentEventPoller, type AgentEvent } from '../agents/agentEvents';
import { normLang, type Lang } from '../game/lang';
import { ContextNotes } from './contextNotes';
import { farewellLine } from './lines';
import { acquireRoomAudio, holdMic, isMicHeld, isStaffEcho, noteDoctorSpeech, onMicHold, requestSpeechCancel } from './speechBus';
import { patientHears } from './router';
import { normWords } from './speechText';
import type { Handled } from './doctorUtterance';

const LOG = '[medsim:voice]';

const FALLBACK_PERSONA =
  'You are a patient speaking to a doctor. Keep replies to 1–2 short spoken sentences. ' +
  'Output spoken dialogue only, no stage directions, no asterisks, no brackets.';
const FALLBACK_INITIAL: { role: 'assistant'; content: string } = {
  role: 'assistant',
  content: 'Hi doc.',
};

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
  /** Autonomous agents: UI events their server-side tools published (whiteboard,
   *  quiz, viva mark...). Polled only while a tool-enabled session is live. */
  onAgentEvents?: (events: AgentEvent[]) => void;
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
const NON_PATIENT_SESSIONS = new Set(['teacher', 'viva-examiner', 'radiologist', 'followup-call', 'receptionist']);

/** Priya at Reception: her final transcripts and typed text go to the
 *  front-desk action agent (/agent/reception/act) instead of the nurse,
 *  unless the live agent is tool-enabled (then Priya runs the tools herself
 *  inside our custom LLM endpoint and no client trigger is needed). */
const RECEPTIONIST_SESSION = 'receptionist';

function runReceptionFromSession(utterance: string, source: 'voice' | 'typed') {
  void import('../agents/receptionAgent')
    .then((m) => {
      if (m.looksLikeReceptionRequest(utterance)) void m.runReceptionAction(utterance, source);
    })
    .catch((err) => console.warn(LOG, 'reception agent load failed:', err));
}

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
  /** Ask the backend for an Agora avatar (undefined = backend default). */
  avatar?: boolean;
  /** Custom agent start endpoint (default /voice/start). The persona then
   *  lives server-side: `startBody` is posted as is, instead of the prompt. */
  startUrl?: string;
  startBody?: Record<string, unknown>;
  /** Custom stop endpoint (default /voice/stop), posted {agentId}. */
  stopUrl?: string;
  /** Autonomous agents (receptionist / teacher / viva-examiner): what their
   *  server-side tools may act on, sent as /voice/start `agentContext`. */
  agentContext?: Record<string, unknown>;
}

interface VoiceStartResponse {
  appId: string;
  channel: string;
  uid: number;
  token: string;
  agentUid: number;
  agentId: string;
  /** Set when an Agora avatar joined the channel as a separate video user. */
  avatarUid?: number;
  avatarError?: string;
  /** True when this agent runs its own tools server-side (custom LLM route). */
  toolsEnabled?: boolean;
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

/** agentId -> stop endpoint. */
const liveAgentIds = new Map<string, string>();
let unloadHookInstalled = false;
function installUnloadHook() {
  if (unloadHookInstalled || typeof window === 'undefined') return;
  unloadHookInstalled = true;
  window.addEventListener('pagehide', () => {
    for (const [agentId, stopUrl] of liveAgentIds) {
      try {
        const blob = new Blob([JSON.stringify({ agentId })], { type: 'application/json' });
        navigator.sendBeacon(stopUrl, blob);
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

/** Level above which the agent's track counts as audible speech. */
const AUDIBLE_LEVEL = 0.03;
/** Local microphone RMS above which the doctor counts as talking. */
const DOCTOR_RMS = 0.06;
/** A turn can arrive as several finals: wait this long for the rest of it. */
const TURN_SETTLE_MS = 700;

type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'silent';

export class Conversation {
  private messages: ChatMessage[] = [];
  private listeners: ConversationListeners = {};
  private status: ConversationStatus = 'uninitialized';

  private rtc: IAgoraRTCClient | null = null;
  private rtm: RTMClient | null = null;
  private micTrack: IMicrophoneAudioTrack | null = null;
  private remoteAudio: IRemoteAudioTrack | null = null;
  private avatarAudioOn = false;
  private avatarAudio: IRemoteAudioTrack | null = null;
  private avatarVideo: IRemoteVideoTrack | null = null;
  private avatarListeners = new Set<(t: IRemoteVideoTrack | null) => void>();
  private session: VoiceStartResponse | null = null;
  private disposed = false;
  /** The user's own choice. Holds (staff voice, stethoscope) are separate, see
   *  speechBus: the mic is live only when neither closes it. */
  private userMuted = false;
  private micChain: Promise<void> = Promise.resolve();
  private stopMicHold: (() => void) | null = null;
  private farewellRelease: (() => void) | null = null;
  private patientDucked = false;
  private vad: { track: MediaStreamTrack; src: MediaStreamAudioSourceNode; node: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null = null;

  private audioCtx: AudioContext;
  private smoothedAmp = 0;

  private systemPrompt: string;
  private basePrompt: string;
  private contextNotes: ContextNotes;
  private initialMessage: { role: 'assistant'; content: string };
  private voiceGender: 'M' | 'F';
  private caseId: string;
  private clinicalAgents: boolean;
  private locale: string | undefined;
  private wantAvatar: boolean | undefined;
  private storageKey: string | null = null;
  private startUrl: string | null;
  private startBody: Record<string, unknown> | null;
  private stopUrl: string;
  private agentContext: Record<string, unknown> | null;
  private stopEvents: (() => void) | null = null;

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

  /** The doctor's turn waiting for its last segment before it is routed. */
  private pendingTurn: { text: string; turnId: string | null; timer: number } | null = null;
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
    this.wantAvatar = options.avatar;
    this.storageKey = options.storageKey ?? null;
    this.startUrl = options.startUrl ?? null;
    this.startBody = options.startBody ?? null;
    this.stopUrl = options.stopUrl ?? '/voice/stop';
    this.agentContext = options.agentContext ?? null;

    this.contextNotes = new ContextNotes({
      push: (block) => this.pushPrompt(block),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => window.clearTimeout(h as number),
    });

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

  /** Avatar video track once the avatar user publishes, else null. */
  getAvatarTrack(): IRemoteVideoTrack | null {
    return this.avatarVideo;
  }

  /** Subscribe to avatar video changes. Fires immediately with the current track. */
  onAvatarTrack(fn: (t: IRemoteVideoTrack | null) => void): () => void {
    this.avatarListeners.add(fn);
    fn(this.avatarVideo);
    return () => { this.avatarListeners.delete(fn); };
  }

  private setAvatarTrack(t: IRemoteVideoTrack | null): void {
    this.avatarVideo = t;
    this.avatarListeners.forEach((fn) => fn(t));
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

  /** True when the live agent decides on and runs its own tools (no client keyword triggers). */
  isToolEnabled(): boolean {
    return !!this.session?.toolsEnabled;
  }

  /** Update what a tool-enabled agent's tools act on (merged server-side). */
  async updateAgentContext(ctx: Record<string, unknown>): Promise<void> {
    this.agentContext = { ...(this.agentContext ?? {}), ...ctx };
    const agentId = this.getAgentId();
    if (!agentId || !this.isToolEnabled()) return;
    try {
      await postVoice('/voice/context', { agentId, agentContext: ctx });
    } catch (err) {
      console.warn(LOG, 'agent context update failed:', err);
    }
  }

  /** The user's own mute (not a temporary hold while staff speak). */
  isMicMuted(): boolean {
    return this.userMuted;
  }

  /** The user muted or unmuted themselves. Survives every staff line,
   *  stethoscope clip and voice prescription. */
  setMicMuted(muted: boolean) {
    this.userMuted = muted;
    if (muted) this.stopVad(); // muted means nothing listens, not even locally
    void this.applyMic();
  }

  /** Bring the track in line with "user muted OR held", one change at a time. */
  private applyMic(): Promise<void> {
    this.micChain = this.micChain.then(async () => {
      const track = this.micTrack;
      if (!track) return;
      try {
        const closed = this.userMuted || isMicHeld();
        await track.setMuted(closed);
        // init() may have closed the raw track before the SDK knew about it.
        if (!closed && !track.muted) track.getMediaStreamTrack().enabled = true;
      } catch (err) {
        console.warn(LOG, 'mic mute failed:', err);
      }
    });
    return this.micChain;
  }

  // ── signals for the speech arbiter ────────────────────────────

  /** The patient's voice is coming out of the speakers right now. */
  isPatientSpeaking(): boolean {
    if (!this.session) return false;
    if (this.hasAgentStateFeed ? this.agentState === 'speaking' : this.status === 'speaking') return true;
    if (!this.remoteAudio) return false;
    try {
      return this.remoteAudio.getVolumeLevel() > AUDIBLE_LEVEL;
    } catch {
      return false;
    }
  }

  /** Ask the agent to stop talking (same RTM message as Agora's toolkit). */
  interruptPatient(): void {
    const { rtm, session } = this;
    if (!rtm || !session) return;
    rtm
      .publish(String(session.agentUid), JSON.stringify({ customType: 'message.interrupt' }), {
        channelType: 'USER',
        customType: 'message.interrupt',
      })
      .catch((err: unknown) => console.warn(LOG, 'interrupt failed:', err));
  }

  /** Silence the patient's audio while an urgent staff line must be heard. */
  duckPatient(on: boolean): void {
    this.patientDucked = on;
    for (const t of [this.remoteAudio, this.avatarAudio]) {
      try {
        t?.setVolume(on ? 0 : 100);
      } catch {
        /* track gone */
      }
    }
  }

  /** Local voice activity while the published mic is held, for barge-in. Never
   *  runs while the user has muted themselves. */
  isDoctorTalking(): boolean {
    if (this.userMuted || !isMicHeld() || !this.micTrack) return false;
    try {
      if (!this.vad) {
        const track = this.micTrack.getMediaStreamTrack().clone();
        track.enabled = true; // the original is disabled by the hold
        const src = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
        const node = this.audioCtx.createAnalyser();
        node.fftSize = 1024;
        src.connect(node);
        this.vad = { track, src, node, buf: new Float32Array(node.fftSize) };
      }
      const { node, buf } = this.vad;
      node.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      return Math.sqrt(sum / buf.length) > DOCTOR_RMS;
    } catch {
      return false;
    }
  }

  private stopVad() {
    const v = this.vad;
    if (!v) return;
    this.vad = null;
    try {
      v.src.disconnect();
      v.track.stop();
    } catch {
      /* noop */
    }
  }

  /** Append a note to the patient persona ("The doctor has ordered some
   *  tests") and push the updated prompt to the live agent. Also updates the
   *  prompt used by the typed-chat path. Notes are coalesced and bounded, and
   *  never carry results or verdicts (contextNotes.ts). */
  async appendContextNote(note: string): Promise<void> {
    await this.contextNotes.add(note);
  }

  /** Prompt with every note so far, even one not pushed yet. */
  private promptNow(): string {
    const block = this.contextNotes.block();
    return block ? `${this.basePrompt}\n\n${block}` : this.basePrompt;
  }

  private async pushPrompt(block: string): Promise<void> {
    this.systemPrompt = block ? `${this.basePrompt}\n\n${block}` : this.basePrompt;
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
    // A staff voice that leaked back through the mic is not the doctor.
    const echo = isStaffEcho(text);
    if (!echo) noteDoctorSpeech(); // barge-in: staff stop or duck
    if (!msg.final) {
      if (echo) return;
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
    if (echo) return;
    const full = this.upsertTurnMessage('user', msg.turnId, text);
    this.listeners.onSubtitle?.({ who: 'you', text: full });
    this.saveMessages();
    this.emitMessages();
    if (!this.hasAgentStateFeed || this.agentState !== 'speaking') {
      this.setStatus('thinking', 'Thinking…');
    }
    this.scheduleRouting(full, msg.turnId);
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

  /** Let a segmented turn settle, then route it once. A new turn routes the
   *  previous one at once instead of replacing it. */
  private scheduleRouting(text: string, turnId: string | null) {
    const prev = this.pendingTurn;
    if (prev) {
      window.clearTimeout(prev.timer);
      if (prev.turnId !== turnId || turnId === null) void this.routeTurn(prev.text, prev.turnId);
    }
    const timer = window.setTimeout(() => {
      this.pendingTurn = null;
      void this.routeTurn(text, turnId);
    }, TURN_SETTLE_MS);
    this.pendingTurn = { text, turnId, timer };
  }

  private async routeTurn(text: string, turnId: string | null): Promise<void> {
    if (this.disposed || !text) return;
    if (this.caseId === RECEPTIONIST_SESSION) {
      // Tool-enabled Priya acts on her own inside the call; the keyword
      // trigger is only the fallback when the proxy route is unavailable.
      if (!this.isToolEnabled()) runReceptionFromSession(text, 'voice');
      return;
    }
    if (!this.clinicalAgents) return;
    // Turn numbers restart with every agent, so the agent is part of the id.
    const h = await this.route(text, 'voice', turnId === null ? null : `${this.getAgentId() ?? ''}:${turnId}`);
    // Not for the patient: without a state feed nothing else ends "thinking".
    if (h && !patientHears(h.route) && !this.hasAgentStateFeed && this.status === 'thinking') this.setStatus('ready');
  }

  /** Dynamic import breaks the conversation, nurse agent and store cycle. */
  private async route(text: string, source: 'voice' | 'typed', turnId: string | null): Promise<Handled | null> {
    try {
      const m = await import('./doctorUtterance');
      return await m.handleDoctorUtterance(text, source, { turnId });
    } catch (err) {
      console.warn(LOG, 'routing failed:', err);
      return null;
    }
  }

  // ── lifecycle ────────────────────────────────────────────────

  async init() {
    if (this.status !== 'uninitialized' || this.disposed) return;
    this.setStatus('loading');
    installUnloadHook();
    this.stopMicHold ??= onMicHold(() => void this.applyMic());

    try {
      this.listeners.onProgress?.('Starting voice agent…');
      const initialLine = this.initialMessage.content;
      const startUrl = this.startUrl ?? '/voice/start';
      const session = await postVoice<VoiceStartResponse>(
        startUrl,
        this.startUrl
          ? (this.startBody ?? {})
          : {
              caseId: this.caseId,
              systemPrompt: this.systemPrompt,
              initialLine,
              gender: this.voiceGender,
              ...(this.locale ? { locale: this.locale } : {}),
              ...(this.wantAvatar !== undefined ? { avatar: this.wantAvatar } : {}),
              ...(this.agentContext ? { agentContext: this.agentContext } : {}),
            },
      );
      if (!session || !session.appId || !session.channel || !session.token) {
        throw new VoiceBackendError(`Voice backend not configured, ${startUrl} returned no Agora session.`);
      }
      this.session = session;
      liveAgentIds.set(session.agentId, this.stopUrl);
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
        if (mediaType === 'video') {
          if (session.avatarUid == null || String(user.uid) !== String(session.avatarUid)) return;
          try {
            await rtc.subscribe(user, 'video');
            if (user.videoTrack) this.setAvatarTrack(user.videoTrack);
          } catch (err) {
            console.warn(LOG, 'avatar video subscribe failed:', err);
          }
          return;
        }
        if (mediaType !== 'audio') return;
        try {
          await rtc.subscribe(user, 'audio');
          const track = user.audioTrack;
          if (!track) return;
          const isAvatar = session.avatarUid != null && String(user.uid) === String(session.avatarUid);
          if (isAvatar) {
            // The avatar re-publishes the agent's voice in sync with its lips:
            // play that one and silence the agent's own stream (no double audio).
            if (this.remoteAudio) {
              try { this.remoteAudio.stop(); } catch { /* noop */ }
              pendingAutoplay.delete(this.remoteAudio);
            }
            this.avatarAudioOn = true;
            this.avatarAudio = track;
            if (this.patientDucked) track.setVolume(0);
            pendingAutoplay.add(track);
            track.play();
            return;
          }
          this.remoteAudio = track;
          if (this.patientDucked) track.setVolume(0);
          if (this.avatarAudioOn) return;
          pendingAutoplay.add(track);
          track.play();
        } catch (err) {
          console.warn(LOG, 'subscribe failed:', err);
        }
      });
      rtc.on('user-unpublished', (user: IAgoraRTCRemoteUser, mediaType) => {
        if (mediaType === 'video' && user.videoTrack === this.avatarVideo) this.setAvatarTrack(null);
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
      // Closed from the first packet when the user is muted or staff are
      // talking (a reconnect in the middle of a line).
      if (this.userMuted || isMicHeld()) mic.getMediaStreamTrack().enabled = false;
      await rtc.publish([mic]);
      await this.applyMic();
      if (this.disposed) return this.teardown();

      this.listeners.onProgress?.('Live.');
      this.setStatus('ready');
      if (session.toolsEnabled && this.listeners.onAgentEvents) {
        this.stopEvents = startAgentEventPoller(session.channel, (evs) => {
          if (!this.disposed) this.listeners.onAgentEvents?.(evs);
        });
      }

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
    this.userMuted = false;
    await this.applyMic();
  }

  /** Back-compat no-op. The agent decides turn boundaries via VAD. */
  async stopListeningAndRespond() {
    /* no-op */
  }

  cancel() {
    // Best-effort: mute mic. Real-time has no abort we own client-side.
    this.setMicMuted(true);
    this.setStatus('ready');
  }

  /** Have the patient speak ONE short farewell out loud via the agent's
   *  TTS and resolve once the audio has finished (7 s hard cap). Falls back
   *  to a subtitle-only goodbye when voice isn't connected. */
  async sayFarewell(): Promise<void> {
    const lang: Lang = normLang(this.locale?.slice(0, 2));
    const line = farewellLine(lang, this.voiceGender);
    this.setStatus('thinking', 'Saying goodbye…');

    // Nobody else speaks over the goodbye, and the doctor's mic is held (not
    // muted) until this conversation is torn down, so it can't start a turn.
    requestSpeechCancel('consultation ended');
    if (!this.farewellRelease) {
      const releaseRoom = acquireRoomAudio('farewell');
      const releaseMic = holdMic();
      this.farewellRelease = () => {
        releaseMic();
        releaseRoom();
      };
    }
    if (this.pendingTurn) {
      window.clearTimeout(this.pendingTurn.timer);
      this.pendingTurn = null;
    }
    this.duckPatient(false);
    await this.applyMic();

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

    // Typed text over RTM reaches a tool-enabled Priya as a normal turn: she acts herself.
    const viaLiveAgent = !!(this.rtm && this.session && opts?.speak !== false);
    if (this.caseId === RECEPTIONIST_SESSION && !(viaLiveAgent && this.isToolEnabled())) runReceptionFromSession(clean, 'typed');
    if (this.clinicalAgents) {
      const handled = await this.route(clean, 'typed', null);
      if (this.disposed) return;
      // Said to staff, so the patient has nothing to answer. An examination is
      // said to the patient too.
      if (handled && !patientHears(handled.route)) {
        this.setStatus('ready');
        return;
      }
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
      for await (const token of streamClaude(this.promptNow(), this.messages, controller.signal)) {
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
    if (this.stopEvents) {
      this.stopEvents();
      this.stopEvents = null;
    }
    if (this.pendingTurn) {
      window.clearTimeout(this.pendingTurn.timer);
      this.pendingTurn = null;
    }
    this.stopVad();
    this.stopMicHold?.();
    this.stopMicHold = null;
    this.farewellRelease?.();
    this.farewellRelease = null;
    this.patientDucked = false;
    this.avatarAudio = null;
    if (this.micTrack) {
      try { this.micTrack.close(); } catch { /* noop */ }
      this.micTrack = null;
    }
    if (this.avatarVideo) {
      try { this.avatarVideo.stop(); } catch { /* noop */ }
      this.setAvatarTrack(null);
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
      postVoice(this.stopUrl, { agentId }, { keepalive: true }).catch(() => undefined);
    }
    this.smoothedAmp = 0;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // Hang-up, End, next patient, language switch: staff stop mid-word too.
    if (this.clinicalAgents) requestSpeechCancel('conversation ended');
    this.contextNotes.close();
    this.teardown();
    this.setStatus('uninitialized');
  }
}
