import { useScreen } from './game/store';
import { LandingScreen } from './components/screens/LandingScreen';
import { LibraryScreen } from './components/screens/LibraryScreen';
import { EncounterScreen } from './components/screens/EncounterScreen';
import { DebriefScreen } from './components/screens/DebriefScreen';
import { HistoryScreen } from './components/screens/HistoryScreen';
import { RouteProgress } from './components/ui/chrome';
import { CorridorRoute } from './components/corridorRoute';

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
    case 'corridor':
      return <CorridorRoute fallback={<LibraryScreen />} />;
    default:
      return <LandingScreen />;
  }
}
