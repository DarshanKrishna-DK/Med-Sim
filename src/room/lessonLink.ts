// "Learn this" from anywhere: the Classroom picks the topic up when it opens.

import { store } from '../game/store';

export interface LessonRequest {
  topic: string;
  level: 'student' | 'intern';
}

let pending: LessonRequest | null = null;

/** Call inside the click: the Classroom needs the gesture for its audio. */
export function openLesson(topic: string, level: 'student' | 'intern' = 'student'): void {
  const t = topic.trim();
  if (!t) return;
  pending = { topic: t, level };
  store.enterClassroom();
}

/** Read by the Classroom when it mounts. Cleared after this tick, so React's
 *  development double mount gets it twice. */
export function takeLesson(): LessonRequest | null {
  const p = pending;
  if (p)
    setTimeout(() => {
      if (pending === p) pending = null;
    }, 0);
  return p;
}

/** Open the brief of a practice case (its clinic is selected with it). */
export function openPractice(caseId: string): void {
  if (store.getState().osce) store.exitOsce('library');
  store.selectCase(caseId);
}
