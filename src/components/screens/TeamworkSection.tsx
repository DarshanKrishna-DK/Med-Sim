import { useMemo } from 'react';
import { useAgentRoom } from '../../game/store';
import type { ActivePatient } from '../../game/types';
import { encounterIdOf } from '../../room/chart';
import { timeline, type TimelineItem } from '../../room/reducer';
import { loadTeamwork } from '../../room/teamworkStore';
import type { RoomScore } from '../../room/types';
import '../../styles/agentroom.css';

function stateLine(s: RoomScore): string {
  switch (s.status) {
    case 'draft':
      return 'Draft score';
    case 'awaiting_signoff':
      return 'Draft, awaiting a human signature';
    case 'signed_off':
      return `Signed off by ${s.signedBy || 'faculty'}`;
    case 'revised':
      return `Revised and signed off by ${s.signedBy || 'faculty'}`;
  }
}

function Line({ t }: { t: TimelineItem }) {
  const at = Date.parse(t.at);
  return (
    <li className={t.tone ? `is-${t.tone}` : undefined}>
      <time dateTime={t.at}>
        {Number.isFinite(at) ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : ''}
      </time>
      <span>
        <b>{t.who}</b> {t.what}
      </span>
    </li>
  );
}

/** How the doctor worked with the departments: the examiner agent's score, a
 *  draft until a human signs it in the BAND room, and the room's own timeline.
 *  Nothing renders when no department was ever involved. */
export function TeamworkSection({ encounter }: { encounter: ActivePatient }) {
  const id = encounterIdOf(encounter);
  const live = useAgentRoom();
  const room = live?.encounterId === id && live.enabled && (live.roomId || live.delegations.length) ? live : null;
  const saved = useMemo(() => loadTeamwork(id), [id, room?.score]);
  const score = room?.score ?? saved?.score ?? null;
  const items = room ? timeline(room) : saved?.timeline ?? [];
  const url = room?.url || saved?.url || '';
  if (!score && !items.length) return null;

  return (
    <section className="teamwork" aria-labelledby="teamwork-title">
      <div className="teamwork-head">
        <h2 id="teamwork-title" className="section-title">Teamwork</h2>
        {score ? (
          <>
            <span className="teamwork-total">
              {Math.round(score.total)}
              <small>/100</small>
            </span>
            <span className={`teamwork-state teamwork-state--${score.status}`} role="status">
              {stateLine(score)}
            </span>
          </>
        ) : (
          <span className="teamwork-state" role="status">The examiner is reading the room</span>
        )}
        {url && (
          <a className="step-link" href={url} target="_blank" rel="noreferrer noopener">
            Open the room in BAND
          </a>
        )}
      </div>

      {score && score.domains.length > 0 && (
        <ul className="teamwork-domains">
          {score.domains.map((d) => (
            <li key={d.name} className="score">
              <div className="score-head">
                <span className="score-label">{d.name}</span>
                <span className="score-num">
                  {d.score}
                  <span className="score-max">/{d.max}</span>
                </span>
              </div>
              <div className="score-track" role="meter" aria-valuemin={0} aria-valuemax={d.max} aria-valuenow={d.score} aria-label={d.name}>
                <span
                  className={`score-fill score-fill--${d.score >= d.max * 0.8 ? 'good' : d.score >= d.max * 0.55 ? 'mid' : 'bad'}`}
                  style={{ width: `${d.max > 0 ? Math.max(0, Math.min(100, (d.score / d.max) * 100)) : 0}%` }}
                />
              </div>
              {d.note && <p className="muted-note">{d.note}</p>}
            </li>
          ))}
        </ul>
      )}

      {score?.facultyComment && (
        <p className="teamwork-comment">
          <b>{score.signedBy || 'Faculty'}:</b> {score.facultyComment}
        </p>
      )}

      {score && (score.strengths.length > 0 || score.improvements.length > 0) && (
        <div className="two-col">
          {score.strengths.length > 0 && <ul className="notes notes--good">{score.strengths.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {score.improvements.length > 0 && <ul className="notes notes--work">{score.improvements.map((x, i) => <li key={i}>{x}</li>)}</ul>}
        </div>
      )}

      {items.length > 0 && (
        <div>
          <h3 className="block-title">What happened in the room</h3>
          <ol className="teamwork-line">{items.map((t, i) => <Line key={i} t={t} />)}</ol>
        </div>
      )}
    </section>
  );
}
