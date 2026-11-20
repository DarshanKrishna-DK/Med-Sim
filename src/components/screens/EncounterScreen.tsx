import { useState } from 'react';
import { Scene, type RoomControls } from '../encounter/Scene';
import { EncounterHud } from '../encounter/EncounterHud';
import { useEncounterController } from '../encounter/useEncounterController';

export function EncounterScreen() {
  const ctl = useEncounterController();
  const [room, setRoom] = useState<RoomControls | null>(null);
  return (
    <div className="encounter">
      <Scene onTalk={() => !ctl.ending && ctl.voice.toggle()} lookEnabled={!ctl.ending} onRoom={setRoom} />
      <EncounterHud ctl={ctl} compact room={room} />
    </div>
  );
}
