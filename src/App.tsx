import { useScreen } from './game/store';
import { LandingScreen } from './components/screens/LandingScreen';
import { LibraryScreen } from './components/screens/LibraryScreen';
import { EncounterScreen } from './components/screens/EncounterScreen';
import { DebriefScreen } from './components/screens/DebriefScreen';
import { HistoryScreen } from './components/screens/HistoryScreen';
import { OsceScreen } from './components/screens/OsceScreen';
import { OsceResultScreen } from './components/screens/OsceResultScreen';
import { ProgressScreen } from './components/screens/ProgressScreen';
import { RouteProgress } from './components/ui/chrome';
import { lazy, Suspense } from 'react';
import { CorridorRoute } from './components/corridorRoute';

// Teacher Portal lecture hall (3D + whiteboard), loaded on first visit.
const TriageDrillScreen = lazy(() => import('./components/screens/TriageDrillScreen'));
const ClassroomScreen = lazy(() => import('./components/screens/ClassroomScreen'));
// Radiology reading room (3D + film viewer + consultant voice), loaded on first visit.
const RadiologyScreen = lazy(() => import('./components/screens/RadiologyScreen'));

/** Screen router. The Screen union in game/types.ts still carries legacy
 *  values (splash, onboarding, mode, gpRoom, endConfirm, agenticRounds…);
 *  each one folds into the nearest MedSim screen so nothing renders blank. */
export default function App() {
  const screen = useScreen();
  return (
    <>
      <RouteProgress />
      <ScreenView screen={screen} />
    </>
  );
}

function ScreenView({ screen }: { screen: ReturnType<typeof useScreen> }) {

  switch (screen) {
    case 'library':
    case 'gpRoom':
      return <LibraryScreen />;
    case 'brief':
      return <LibraryScreen briefOpen />;
    case 'encounter':
      return <EncounterScreen />;
    case 'endConfirm':
    case 'debrief':
      return <DebriefScreen />;
    case 'history':
      return <HistoryScreen />;
    case 'osce':
      return <OsceScreen />;
    case 'osceResult':
      return <OsceResultScreen />;
    case 'progress':
      return <ProgressScreen />;
    case 'corridor':
      return <CorridorRoute fallback={<LibraryScreen />} />;
    case 'triage':
      return (
        <Suspense fallback={<div className="route-loading">Opening the triage bay...</div>}>
          <TriageDrillScreen />
        </Suspense>
      );
    case 'classroom':
      return (
        <Suspense fallback={<div className="route-loading">Opening the lecture hall…</div>}>
          <ClassroomScreen />
        </Suspense>
      );
    case 'radiology':
      return (
        <Suspense fallback={<div className="route-loading">Opening the reading room...</div>}>
          <RadiologyScreen />
        </Suspense>
      );
    default:
      return <LandingScreen />;
  }
}
