import { useCallback, useEffect, useRef, useState } from 'react';
import { openSide, type SideSession } from '../../room/sideSession';
import { store } from '../../game/store';
import { parseSecondRead, type SecondRead } from './secondRead';

// One second read per submitted report. Without BAND `state` stays null and the
// result card is what it always was.

const newId = (): string => `read-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function useSecondRead(onRead: (s: SecondRead) => void) {
  const [state, setState] = useState<SecondRead | null>(null);
  const session = useRef<SideSession | null>(null);
  const told = useRef(false);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  const reset = useCallback(() => {
    session.current?.stop();
    session.current = null;
    told.current = false;
    setState(null);
  }, []);

  const request = useCallback(
    (filmId: string, report: string, diagnosis: string) => {
      reset();
      const mine: SideSession = openSide(
        { kind: 'second_read', refId: newId(), lang: store.getState().lang, context: { filmId, report: report.slice(0, 4000), diagnosis: diagnosis.slice(0, 200) } },
        {
          onState: (side) => {
            if (session.current !== mine) return;
            const s = parseSecondRead(side);
            setState(s);
            if (s?.read && !told.current) {
              told.current = true;
              onReadRef.current(s);
            }
            // Finished: nothing more will come, and a server restart must not ask him to read it again.
            if (s?.final) window.setTimeout(() => mine.stop(), 0);
          },
          onDisabled: () => {
            if (session.current === mine) reset();
          },
        },
      );
      session.current = mine;
    },
    [reset],
  );

  useEffect(() => () => session.current?.stop(), []);

  return { state, request, reset };
}
