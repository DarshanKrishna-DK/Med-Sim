/**
 * Faculty side of the live observer. Joins the consultation's Agora RTC
 * channel as an AUDIENCE member (no mic, cannot publish; the backend token
 * has no publish privileges either), plays the student's and the AI
 * patient's audio, and reads the same RTM channel for the ConvoAI transcript
 * and the student's `medsim.event` chart feed. Whispers and marks go to the
 * student's link uid as RTM USER messages.
 */

import AgoraRTC, { type IAgoraRTCClient, type IAgoraRTCRemoteUser, type IRemoteAudioTrack } from 'agora-rtc-sdk-ng';
import AgoraRTM, { type RTMClient } from 'agora-rtm';
import { decodeRtmJson, parseAgentMessage, TranscriptAssembler, type TranscriptLine } from '../voice/transcriptParser';
import {
  encodeMedsim,
  isForMe,
  LIMITS,
  newMessageId,
  parseMedsimMessage,
  type ChartEvent,
  type FacultyMarks,
  type MarkDomain,
  type MedsimMessage,
} from './messages';

import type { RoomSummary } from '../room/reducer';

const LOG = '[medsim:observer]';

export interface ObserverJoin {
  appId: string;
  channel: string;
  uid: number;
  token: string;
  role: string;
  caseId: string;
  studentUid: number;
  linkUid: number;
  agentUid: number;
  expiresAt: number;
}

export interface SentNote {
  id: string;
  text: string;
  at: number;
  delivered: boolean;
}

export interface ObserverView {
  phase: 'idle' | 'joining' | 'live' | 'ended' | 'error';
  error: string;
  caseId: string;
  caseLabel: string;
  osce: boolean;
  startedAt: number;
  expiresAt: number;
  lines: TranscriptLine[];
  events: ChartEvent[];
  /** The student's BAND Agent Room, read only. */
  room: RoomSummary | null;
  studentInCall: boolean;
  patientInCall: boolean;
  /** The student's MedSim tab is connected (it relays whispers and marks). */
  studentOnline: boolean;
  /** Snapshot (case label, earlier transcript) received. */
  synced: boolean;
  whispers: SentNote[];
  marks: { id: string; sentAt: number; delivered: boolean } | null;
  /** 'audience' = live profile audience role; 'listen-only' = fallback. */
  audioMode: 'audience' | 'listen-only' | '';
}

const INITIAL: ObserverView = {
  phase: 'idle',
  error: '',
  caseId: '',
  caseLabel: '',
  osce: false,
  startedAt: 0,
  expiresAt: 0,
  lines: [],
  events: [],
  room: null,
  studentInCall: false,
  patientInCall: false,
  studentOnline: false,
  synced: false,
  whispers: [],
  marks: null,
  audioMode: '',
};

function forcedMode(): 'rtc' | null {
  try {
    return new URLSearchParams(window.location.search).get('rtc') === 'rtc' ? 'rtc' : null;
  } catch {
    return null;
  }
}

try { AgoraRTC.setLogLevel(2); } catch { /* noop */ }

function friendlyJoinError(status: number, detail: string): string {
  if (status === 404) return 'This observer link is invalid or has expired. Ask the student for a new one.';
  if (status === 429) return 'This observer link has been used too many times. Ask the student for a new one.';
  if (status === 401) return 'Open the link on the same MedSim site the student is using.';
  if (status === 503) return 'Voice is not configured on this MedSim server.';
  return detail || `Could not join (${status}).`;
}

export class ObserverSession {
  private view: ObserverView = INITIAL;
  private listeners = new Set<() => void>();
  private rtc: IAgoraRTCClient | null = null;
  private rtm: RTMClient | null = null;
  private tracks = new Map<string, IRemoteAudioTrack>();
  private assembler = new TranscriptAssembler();
  private join: ObserverJoin | null = null;
  private helloTimer: number | null = null;
  private fallbackTimer: number | null = null;
  private examiner = '';
  private closed = false;

  getView = (): ObserverView => this.view;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<ObserverView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** 0..1 speaking level for the student or the AI patient. */
  level(who: 'student' | 'patient'): number {
    const j = this.join;
    if (!j) return 0;
    const t = this.tracks.get(String(who === 'student' ? j.studentUid : j.agentUid));
    if (!t) return 0;
    try {
      return Math.min(1, t.getVolumeLevel() * 2.4);
    } catch {
      return 0;
    }
  }

