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
import { getProfile } from '../game/profile';
import { addressLine, firstName, humanRules } from './humanVoice';

export const RECEPTIONIST = {
  name: 'Priya',
  title: 'Priya at Reception',
  gender: 'F' as const,
  caseId: 'receptionist',
};

export function receptionGreeting(p: Profile | null, v: AssignmentView): string {
  const n = firstName((p ?? getProfile())?.name);
  const who = n ? ` ${n}` : '';
  if (v.assignment && v.progress) {
    return `Namaste${who}! ${v.progress.done} of ${v.progress.total} done on ${v.assignment.title}. Want me to check what's pending, or send it to your teacher?`;
  }
  return `Namaste${who}! Welcome to MedSim General. Scores, an assignment, a study slot, just tell me.`;
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
      addressLine((p ?? getProfile())?.name),
      `You are ${RECEPTIONIST.name}, the friendly receptionist at the front desk of MedSim General Hospital, a medical training simulator.`,
      'The person at the desk is a medical student. You are speaking out loud on a voice call, like a real front-desk person who knows them.',
      '',
      'WHAT YOU DO:',
      'Answer questions about their assignment, what is pending, due dates and their scores, using ONLY the context below.',
      `Read requests loosely, the way a real receptionist would. "how'm I doing", "kitna hua", "am I on track" means their status or scores. "send this to sir", "give it to ma'am", "submit it" means email the report to the teacher. "block time for cardio tomorrow", "remind me to study", "slot for revision" means book a study session. "text me that", "WhatsApp it", "send it to my phone" means text it to them.`,
      'A front-desk system does the real actions (looking up the latest results, emailing the report to the teacher).',
      'When they want one of those actions, say only a short line like "Sure, one sec, doing that now." and stop; the system speaks the result right after.',
      'Never claim an email was sent unless the system told you. You can only email the teacher who set the assignment.',
      'If they ask where to go: clinics are down the corridor behind them, the Teacher Portal is the glowing doorway at the entrance.',
      '',
      ...humanRules(35),
      '',
      'HOW YOU SPEAK:',
      'Warm Indian English, a light "achha" or "haan" is fine.',
      'No lists, no markdown, no emojis, no stage directions. Say numbers the way people speak them.',
      '',
      'CONTEXT (JSON, current):',
      JSON.stringify(receptionContext(p, v, local)),
    ].join('\n'),
    lang,
    { female: true, role: 'teacher' },
  );
}
