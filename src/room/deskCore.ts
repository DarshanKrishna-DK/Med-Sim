// What is new in a desk room? Pure, so the Node tests can load it.

import type { StudyPlan } from './academicCore';
import type { SideState } from './types';

export interface DeskItem {
  sideId: string;
  kind: 'desk' | 'desk_plan';
  question?: string;
  at: number;
  /** Answers already delivered. */
  seen: string[];
  done: boolean;
  plan?: StudyPlan;
  answer?: { by: string; text: string };
}

export interface DeskNews {
  id: string;
  /** In the session language, for Priya's voice. */
  spoken: string;
  /** As written, for the screen. */
  shown: string;
}

interface Answer {
  id: string;
  by: string;
  text: string;
  spoken: string;
}

const isAnswer = (a: unknown): a is Answer => {
  const x = a as Answer | null;
  return !!x && typeof x.id === 'string' && typeof x.text === 'string' && x.text.length > 0;
};

/** Each answer once, whatever the stream replays. `next` is `item` when nothing changed. */
export function deskNews(item: DeskItem, side: SideState): { news: DeskNews[]; next: DeskItem } {
  const news: DeskNews[] = [];
  let next = item;
  if (item.kind === 'desk') {
    const answers = (Array.isArray(side.answers) ? side.answers : []).filter(isAnswer);
    for (const a of answers) {
      if (next.seen.includes(a.id)) continue;
      next = { ...next, seen: [...next.seen, a.id].slice(-20), answer: { by: a.by, text: a.text } };
      news.push({ id: a.id, spoken: a.spoken || '', shown: `${a.by} replied: ${a.text}` });
    }
    if (side.status === 'failed' && !next.done) next = { ...next, done: true };
    return { news, next };
  }
  if (side.status === 'ready' && side.plan && !next.done) {
    const plan = side.plan as StudyPlan;
    next = { ...next, plan, done: true };
    if (!next.seen.includes('plan')) {
      next = { ...next, seen: [...next.seen, 'plan'] };
      news.push({ id: 'plan', spoken: String(side.spoken ?? ''), shown: `Dr Iyer's plan: ${plan.topic ?? ''}. Open Reception to start it.` });
    }
  } else if (side.status === 'failed' && !next.done) {
    next = { ...next, done: true, plan: undefined, seen: [...next.seen, 'failed'] };
    news.push({ id: 'failed', spoken: String(side.spoken ?? ''), shown: 'Dr Iyer did not answer about your revision plan.' });
  }
  return { news, next };
}
