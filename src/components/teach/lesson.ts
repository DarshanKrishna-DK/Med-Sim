// Teacher Portal lesson model: the JSON contract of POST /teach/lesson
// (backend/teacher.py), topic detection for "teach me X", and pacing.
// Pure module (no React / DOM) so scripts/test can import it.

export type LessonLevel = 'student' | 'intern';

export interface FlowVisual {
  kind: 'flow';
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
}
export interface CycleVisual {
  kind: 'cycle';
  nodes: Array<{ id: string; label: string }>;
  center?: string;
}
export interface CompareVisual {
  kind: 'compare';
  left: { title: string; items: string[] };
  right: { title: string; items: string[] };
}
export interface LabelledVisual {
  kind: 'labelled';
  center: string;
  labels: Array<{ label: string; note?: string }>;
}
export interface TimelineVisual {
  kind: 'timeline';
  events: Array<{ t: string; label: string }>;
}
export interface GraphVisual {
  kind: 'graph';
  xLabel: string;
  yLabel: string;
  series: Array<{ name: string; points: Array<[number, number]> }>;
}
/** Physiology curves drawn in code (waveforms.ts); the model only picks a preset. */
export const WAVEFORM_PRESETS = [
  'ecg-normal',
  'ecg-stemi',
  'ecg-af',
  'ecg-vt',
  'ecg-heart-block-1',
  'cardiac-cycle-wiggers',
  'pv-loop',
  'oxy-hb-dissociation',
  'frank-starling',
  'action-potential-ventricular',
  'action-potential-nerve',
  'spirometry-normal-vs-obstructive',
  'glucose-insulin-ogtt',
  'dose-response',
] as const;
export type WaveformPreset = (typeof WAVEFORM_PRESETS)[number];
export const WAVEFORM_HIGHLIGHTS: Partial<Record<WaveformPreset, readonly string[]>> = {
  'ecg-normal': ['p', 'pr', 'qrs', 'st', 't', 'qt'],
  'oxy-hb-dissociation': ['right', 'left'],
};
export interface WaveformVisual {
  kind: 'waveform';
  preset: WaveformPreset;
  highlight?: string;
  caption?: string;
}
export type LessonVisual = FlowVisual | CycleVisual | CompareVisual | LabelledVisual | TimelineVisual | GraphVisual | WaveformVisual;

/** Coerce a waveform visual: unknown preset becomes a flow of the step's points. */
export function normalizeVisual(raw: unknown, fallbackLabels: string[]): LessonVisual {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (v.kind === 'waveform') {
    const preset = String(v.preset ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-') as WaveformPreset;
    if ((WAVEFORM_PRESETS as readonly string[]).includes(preset)) {
      const out: WaveformVisual = { kind: 'waveform', preset };
      const hl = String(v.highlight ?? '').toLowerCase();
      if (WAVEFORM_HIGHLIGHTS[preset]?.includes(hl)) out.highlight = hl;
      if (typeof v.caption === 'string' && v.caption.trim()) out.caption = v.caption.trim().slice(0, 90);
      return out;
    }
    const labels = fallbackLabels.filter(Boolean).slice(0, 4);
    const nodes = (labels.length ? labels : ['Key idea']).map((label, i) => ({ id: `n${i}`, label: label.slice(0, 40) }));
    return { kind: 'flow', nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })) };
  }
  return raw as LessonVisual;
}

export interface LessonStep {
  heading: string;
  points: string[];
  narration: string;
  visual: LessonVisual;
}

export interface LessonQuiz {
  question: string;
  options: string[];
  answerIndex: number;
  why: string;
}

export interface Lesson {
  topic: string;
  level: LessonLevel;
  title: string;
  summary: string;
  steps: LessonStep[];
  quiz: LessonQuiz;
  cached?: boolean;
}

export const SUGGESTED_TOPICS = [
  'Cardiac cycle',
  'ECG basics',
  'Acid-base balance',
  'Diabetes management',
  'Asthma vs COPD',
];

/** Light client-side shape check (the backend already validated). */
export function isLesson(v: unknown): v is Lesson {
  if (!v || typeof v !== 'object') return false;
  const l = v as Partial<Lesson>;
  return (
    typeof l.title === 'string' &&
    Array.isArray(l.steps) &&
    l.steps.length > 0 &&
    l.steps.every((s) => s && typeof s.heading === 'string' && typeof s.narration === 'string' && !!s.visual) &&
    !!l.quiz &&
    Array.isArray(l.quiz.options) &&
    l.quiz.options.length === 4
  );
}

const ANY_TRIGGER = /\b(?:teach me|teach us|explain|what (?:is|are)|lesson on|tell me about)\b/i;
const NEW_LESSON_TRIGGER = /\b(?:teach me|teach us|lesson on|new lesson|next lesson)\b/i;

/** Topic from "teach me X" style requests, or null. While a lesson is on
 *  the board only explicit requests ("teach me", "lesson on") start a new
 *  one; "what is…" then stays a question for the teacher. */
