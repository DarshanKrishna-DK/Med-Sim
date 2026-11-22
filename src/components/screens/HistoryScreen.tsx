import { useState } from 'react';
import { StethoscopeArt } from '../ui/pixel/MedArt';
import { store } from '../../game/store';
import { listEvalHistory, clearEvalHistory } from '../../data/evalHistory';
import { AppHeader } from '../ui/chrome';
import { SignedMark } from '../academic/AcademicSection';
import { resultKeyOf } from '../../room/academicStore';

const VERDICT_WORD: Record<string, string> = {
  excellent: 'Excellent',
  good: 'Good',
  satisfactory: 'Satisfactory',
  borderline: 'Borderline',
  'clear-fail': 'Clear fail',
};
const VERDICT_TONE: Record<string, string> = {
  excellent: 'ok',
  good: 'ok',
  satisfactory: 'urgent',
  borderline: 'critical',
  'clear-fail': 'critical',
};

export function HistoryScreen() {
  const [entries, setEntries] = useState(listEvalHistory);

  return (
    <div className="page paper dots">
      <AppHeader />
      <main className="history wrap">
        <div className="library-head">
          <h1 className="page-title">Past debriefs</h1>
          <p className="page-lede">Every consultation the attending marked on this browser, newest first.</p>
        </div>

        {entries.length === 0 ? (
          <div className="empty">
            <div className="empty-figure">
              <StethoscopeArt />
            </div>
            <p className="empty-title">No debriefs saved yet</p>
            <p className="empty-body">Finish a consultation and its marking lands here.</p>
            <button type="button" className="btn btn-primary" onClick={() => store.setScreen('library')}>
              Choose a case
            </button>
          </div>
        ) : (
          <>
            <ul className="history-list">
              {entries.map((e) => (
                <li key={e.id}>
                  <button type="button" className="history-row" onClick={() => (e.viva ? store.viewVivaResult(e.id) : e.osce ? store.viewOsceResult(e.id) : store.viewEvalHistory(e.id))}>
                    <span className="history-name">
                      {e.viva ? e.caseName : `${e.caseName}, ${e.caseAge}${e.caseGender}`}
                    </span>
                    <span className="history-dx">
                      {e.mode === 'osce' && <span className="chip">OSCE</span>}
                      {e.mode === 'ot' && <span className="chip">OT</span>}
                      {e.mode === 'viva' && <span className="chip">Viva</span>} {e.diagnosisLabel} <SignedMark resultKey={resultKeyOf(e)} />
                    </span>
                    <span className={`tag tag--${VERDICT_TONE[e.verdict] ?? 'urgent'}`}>{VERDICT_WORD[e.verdict] ?? e.verdict}</span>
                    <time className="history-time" dateTime={new Date(e.savedAt).toISOString()}>
                      {new Date(e.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                if (window.confirm('Delete every saved debrief on this browser?')) {
                  clearEvalHistory();
                  setEntries([]);
                }
              }}
            >
              Clear history
            </button>
          </>
        )}
      </main>
    </div>
  );
}
