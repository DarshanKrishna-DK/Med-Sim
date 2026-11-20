/**
 * Agora Conversational AI transcript wire format, shared by the doctor's
 * `Conversation` and the faculty observer page. Pure (no SDK imports) so it
 * runs under `node --test`.
 *
 * Agent -> RTM channel message (JSON string):
 *   { object: "user.transcription", text, final: boolean, turn_id, ... }
 *   { object: "assistant.transcription", text, turn_status: 0|1|2, turn_id, ... }
 *       turn_status: 0 = in progress, 1 = end, 2 = interrupted; `text` is
 *       the cumulative text of the turn so far.
 *   { object: "message.interrupt", turn_id }
 *   { object: "message.error", ... }
 */

export type AgentRtmMessage =
  | { kind: 'user'; text: string; final: boolean; turnId: string | null }
  | { kind: 'assistant'; text: string; turnStatus: number; turnId: string | null }
  | { kind: 'interrupt'; turnId: string | null }
  | { kind: 'error'; raw: Record<string, unknown> };

/** RTM payload (string or bytes) -> parsed JSON object, or null. */
export function decodeRtmJson(raw: string | Uint8Array): Record<string, unknown> | null {
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function turnIdOf(msg: Record<string, unknown>): string | null {
  const t = msg.turn_id;
  return t === undefined || t === null ? null : String(t);
}

/** Parse one agent transcript/state message. Returns null for anything that
 *  is not an agent message (including MedSim's own `medsim.*` messages). */
export function parseAgentMessage(msg: Record<string, unknown> | null): AgentRtmMessage | null {
  if (!msg) return null;
  switch (msg.object) {
    case 'user.transcription': {
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!text) return null;
      return { kind: 'user', text, final: msg.final === true || msg.final === 'true', turnId: turnIdOf(msg) };
    }
    case 'assistant.transcription': {
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!text) return null;
      const st = Number(msg.turn_status ?? 1);
      return { kind: 'assistant', text, turnStatus: Number.isFinite(st) ? st : 1, turnId: turnIdOf(msg) };
    }
    case 'message.interrupt':
      return { kind: 'interrupt', turnId: turnIdOf(msg) };
    case 'message.error':
      return { kind: 'error', raw: msg };
    default:
      return null;
  }
}

export function parseAgentRtmPayload(raw: string | Uint8Array): AgentRtmMessage | null {
  return parseAgentMessage(decodeRtmJson(raw));
}

/** Merge a final transcript segment into the text already held for a turn.
 *  Cumulative updates replace; segmented user finals append. */
export function mergeTurnText(prev: string, text: string, role: 'user' | 'assistant'): string {
  if (!prev) return text;
  return text.startsWith(prev) || prev.startsWith(text) || role === 'assistant' ? text : `${prev} ${text}`;
}

export interface TranscriptLine {
  /** Stable key: `${who}:${turnId}` or a generated id. */
  id: string;
  who: 'doctor' | 'patient';
  text: string;
  partial: boolean;
}

interface Entry {
  id: string;
  who: 'doctor' | 'patient';
  final: string;
  partial: string;
}

/** Builds a running transcript from agent RTM messages (partials included),
 *  for read-only views such as the observer page. */
export class TranscriptAssembler {
  private entries: Entry[] = [];
  private byKey = new Map<string, Entry>();
  private seq = 0;

  /** Seed earlier lines (e.g. a late-join snapshot). Only when still empty. */
  seed(lines: ReadonlyArray<{ who: 'doctor' | 'patient'; text: string }>): boolean {
    if (this.entries.length > 0) return false;
    for (const l of lines) {
      if (!l.text) continue;
      this.entries.push({ id: `seed-${this.seq++}`, who: l.who, final: l.text, partial: '' });
    }
    return this.entries.length > 0;
  }

  /** Apply one message. Returns true when the transcript changed. */
  apply(m: AgentRtmMessage): boolean {
    if (m.kind === 'user') return this.upsert('doctor', m.turnId, m.text, m.final);
    if (m.kind === 'assistant') return this.upsert('patient', m.turnId, m.text, m.turnStatus !== 0);
    return false;
  }

  private upsert(who: 'doctor' | 'patient', turnId: string | null, text: string, isFinal: boolean): boolean {
    const key = turnId === null ? null : `${who}:${turnId}`;
    let e = key ? this.byKey.get(key) : undefined;
    if (!e) {
      // Without a turn id, keep extending the trailing partial of the same speaker.
      const last = this.entries[this.entries.length - 1];
      if (!key && last && last.who === who && last.partial) e = last;
    }
    if (!e) {
      e = { id: key ?? `${who}-${this.seq++}`, who, final: '', partial: '' };
      this.entries.push(e);
      if (key) this.byKey.set(key, e);
    }
    if (isFinal) {
      e.final = mergeTurnText(e.final, text, who === 'doctor' ? 'user' : 'assistant');
      e.partial = '';
    } else {
      e.partial = text;
    }
    return true;
  }

  lines(): TranscriptLine[] {
    return this.entries.map((e) => {
      let text = e.final;
      if (e.partial) {
        text = !e.final || e.partial.startsWith(e.final) || e.who === 'patient' ? e.partial : `${e.final} ${e.partial}`;
      }
      return { id: e.id, who: e.who, text, partial: !!e.partial };
    });
  }
}
