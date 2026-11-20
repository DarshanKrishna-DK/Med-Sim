import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../voice/claude';
import { coachAfterUtterance } from '../../agents/coach';
import { looksClinicalUtterance } from '../../agents/coachRules';
import { looksLikeOrder } from '../../agents/nurseAgent';

const DEBOUNCE_MS = 2500;
const MIN_GAP_MS = 12000;

/** Watches the doctor's side of the conversation and, debounced, asks the
 *  coach about statements that carry a clinical decision ("it's just a
 *  virus, no need for tests"). Orders are skipped: the nurse run that
 *  follows them gets its own check. */
export function useCoachWatch(messages: ReadonlyArray<ChatMessage>, caseId: string | null) {
  const seen = useRef(0);
  const lastSent = useRef(0);
  const timer = useRef<number | null>(null);

  // New patient: start counting from their first message.
  useEffect(() => {
    seen.current = 0;
  }, [caseId]);

  useEffect(() => {
    const fresh = messages.slice(seen.current);
    seen.current = messages.length;
    const said = fresh
      .filter((m) => m.role === 'user')
      .map((m) => m.content.trim())
      .filter((t) => looksClinicalUtterance(t) && !looksLikeOrder(t));
    if (!said.length) return;
    const text = said[said.length - 1];
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (Date.now() - lastSent.current < MIN_GAP_MS) return;
      lastSent.current = Date.now();
      coachAfterUtterance(text);
    }, DEBOUNCE_MS);
  }, [messages]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
}
