// Priya at Reception: the front-desk voice agent in the hospital lobby.
// Same Agora Conversational AI stack as the patient (POST /voice/start with
// caseId 'receptionist'; the backend picks a female Indian Murf voice).
// The student's profile, active assignment and scores ride along as a
// compact JSON block, refreshed through /voice/context when they change.

import type { Lang } from '../game/lang';
import type { Profile } from '../game/profile';
import type { AssignmentView, LocalProgressSummary } from '../assignments/client';
import { formatDue } from '../assignments/core';
import { withLanguage } from './language';

export const RECEPTIONIST = {
  name: 'Priya',
  title: 'Priya at Reception',
  gender: 'F' as const,
  caseId: 'receptionist',
};

export function receptionGreeting(p: Profile | null, v: AssignmentView): string {
  const who = p?.name ? `, Doctor ${p.name.replace(/^dr\.?\s+/i, '').split(/\s+/)[0]}` : '';
  if (v.assignment && v.progress) {
    return `Namaste${who}! Welcome to MedSim General. You have ${v.progress.done} of ${v.progress.total} done on ${v.assignment.title}. Want me to check what's pending, or send your report to your teacher?`;
  }
  return `Namaste${who}! Welcome to MedSim General reception. I can tell you your scores, check an assignment, or email your report to your teacher.`;
}

/** Compact, model-friendly context. Keep it small: it is resent on every change. */
export function receptionContext(p: Profile | null, v: AssignmentView, local: LocalProgressSummary) {
  const a = v.assignment;
  return {
    student: p ? { name: p.name, university: p.university || null } : null,
    assignment: a
      ? {
          code: a.code,
          title: a.title,
          due: formatDue(a.dueDate),
          teacher: a.teacherName || null,
          passMark: a.passMark,
          done: v.progress?.done ?? 0,
          total: v.progress?.total ?? a.items.length,
          average: v.progress?.average ?? null,
          pending: (v.progress?.pending ?? []).map((i) => i.label).slice(0, 5),
        }
      : null,
    practice: {
      sessions: local.sessions,
      average: local.average,
      recent: local.recent.slice(0, 4).map((r) => ({ case: r.label, score: r.score })),
      skills: local.skills,
    },
  };
}

export function buildReceptionistPersona(p: Profile | null, v: AssignmentView, local: LocalProgressSummary, lang: Lang = 'en'): string {
  return withLanguage(
    [
      `You are ${RECEPTIONIST.name}, the friendly receptionist at the front desk of MedSim General Hospital, a medical training simulator.`,
      'The person at the desk is a medical student playing a doctor. You are speaking out loud on a voice call.',
      '',
      'WHAT YOU DO:',
      'Greet them, answer questions about their assignment, what is pending, due dates and their scores, using ONLY the context below.',
      'A separate front-desk system does the real actions (looking up the latest results, emailing the report to the teacher).',
      'When they ask you to email, send or submit their report, or to check their latest status, say only a short line like "Sure, one moment, I am doing that now." and stop; the system speaks the result right after.',
      'Never claim an email was sent unless the system told you. You can only email the teacher who set the assignment.',
      'If they ask where to go: clinics are down the corridor behind them, the Teacher Portal is the glowing doorway at the entrance.',
      '',
      'HOW YOU SPEAK:',
      'One or two short spoken sentences, at most about thirty five words. Warm Indian English, a light "achha" is fine.',
      'No lists, no markdown, no emojis, no stage directions. Say numbers the way people speak them.',
      '',
      'CONTEXT (JSON, current):',
      JSON.stringify(receptionContext(p, v, local)),
    ].join('\n'),
    lang,
    { female: true, role: 'teacher' },
  );
}
