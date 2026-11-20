/**
 * Voice engine diagnostics. Parses the Agora Conversational AI runtime
 * messages that arrive over RTM and turns them into per-turn latency numbers.
 *
 * Wire formats (agora-agent-client-toolkit 2.10 source, join parameters
 * `enable_metrics` / `enable_error_message`, `data_channel: "rtm"`):
 *   { object: "message.metrics", module: "asr"|"llm"|"mllm"|"tts"|"context",
 *     metric_name: "asr_ttlw"|"llm_ttfb"|"llm_ttfs"|"tts_ttfb", latency_ms, send_ts, turn_id? }
 *   { object: "message.error", module, code, message, send_ts }
 *   { object: "message.interrupt", turn_id, start_ms }
 *   { object: "user.transcription", text, final, turn_id }
 *   { object: "assistant.transcription", text, turn_status: 0|1|2, turn_id }
 *
 * Anything Agora does not send is measured in the browser from transcript
 * timestamps and flagged as such. Pure module: no DOM, no React.
 */

export type MetricSource = 'agora' | 'browser' | 'estimated';

export interface TurnStats {
  n: number;
  openedAt: number;
  userFinalAt: number | null;
  lastUserPartialAt: number | null;
  firstAgentAt: number | null;
  asrMs: number | null;
  asrSource: MetricSource | null;
  llmMs: number | null;
  llmSentenceMs: number | null;
  ttsMs: number | null;
  e2eMs: number | null;
  e2eSource: MetricSource | null;
  interrupts: number;
  fillers: number;
}

export interface VoiceError {
  module: string;
  code: number;
  message: string;
  at: number;
}

export interface VoiceStatsSummary {
  turns: number;
  avgE2eMs: number | null;
  avgAsrMs: number | null;
  avgLlmMs: number | null;
  avgTtsMs: number | null;
  interruptions: number;
  fillers: number;
  errors: number;
}

export type ParsedRtm =
  | { kind: 'metric'; module: string; name: string; valueMs: number; turnId?: number | string }
  | { kind: 'error'; module: string; code: number; message: string }
  | { kind: 'interrupt'; turnId?: number | string }
  | { kind: 'userTranscript'; text: string; final: boolean; turnId?: number | string }
  | { kind: 'agentTranscript'; text: string; status: number; turnId?: number | string };

const MODULES = new Set(['asr', 'llm', 'mllm', 'tts', 'context', 'unknown']);

function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function idOf(v: unknown): number | string | undefined {
  return typeof v === 'number' || typeof v === 'string' ? v : undefined;
}

/** Parse one decoded RTM JSON object. Returns null for anything else. */
export function parseAgoraRtm(msg: unknown): ParsedRtm | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  switch (m.object) {
    case 'message.metrics': {
      const module = typeof m.module === 'string' ? m.module.toLowerCase() : '';
      const name = typeof m.metric_name === 'string' ? m.metric_name.toLowerCase() : '';
      const valueMs = num(m.latency_ms);
      if (!MODULES.has(module) || !name || valueMs === null) return null;
      return { kind: 'metric', module, name, valueMs, turnId: idOf(m.turn_id) };
    }
    case 'message.error': {
      const module = typeof m.module === 'string' ? m.module.toLowerCase() : 'unknown';
      return {
        kind: 'error',
        module,
        code: num(m.code) ?? -1,
        message: typeof m.message === 'string' ? m.message : '',
      };
    }
    case 'message.interrupt':
      return { kind: 'interrupt', turnId: idOf(m.turn_id) };
    case 'user.transcription': {
      const text = typeof m.text === 'string' ? m.text.trim() : '';
      if (!text) return null;
      return { kind: 'userTranscript', text, final: m.final === true || m.final === 'true', turnId: idOf(m.turn_id) };
    }
    case 'assistant.transcription': {
      const text = typeof m.text === 'string' ? m.text.trim() : '';
      if (!text) return null;
      return { kind: 'agentTranscript', text, status: num(m.turn_status) ?? 1, turnId: idOf(m.turn_id) };
    }
    default:
      return null;
  }
}

