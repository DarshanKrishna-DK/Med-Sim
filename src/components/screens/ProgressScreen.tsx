import { useMemo } from 'react';
import { ProfileBadge } from '../ui/ProfileBadge';
import { Drawer } from '@lucasmarkes/hairline/react';
import { store } from '../../game/store';
import { listEvalHistory } from '../../data/evalHistory';
import { CASES } from '../../data/cases';
import { CLINIC_LABELS } from '../../game/clinic';
import { computeProgress, type TrendPoint } from '../../data/progress';
import { AppHeader } from '../ui/chrome';
import '../../styles/osce.css';

function tone(score: number): 'good' | 'mid' | 'bad' {
  return score >= 55 ? (score >= 70 ? 'good' : 'mid') : 'bad';
}

export function ProgressScreen() {
  const p = useMemo(() => computeProgress(listEvalHistory(), CASES), []);

  return (
    <div className="page paper dots">
      <AppHeader />
      <main className="progress wrap">
        <div className="library-head">
          <ProfileBadge />
          <p className="kicker">My progress</p>
          <h1 className="page-title">How your consultations are going</h1>
          <p className="page-lede">Built from the debriefs saved on this browser: practice consultations and OSCE stations.</p>
        </div>

        {p.sessions === 0 ? (
          <div className="empty">
            <div className="empty-figure">
              <Drawer intensity={0.5} label="A cabinet of three empty drawers" />
            </div>
            <p className="empty-title">No sessions yet</p>
            <p className="empty-body">Finish a consultation or an OSCE station and your scores, weak spots and streak show up here.</p>
            <div className="row-actions">
              <button type="button" className="btn btn-primary" onClick={() => store.setScreen('library')}>
                Choose a case
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => store.openOsce()}>
                Try an OSCE station
              </button>
            </div>
          </div>
        ) : (
          <div className="progress-grid">
            <dl className="progress-stats">
              <div className="progress-stat">
                <dt>Sessions</dt>
                <dd>{p.sessions}</dd>
                <span className="progress-sub">{p.osceSessions} OSCE</span>
              </div>
              <div className="progress-stat">
                <dt>Average score</dt>
                <dd>{p.avgScore ?? '-'}</dd>
                <span className="progress-sub">
                  {p.recentDelta === null ? 'out of 100' : `${p.recentDelta >= 0 ? '+' : ''}${p.recentDelta} vs previous 5`}
                </span>
              </div>
              <div className="progress-stat">
                <dt>Streak</dt>
                <dd>{p.streak.current}</dd>
                <span className="progress-sub">{p.streak.current === 1 ? 'day' : 'days'} · best {p.streak.best}</span>
              </div>
            </dl>

            <section className="progress-card progress-card--wide" aria-labelledby="trend-title">
              <h2 id="trend-title" className="block-title">Score trend · last {p.trend.length} sessions</h2>
              <TrendChart points={p.trend} />
            </section>

            <section className="progress-card" aria-labelledby="skills-title">
              <h2 id="skills-title" className="block-title">Weakest areas first</h2>
              {p.skills.length === 0 ? (
                <p className="muted-note">No per-skill scores yet.</p>
              ) : (
                <ul className="progress-bars">
                  {p.skills.map((s) => (
                    <Bar key={s.key} label={s.label} value={s.avg} sub={`${s.n} ${s.n === 1 ? 'session' : 'sessions'}`} />
                  ))}
                </ul>
              )}
            </section>

            <section className="progress-card" aria-labelledby="spec-title">
              <h2 id="spec-title" className="block-title">By specialty</h2>
              <ul className="progress-bars">
                {p.bySpecialty.map((s) => (
                  <Bar key={s.clinic} label={CLINIC_LABELS[s.clinic]} value={s.avg} sub={`${s.sessions} ${s.sessions === 1 ? 'session' : 'sessions'}`} />
                ))}
              </ul>
            </section>

            <section className="progress-card" aria-labelledby="mistakes-title">
              <h2 id="mistakes-title" className="block-title">Recurring mistakes</h2>
              {p.mistakes.length === 0 ? (
                <p className="muted-note">No nurse alerts saved yet. Alerts raised during a session are counted here.</p>
              ) : (
                <ol className="progress-mistakes">
                  {p.mistakes.slice(0, 6).map((m) => (
                    <li key={m.title} className={`progress-mistake progress-mistake--${m.severity}`}>
                      <span className="progress-mistake-title">{m.title}</span>
                      <span className="progress-mistake-count">{m.count}×</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="progress-card" aria-labelledby="next-title">
              <h2 id="next-title" className="block-title">
                Practise next{p.weakestSpecialty ? ` · ${CLINIC_LABELS[p.weakestSpecialty]}` : ''}
              </h2>
              {p.suggestions.length === 0 ? (
                <p className="muted-note">You have tried every case. Run an OSCE station to test yourself.</p>
              ) : (
                <ul className="progress-next">
                  {p.suggestions.map((c) => (
                    <li key={c.id}>
                      <button type="button" className="progress-next-item" onClick={() => store.selectCase(c.id)}>
                        <span className="case-name">{c.name}</span>
                        <span className="case-complaint">{c.complaint}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="row-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => store.openOsce()}>
                  OSCE station
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => store.setScreen('history')}>
                  All debriefs
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function Bar({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <li className="progress-bar">
      <div className="progress-bar-head">
        <span className="progress-bar-label">{label}</span>
        <span className="progress-bar-num">{value}</span>
      </div>
      <div className="score-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
        <span className={`score-fill score-fill--${tone(value)}`} style={{ width: `${value}%` }} />
      </div>
      <span className="progress-sub">{sub}</span>
    </li>
  );
}

const W = 640;
const H = 200;
const PAD = { l: 34, r: 12, t: 12, b: 24 };

/** Inline SVG line chart, 0-100 on y; OSCE sessions drawn as squares. */
function TrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) return null;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / 100) * ih;
  const path = points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pt.score).toFixed(1)}`).join(' ');
  const label = `Scores over the last ${points.length} sessions: ${points.map((p) => p.score).join(', ')}`;
  return (
    <figure className="trend">
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" role="img" aria-label={label} shapeRendering="crispEdges">
        {[0, 40, 55, 80, 100].map((g) => (
          <g key={g}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} className={g === 55 ? 'trend-grid trend-grid--pass' : 'trend-grid'} />
            <text x={PAD.l - 6} y={y(g) + 4} className="trend-axis" textAnchor="end">{g}</text>
          </g>
        ))}
        <path d={path} className="trend-line" fill="none" shapeRendering="geometricPrecision" />
        {points.map((pt, i) =>
          pt.mode === 'osce' ? (
            <rect key={i} x={x(i) - 5} y={y(pt.score) - 5} width={10} height={10} className="trend-dot trend-dot--osce">
              <title>{`OSCE ${pt.score} · ${new Date(pt.savedAt).toLocaleDateString()}`}</title>
            </rect>
          ) : (
            <rect key={i} x={x(i) - 4} y={y(pt.score) - 4} width={8} height={8} className="trend-dot">
              <title>{`Practice ${pt.score} · ${new Date(pt.savedAt).toLocaleDateString()}`}</title>
            </rect>
          ),
        )}
      </svg>
      <figcaption className="trend-legend">
        <span><i className="trend-key" /> Practice</span>
        <span><i className="trend-key trend-key--osce" /> OSCE</span>
        <span><i className="trend-key trend-key--pass" /> Borderline line (55)</span>
      </figcaption>
    </figure>
  );
}