export function detectTopicRequest(text: string, lessonActive = false): string | null {
  const t = text.trim();
  if (!t) return null;
  const re = lessonActive ? NEW_LESSON_TRIGGER : ANY_TRIGGER;
  const m = re.exec(t);
  if (!m) return null;
  let topic = t.slice(m.index + m[0].length);
  topic = topic
    .replace(/^[\s,:-]+/, '')
    .replace(/^(?:me |us )?(?:about |on |the basics of |basics of |a lesson on |how )?/i, '')
    .replace(/\b(?:please|to me|for me|in simple (?:words|terms)|simply|today)\b/gi, '')
    .replace(/[?.!,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  topic = topic.replace(/^(?:the|a|an)\s+/i, '');
  const words = topic.split(' ').filter(Boolean);
  if (topic.length < 3 || words.length > 8) return null;
  // Vague follow-ups ("explain that again", "what is this") are questions, not topics.
  if (/^(?:it|this|that|these|those|them|again|more|why|so|something|you|me)\b/i.test(topic) || /\bagain\b/i.test(topic)) return null;
  return topic.charAt(0).toUpperCase() + topic.slice(1);
}

/** Rough spoken length of a line in ms (about 2.6 words per second). */
export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return 700 + words * 385;
}

export async function fetchLesson(topic: string, level: LessonLevel, signal?: AbortSignal): Promise<Lesson> {
  const r = await fetch('/teach/lesson', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, level }),
    signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    let detail = body;
    try {
      detail = (JSON.parse(body) as { detail?: string }).detail ?? body;
    } catch {
      /* not JSON */
    }
    if (r.status === 404 || r.status === 502 || r.status === 504 || !detail)
      throw new Error(r.status === 504 ? 'The lesson took too long to prepare.' : `Lesson service unavailable (${r.status}).`);
    throw new Error(String(detail).slice(0, 160));
  }
  const data: unknown = await r.json();
  if (!isLesson(data)) throw new Error('The lesson came back in an unexpected shape.');
  return { ...data, steps: data.steps.map((st) => ({ ...st, visual: normalizeVisual(st.visual, st.points ?? [st.heading]) })) };
}

/** Built-in lesson so the classroom still teaches when the backend is down. */
export const FALLBACK_LESSON: Lesson = {
  topic: 'Cardiac cycle',
  level: 'student',
  title: 'The Cardiac Cycle',
  summary: 'The sequence of filling and pumping that makes up one heartbeat.',
  steps: [
    {
      heading: 'Filling the ventricles',
      points: ['Atrial pressure rises', 'AV valves open', 'Blood flows into ventricles'],
      narration: 'The heart starts by letting blood flow from the atria into the ventricles. Think of a bucket filling with water before you squeeze it.',
      visual: {
        kind: 'flow',
        nodes: [
          { id: 'a', label: 'Atria fill' },
          { id: 'b', label: 'AV valves open' },
          { id: 'c', label: 'Ventricles fill' },
        ],
        edges: [
          { from: 'a', to: 'b', label: 'pressure rises' },
          { from: 'b', to: 'c', label: 'blood flows' },
        ],
      },
    },
    {
      heading: 'One beat is a loop',
      points: ['Fill', 'Squeeze', 'Eject', 'Relax'],
      narration: 'Each beat runs as a loop of four phases. Fill, squeeze with all valves shut, push the blood out, then relax and start again.',
      visual: {
        kind: 'cycle',
        nodes: [
          { id: 'f', label: 'Filling' },
          { id: 'c', label: 'Isovolumic contraction' },
          { id: 'e', label: 'Ejection' },
          { id: 'r', label: 'Isovolumic relaxation' },
        ],
        center: 'One heartbeat',
      },
    },
    {
      heading: 'Systole vs diastole',
      points: ['Systole squeezes', 'Diastole fills', 'Diastole is longer'],
      narration: 'Systole is the squeeze and diastole is the rest when the chambers fill. At a normal heart rate, diastole takes about two thirds of the beat.',
      visual: {
        kind: 'compare',
        left: { title: 'Systole', items: ['AV valves shut', 'Semilunar valves open', 'Blood ejected'] },
        right: { title: 'Diastole', items: ['AV valves open', 'Semilunar valves shut', 'Ventricles fill'] },
      },
    },
    {
      heading: 'Pressures and volume',
      points: ['LV pressure rises in systole', 'Valves open and close', 'Volume falls as blood leaves'],
      narration: 'Here are the aortic, ventricular and atrial pressures with the ventricular volume. Watch the valves open and close as the ventricle squeezes and relaxes.',
      visual: { kind: 'waveform', preset: 'cardiac-cycle-wiggers', caption: 'Wiggers diagram: one cardiac cycle' },
    },
    {
      heading: 'The ECG behind the beat',
      points: ['P wave: atria depolarise', 'QRS: ventricles depolarise', 'T wave: ventricles repolarise'],
      narration: 'The electrical signal comes first. The P wave starts atrial contraction, the QRS starts the ventricular squeeze, and the T wave is the ventricles resetting.',
      visual: { kind: 'waveform', preset: 'ecg-normal', caption: 'Normal sinus beat' },
    },
    {
      heading: 'Heart sounds mark the valves',
      points: ['S1: AV valves close', 'S2: semilunar valves close'],
      narration: 'You hear S1 when the AV valves close at the start of systole. S2 is the semilunar valves closing at the end of ejection.',
      visual: {
        kind: 'timeline',
        events: [
          { t: '0 s', label: 'S1, AV valves close' },
          { t: '0.1 s', label: 'Ejection begins' },
          { t: '0.3 s', label: 'S2, semilunar close' },
          { t: '0.4 s', label: 'Filling resumes' },
        ],
      },
    },
  ],
  quiz: {
    question: 'Which event marks the start of ventricular systole?',
    options: ['Opening of the AV valves', 'Closure of the AV valves', 'Opening of the aortic valve', 'Closure of the aortic valve'],
    answerIndex: 1,
    why: 'Closure of the AV valves makes the first heart sound and starts isovolumic contraction.',
  },
};
