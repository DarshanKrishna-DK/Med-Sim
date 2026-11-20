import { Scene } from '../encounter/Scene';
import { EncounterHud } from '../encounter/EncounterHud';
import { useEncounterController } from '../encounter/useEncounterController';

export function EncounterScreen() {
  const ctl = useEncounterController();
  return (
    <div className="encounter">
      <Scene onTalk={() => !ctl.ending && ctl.voice.toggle()} lookEnabled={!ctl.ending} />
      <EncounterHud ctl={ctl} compact />
    </div>
  );
}
