import { useEffect, useRef } from 'react';
import type { IRemoteVideoTrack } from 'agora-rtc-sdk-ng';

/** Framed panel that plays an Agora avatar video track. */
export function AvatarVideo({
  track,
  label,
  style,
}: {
  track: IRemoteVideoTrack;
  label: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try { track.play(el, { fit: 'cover' }); } catch { /* noop */ }
    return () => { try { track.stop(); } catch { /* noop */ } };
  }, [track]);
  return (
    <div
      role="img"
      aria-label={label}
      style={{ border: '3px solid #d9a520', background: '#061431', overflow: 'hidden', ...style }}
    >
      <div ref={ref} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
