import { useEffect, useState } from 'react';
import { fetchRoomStatus, type RoomStatus } from '../../room/status';
import '../../styles/agentroom.css';

/** "BAND connected": only shown when the backend says the departments are up. */
export function BandChip() {
  const [status, setStatus] = useState<RoomStatus | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    void fetchRoomStatus(ctl.signal).then((s) => !ctl.signal.aborted && setStatus(s));
    return () => ctl.abort();
  }, []);
  if (!status?.enabled) return null;
  const up = Object.values(status.departments).filter(Boolean).length;
  return (
    <span className="band-chip" title="Pharmacy, Lab, Radiology and the examiner run as separate BAND agents">
      BAND connected{up ? `: ${up} department${up === 1 ? '' : 's'}` : ''}
    </span>
  );
}
