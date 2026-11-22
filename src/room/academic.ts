// The academic room of one result, for a React screen: opens it, follows it,
// remembers it, speaks the examiner's line when the signature arrives.

import { useCallback, useEffect, useRef, useState } from 'react';
import { normLang } from '../game/lang';
import { store } from '../game/store';
import { say } from '../voice/speech';
import { academicContext, asAcademic, isSigned, type AcademicInput, type AcademicSide } from './academicCore';
import { loadSignOff, newRefId, saveSignOff } from './academicStore';
import { openSide, roomIdOf, type SideSession } from './sideSession';
import { fetchRoomStatus } from './status';

export interface AcademicRoom {
  side: AcademicSide | null;
  /** off: BAND is not configured. idle: possible, not opened. */
  mode: 'checking' | 'off' | 'idle' | 'open';
  busy: boolean;
  error: string;
  open: () => void;
  act: (action: 'invite' | 'retry', note?: string) => Promise<void>;
}

/** `auto`: open at once (a result that has just been made). An older result
 *  reopens its own room when it has one and otherwise waits for `open()`. */
export function useAcademicRoom(input: AcademicInput, auto: boolean): AcademicRoom {
  const key = input.resultKey;
  const inputRef = useRef(input);
  inputRef.current = input;
  const [side, setSide] = useState<AcademicSide | null>(() => loadSignOff(key)?.side ?? null);
  const [mode, setMode] = useState<AcademicRoom['mode']>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const session = useRef<SideSession | null>(null);

  const open = useCallback(() => {
    if (session.current) return;
    const saved = loadSignOff(key);
    const refId = saved?.refId ?? newRefId();
    // Kept before the first reply: a remount must come back to the same room.
    if (!saved) saveSignOff({ key, refId, side: null });
    setError('');
    setMode('open');
    session.current = openSide(
      {
        kind: 'academic',
        refId,
        lang: store.getState().lang,
        context: academicContext(inputRef.current, isSigned(saved?.side)),
        ...(saved?.side?.url ? { roomId: roomIdOf(saved.side.url) } : {}),
      },
      {
        onState: (raw) => {
          const next = asAcademic(raw);
          if (!next) return;
          const before = loadSignOff(key)?.side ?? null;
          // A server that restarted and could not read the room again knows less than this browser.
          if (isSigned(before) && !isSigned(next) && next.status !== 'sent_back') return;
          setSide(next);
          saveSignOff({ key, refId, side: next });
        },
        onDisabled: (reason) => {
          session.current = null;
          if (reason === 'not reachable') setError('The agent room is not reachable right now.');
          setMode(reason === 'not reachable' ? 'idle' : 'off');
        },
        onSpeak: (sp) => {
          void say({
            speaker: sp.speaker,
            text: sp.text,
            lang: normLang(sp.lang),
            priority: sp.priority,
            key: `side:${sp.id}`,
          });
        },
      },
    );
  }, [key]);

  useEffect(() => {
    let gone = false;
    const saved = loadSignOff(key);
    setSide(saved?.side ?? null);
    if (auto || saved) {
      open();
    } else {
      void fetchRoomStatus().then((s) => {
        if (!gone) setMode(s?.enabled ? 'idle' : 'off');
      });
    }
    return () => {
      gone = true;
      session.current?.stop();
      session.current = null;
    };
  }, [key, auto, open]);

  const act = useCallback(async (action: 'invite' | 'retry', note?: string) => {
    if (!session.current) return;
    setBusy(true);
    setError('');
    try {
      await session.current.act(action, note?.trim() ? { note: note.trim() } : {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  return { side, mode, busy, error, open, act };
}
