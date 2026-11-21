import { doctorName, initials, openProfileDialog, useProfile, type Gender } from '../../game/profile';

/** Small doctor portrait in white coat with stethoscope; long hair in a bun for female. */
export function DoctorAvatar({ gender, size = 56, label }: { gender?: Gender; size?: number; label?: string }) {
  const female = gender === 'female';
  return (
    <svg
      className="doc-avatar"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      shapeRendering="crispEdges"
    >
      <rect width="64" height="64" fill={female ? '#6ad5e7' : '#a8e27c'} />
      {/* coat + shirt */}
      <path d="M10 64 L14 48 Q32 40 50 48 L54 64 Z" fill="#f4f5f7" />
      <path d="M27 45 L32 56 L37 45 Z" fill={female ? '#7a1630' : '#8fb8d8'} />
      <path d="M26 45 L32 64 M38 45 L32 64" stroke="#c9ced8" strokeWidth="1.2" />
      {/* stethoscope */}
      <path d="M24 46 Q22 56 30 58 M40 46 Q42 56 34 58" fill="none" stroke="#1d2a44" strokeWidth="1.6" />
      <circle cx="32" cy="59" r="2" fill="#1d2a44" />
      {/* neck + head */}
      <rect x="28" y="36" width="8" height="8" fill="#b77b58" />
      <ellipse cx="32" cy="27" rx="10" ry="12" fill={female ? '#c88f6c' : '#b77b58'} />
      {female ? (
        <>
          <path d="M21 28 Q20 13 32 13 Q44 13 43 28 Q41 19 32 19 Q24 19 21 28 Z" fill="#2a1f17" />
          <circle cx="32" cy="12" r="5" fill="#2a1f17" />
          <path d="M21 26 Q19 38 23 42 L24 30 Z M43 26 Q45 38 41 42 L40 30 Z" fill="#2a1f17" />
          <circle cx="32" cy="22.5" r="0.9" fill="#b8262c" />
        </>
      ) : (
        <path d="M22 26 Q21 14 32 14 Q43 14 42 26 Q40 19 32 19.5 Q24 19 22 26 Z" fill="#2a1f17" />
      )}
      <rect x="27" y="26" width="2" height="2" fill="#1b1410" />
      <rect x="35" y="26" width="2" height="2" fill="#1b1410" />
      <path d="M29 33 Q32 35 35 33" fill="none" stroke="#6b3a28" strokeWidth="1.2" />
    </svg>
  );
}

/** Name badge for report cards and headers. Renders nothing without a profile. */
export function ProfileBadge({ compact = false }: { compact?: boolean }) {
  const p = useProfile();
  if (!p) return null;
  return (
    <div className={`profile-badge${compact ? ' profile-badge--compact' : ''}`}>
      <DoctorAvatar gender={p.gender} size={compact ? 32 : 52} />
      <div className="profile-badge-text">
        <span className="profile-badge-name">{doctorName(p)}</span>
        {!compact && p.university && <span className="profile-badge-uni">{p.university}</span>}
      </div>
    </div>
  );
}

/** Header chip: avatar + initials, click to edit the profile. */
export function ProfileChip() {
  const p = useProfile();
  if (!p) return null;
  return (
    <button type="button" className="profile-chip" onClick={() => openProfileDialog()} title={`${doctorName(p)}, edit profile`} aria-label={`${doctorName(p)}, edit profile`}>
      <DoctorAvatar gender={p.gender} size={28} />
      <span>{initials(p)}</span>
    </button>
  );
}