// Static filler phrases the backend asks Agora to play (backend/lang.py FILLERS).
const FILLER_PHRASES = [
  'Hmm...', 'Haan, doctor...', 'Umm, let me think...', 'Achha...', 'One second, doctor...',
  'Hmm, let me see...', 'Okay, doctor...', 'Umm... yes...',
  'हम्म...', 'हाँ डॉक्टर...', 'एक मिनट...', 'अच्छा...', 'हम्म, देखिए...', 'जी डॉक्टर...',
  'एक सेकंड डॉक्टर...', 'हाँ... जी...',
  'ಹ್ಮ್...', 'ಹೌದು ಡಾಕ್ಟರ್...', 'ಒಂದು ನಿಮಿಷ...', 'ಅಚ್ಛಾ...', 'ಹ್ಮ್, ನೋಡಿ...', 'ಸರಿ ಡಾಕ್ಟರ್...',
  'ಒಂದು ಸೆಕೆಂಡ್ ಡಾಕ್ಟರ್...', 'ಹೌದು... ಹೌದು...',
];
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const FILLER_SET = new Set(FILLER_PHRASES.map(norm));

export function isFillerText(text: string): boolean {
  return FILLER_SET.has(norm(text));
}

const blankTurn = (n: number, at: number): TurnStats => ({
  n, openedAt: at, userFinalAt: null, lastUserPartialAt: null, firstAgentAt: null,
  asrMs: null, asrSource: null, llmMs: null, llmSentenceMs: null, ttsMs: null,
  e2eMs: null, e2eSource: null, interrupts: 0, fillers: 0,
});

const avg = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

/** Per-session (per case) tracker. Time is injected so tests are deterministic. */
export class VoiceMetricsTracker {
  turns: TurnStats[] = [];
  errors: VoiceError[] = [];
  interruptions = 0;
  fillers = 0;
  agoraMetricsSeen = false;
  private seenInterrupts = new Set<string>();
  private seenFillers = new Set<string>();
  private counter = 0;

  private last(): TurnStats | undefined {
    return this.turns[this.turns.length - 1];
  }
  private open(at: number): TurnStats {
    const t = blankTurn(++this.counter, at);
    this.turns.push(t);
    if (this.turns.length > 60) this.turns.shift();
    return t;
  }
  /** The turn still waiting for its agent reply, if any. */
  private pending(): TurnStats | undefined {
    const l = this.last();
    return l && l.ttsMs === null && l.firstAgentAt === null ? l : undefined;
  }

  private finishE2e(t: TurnStats) {
    if (t.userFinalAt !== null && t.firstAgentAt !== null) {
      t.e2eMs = Math.max(0, t.firstAgentAt - t.userFinalAt);
      t.e2eSource = 'browser';
    } else if (t.e2eMs === null && t.userFinalAt !== null && t.ttsMs !== null && (t.llmMs !== null || t.llmSentenceMs !== null)) {
      t.e2eMs = (t.asrMs ?? 0) + (t.llmMs ?? t.llmSentenceMs ?? 0) + t.ttsMs;
      t.e2eSource = 'estimated';
    }
  }