  /** Must run inside a click (autoplay policy for the remote audio). */
  async start(code: string, examiner: string) {
    if (this.view.phase === 'joining' || this.view.phase === 'live') return;
    this.examiner = examiner.trim().slice(0, LIMITS.examiner);
    this.closed = false;
    this.set({ ...INITIAL, phase: 'joining' });
    try {
      const r = await fetch('/voice/observer/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) {
        let detail = '';
        try { detail = ((await r.json()) as { detail?: string }).detail ?? ''; } catch { /* non-JSON */ }
        throw new Error(friendlyJoinError(r.status, detail));
      }
      const j = (await r.json()) as ObserverJoin;
      this.join = j;
      this.set({ caseId: j.caseId, caseLabel: j.caseId, expiresAt: j.expiresAt });
      if (this.closed) return;
      await this.startRtm(j);
      if (this.closed) return;
      await this.startRtc(j);
      if (this.closed) return;
      this.set({ phase: 'live' });
    } catch (err) {
      console.warn(LOG, 'join failed:', err);
      this.teardown();
      this.set({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async startRtm(j: ObserverJoin) {
    const rtm = new AgoraRTM.RTM(j.appId, String(j.uid));
    this.rtm = rtm;
    const self = String(j.uid);
    const link = String(j.linkUid);
    rtm.addEventListener('message', (ev) => {
      if (ev.channelType !== 'USER' && ev.channelName !== j.channel) return;
      if (String(ev.publisher) === self) return;
      const obj = decodeRtmJson(ev.message);
      const agent = parseAgentMessage(obj);
      if (agent) {
        if (this.assembler.apply(agent)) this.set({ lines: this.assembler.lines() });
        return;
      }
      const m = parseMedsimMessage(obj);
      if (m && isForMe(m, self, ev.channelType)) this.onMedsim(m);
    });
    rtm.addEventListener('presence', (ev) => {
      if (ev.channelName !== j.channel) return;
      if (ev.eventType === 'SNAPSHOT') {
        this.set({ studentOnline: (ev.snapshot ?? []).some((u) => String(u.userId) === link) });
      } else if (String(ev.publisher) === link) {
        if (ev.eventType === 'REMOTE_JOIN') {
          this.set({ studentOnline: true });
          this.sayHello();
        } else if (ev.eventType === 'REMOTE_LEAVE' || ev.eventType === 'REMOTE_TIMEOUT') {
          this.set({ studentOnline: false });
        }
      }
    });
    await rtm.login({ token: j.token });
    await rtm.subscribe(j.channel, { withMessage: true, withPresence: true });
    // Ask the student's tab for the story so far; repeat until it answers.
    let tries = 0;
    this.sayHello();
    this.helloTimer = window.setInterval(() => {
      if (this.view.synced || ++tries > 6) {
        if (this.helloTimer !== null) window.clearInterval(this.helloTimer);
        this.helloTimer = null;
        return;
      }
      this.sayHello();
    }, 5000);
  }

  private sayHello() {
    void this.sendToStudent({ object: 'medsim.hello', examiner: this.examiner });
  }

  /** Live-broadcast profile, audience role: subscribe only, no mic is ever
   *  opened. If nobody shows up in the audience view while the student's
   *  side is clearly active, retry once in the communication profile the
   *  student uses (still subscribe-only: this client never creates a mic
   *  track, and the token carries no publish privilege). `?rtc=rtc` forces it. */
  private async startRtc(j: ObserverJoin, mode: 'live' | 'rtc' = forcedMode() ?? 'live') {
    const rtc = mode === 'live'
      ? AgoraRTC.createClient({ mode: 'live', codec: 'vp8', role: 'audience' })
      : AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    this.rtc = rtc;
    let sawUser = false;
    rtc.on('user-joined', () => { sawUser = true; });
    const isStudent = (u: IAgoraRTCRemoteUser) => String(u.uid) === String(j.studentUid);
    const isPatient = (u: IAgoraRTCRemoteUser) => String(u.uid) === String(j.agentUid);
    rtc.on('user-joined', (u: IAgoraRTCRemoteUser) => {
      if (isStudent(u)) this.set({ studentInCall: true });
      if (isPatient(u)) this.set({ patientInCall: true });
    });
    rtc.on('user-left', (u: IAgoraRTCRemoteUser) => {
      const key = String(u.uid);
      this.tracks.get(key)?.stop();
      this.tracks.delete(key);
      if (isStudent(u)) this.set({ studentInCall: false });
      if (isPatient(u)) this.set({ patientInCall: false });
    });
    rtc.on('user-published', async (u: IAgoraRTCRemoteUser, mediaType) => {
      if (mediaType !== 'audio') return;
      try {
        await rtc.subscribe(u, 'audio');
        const t = u.audioTrack;
        if (!t) return;
        this.tracks.set(String(u.uid), t);
        t.play();
        if (isStudent(u)) this.set({ studentInCall: true });
        if (isPatient(u)) this.set({ patientInCall: true });
      } catch (err) {
        console.warn(LOG, 'subscribe failed:', err);
      }
    });
    rtc.on('user-unpublished', (u: IAgoraRTCRemoteUser, mediaType) => {
      if (mediaType !== 'audio') return;
      this.tracks.delete(String(u.uid));
    });
    rtc.on('token-privilege-did-expire', () => {
      this.teardown();
      this.set({ phase: 'ended', error: 'The observer link expired.' });
    });
    await rtc.join(j.appId, j.channel, j.token, j.uid);
    this.set({ audioMode: mode === 'live' ? 'audience' : 'listen-only' });
    if (mode === 'live' && !forcedMode()) {
      this.fallbackTimer = window.setTimeout(() => {
        this.fallbackTimer = null;
        if (this.closed || this.rtc !== rtc || sawUser) return;
        if (!this.view.studentOnline && this.view.lines.length === 0) return;
        console.warn(LOG, 'no remote users visible as audience; rejoining in the communication profile (still listen-only)');
        rtc.removeAllListeners();
        void rtc.leave().catch(() => undefined).then(() => (this.closed ? undefined : this.startRtc(j, 'rtc'))).catch((err) => {
          console.warn(LOG, 'listen-only rejoin failed:', err);
        });
      }, 7000);
    }
  }

  private onMedsim(m: MedsimMessage) {
    switch (m.object) {
      case 'medsim.event':
        this.set({ events: [...this.view.events, ...m.events].slice(-300) });
        break;
      case 'medsim.room':
        this.set({ room: m.room });
        break;
      case 'medsim.snapshot': {
        if (this.view.synced) break;
        const seeded = this.assembler.seed(m.transcript);
        this.set({
          synced: true,
          studentOnline: true,
          caseLabel: m.caseLabel || this.view.caseLabel,
          osce: m.osce,
          ...(m.room && !this.view.room ? { room: m.room } : {}),
          startedAt: m.startedAt,
          // Live events that raced the snapshot come after it.
          events: [...m.events, ...this.view.events.filter((e) => !m.events.some((s) => s.label === e.label && s.at === e.at))],
          ...(seeded ? { lines: this.assembler.lines() } : {}),
        });
        break;
      }
      case 'medsim.ack':
        if (m.what === 'whisper') {
          this.set({ whispers: this.view.whispers.map((w) => (w.id === m.id ? { ...w, delivered: true } : w)) });
        } else if (this.view.marks?.id === m.id) {
          this.set({ marks: { ...this.view.marks, delivered: true } });
        }
        break;
      default:
        break;
    }
  }

  private async sendToStudent(m: MedsimMessage): Promise<boolean> {
    const j = this.join;
    const rtm = this.rtm;
    if (!j || !rtm) return false;
    const to = String(j.linkUid);
    try {
      await rtm.publish(to, encodeMedsim(m), { channelType: 'USER', customType: m.object });
      return true;
    } catch (err) {
      console.warn(LOG, 'USER publish failed, using a targeted channel message:', err);
      try {
        await rtm.publish(j.channel, encodeMedsim({ ...m, to } as MedsimMessage), { customType: m.object });
        return true;
      } catch {
        return false;
      }
    }
  }

  async sendWhisper(text: string): Promise<boolean> {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, LIMITS.whisper);
    if (!clean) return false;
    const note: SentNote = { id: newMessageId(), text: clean, at: Date.now(), delivered: false };
    this.set({ whispers: [...this.view.whispers, note].slice(-20) });
    const ok = await this.sendToStudent({ object: 'medsim.whisper', id: note.id, text: clean, examiner: this.examiner, at: note.at });
    if (!ok) this.set({ whispers: this.view.whispers.filter((w) => w.id !== note.id) });
    return ok;
  }

  async sendMarks(scores: Record<MarkDomain, number>, comment: string): Promise<boolean> {
    const marks: FacultyMarks = {
      // Same id on a resend, so the student replaces rather than duplicates.
      id: this.view.marks?.id ?? newMessageId(),
      caseId: this.view.caseId,
      scores,
      comment: comment.trim().slice(0, LIMITS.comment),
      examiner: this.examiner,
      sentAt: Date.now(),
    };
    this.set({ marks: { id: marks.id, sentAt: marks.sentAt, delivered: false } });
    return this.sendToStudent({ object: 'medsim.marks', marks });
  }

  private teardown() {
    if (this.helloTimer !== null) window.clearInterval(this.helloTimer);
    this.helloTimer = null;
    if (this.fallbackTimer !== null) window.clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
    for (const t of this.tracks.values()) {
      try { t.stop(); } catch { /* noop */ }
    }
    this.tracks.clear();
    const rtc = this.rtc;
    this.rtc = null;
    if (rtc) {
      rtc.removeAllListeners();
      rtc.leave().catch(() => undefined);
    }
    const rtm = this.rtm;
    this.rtm = null;
    if (rtm) rtm.logout().catch(() => undefined);
  }

  leave() {
    this.closed = true;
    this.teardown();
    if (this.view.phase !== 'idle') this.set({ phase: 'ended' });
  }
}