  ingest(p: ParsedRtm, now: number): void {
    switch (p.kind) {
      case 'userTranscript': {
        if (!p.final) {
          let t = this.pending();
          if (!t || t.userFinalAt !== null) t = this.open(now);
          t.lastUserPartialAt = now;
          return;
        }
        let t = this.pending();
        if (!t || t.userFinalAt !== null) t = this.open(now);
        t.userFinalAt = now;
        if (t.asrMs === null && t.lastUserPartialAt !== null) {
          t.asrMs = Math.max(0, now - t.lastUserPartialAt);
          t.asrSource = 'browser';
        }
        this.finishE2e(t);
        return;
      }
      case 'metric': {
        this.agoraMetricsSeen = true;
        // asr_ttlw can precede the transcript; llm/tts metrics belong to the pending turn.
        const l = this.last();
        // tts_ttfb is the last metric of a turn and can land after the first transcript.
        const reuse = l && l.ttsMs === null && !(p.module === 'asr' && (l.asrSource === 'agora' || l.firstAgentAt !== null));
        const t = reuse ? l : this.open(now);
        if (p.module === 'asr') {
          t.asrMs = p.valueMs;
          t.asrSource = 'agora';
        } else if (p.module === 'llm' || p.module === 'mllm') {
          if (p.name.includes('ttfs')) t.llmSentenceMs = p.valueMs;
          else t.llmMs = p.valueMs;
        } else if (p.module === 'tts') {
          t.ttsMs = p.valueMs;
        }
        this.finishE2e(t);
        return;
      }
      case 'agentTranscript': {
        const filler = isFillerText(p.text);
        if (filler) {
          const key = `${p.turnId ?? ''}|${norm(p.text)}`;
          if (!this.seenFillers.has(key)) {
            this.seenFillers.add(key);
            this.fillers += 1;
            (this.last() ?? this.open(now)).fillers += 1;
          }
        }
        if (p.status === 2) this.countInterrupt(p.turnId, now);
        if (filler) return;
        const t = this.last();
        if (t && t.userFinalAt !== null && t.firstAgentAt === null) {
          t.firstAgentAt = now;
          this.finishE2e(t);
        }
        return;
      }
      case 'interrupt':
        this.countInterrupt(p.turnId, now);
        return;
      case 'error':
        this.errors.push({ module: p.module, code: p.code, message: p.message, at: now });
        if (this.errors.length > 20) this.errors.shift();
        return;
    }
  }

  private countInterrupt(turnId: number | string | undefined, now: number) {
    // message.interrupt and a status-2 transcript both describe the same barge-in.
    const key = turnId === undefined ? `t${now}` : `i${turnId}`;
    if (this.seenInterrupts.has(key)) return;
    this.seenInterrupts.add(key);
    this.interruptions += 1;
    (this.last() ?? this.open(now)).interrupts += 1;
  }

  /** Turns with a user utterance and a measured response time. */
  answered(): TurnStats[] {
    return this.turns.filter((t) => t.e2eMs !== null);
  }

  summary(): VoiceStatsSummary {
    const done = this.answered();
    return {
      turns: done.length,
      avgE2eMs: avg(done.map((t) => t.e2eMs)),
      avgAsrMs: avg(this.turns.map((t) => t.asrMs)),
      avgLlmMs: avg(this.turns.map((t) => t.llmMs ?? t.llmSentenceMs)),
      avgTtsMs: avg(this.turns.map((t) => t.ttsMs)),
      interruptions: this.interruptions,
      fillers: this.fillers,
      errors: this.errors.length,
    };
  }
}

/** "1.4 s" style label. */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

// App-wide registry (one tracker per case id)

export interface VoiceMetricsSnapshot {
  version: number;
  caseId: string | null;
  tracker: VoiceMetricsTracker | null;
}

class VoiceMetricsRegistry {
  private trackers = new Map<string, VoiceMetricsTracker>();
  private version = 0;
  private snap: VoiceMetricsSnapshot = { version: 0, caseId: null, tracker: null };
  private subs = new Set<() => void>();

  /** Feed one decoded RTM object for a case. Cheap no-op for unrelated messages. */
  ingestRtm(caseId: string, msg: unknown, now: number = Date.now()): void {
    const p = parseAgoraRtm(msg);
    if (!p) return;
    let t = this.trackers.get(caseId);
    if (!t) {
      t = new VoiceMetricsTracker();
      this.trackers.set(caseId, t);
    }
    t.ingest(p, now);
    this.version += 1;
    this.snap = { version: this.version, caseId, tracker: t };
    this.subs.forEach((f) => f());
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  getSnapshot = (): VoiceMetricsSnapshot => this.snap;

  /** Stats for the debrief ("average response 1.4 s"). Null if no voice turns were measured. */
  statsFor(caseId: string): VoiceStatsSummary | null {
    const t = this.trackers.get(caseId);
    if (!t) return null;
    const s = t.summary();
    return s.turns > 0 || s.interruptions > 0 || s.errors > 0 ? s : null;
  }
}

export const voiceMetrics = new VoiceMetricsRegistry();
