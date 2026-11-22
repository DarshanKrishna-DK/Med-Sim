// Browser side of Theatre Sister Leela's room: one per drill. It posts what the
// engine asks for (its outbox) and hands back what the room answered as engine
// events. Without BAND `onDisabled` fires and the drill runs as it always did.

import { openSide, type SideSession } from '../room/sideSession';
import type { RoomState } from '../room/reducer';
import type { RoomSpeak } from '../room/types';
import type { Lang } from '../game/lang';
import type { OutItem, TheatreEvent } from './engine';
import { eventsBetween, parseSide, type TheatreSide } from './roomState';
import { DRUGS, DRUG_IDS, type OTScenario } from './scenarios';

const LOG = '[medsim:theatre]';

export interface TheatreRoomHandlers {
  /** The room answered that it exists (true), or there is no BAND (false). */
  onConnected: (on: boolean) => void;
  onEvents: (events: TheatreEvent[], side: TheatreSide) => void;
  onSpeak: (speak: RoomSpeak) => void;
  onRoom: (room: RoomState) => void;
}

const newId = (): string => `ot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class TheatreRoom {
  private session: SideSession;
  private side: TheatreSide | null = null;
  private sc: OTScenario;
  private stopped = false;

  constructor(sc: OTScenario, lang: Lang, on: TheatreRoomHandlers) {
    this.sc = sc;
    this.session = openSide(
      { kind: 'theatre', refId: newId(), title: sc.title, lang, context: { scenarioId: sc.id } },
      {
        onState: (state) => {
          if (this.stopped) return;
          const next = parseSide(state);
          const first = this.side === null;
          const events = eventsBetween(this.side, next);
          this.side = next;
          if (first) on.onConnected(true);
          on.onEvents(events, next);
        },
        onDisabled: () => {
          if (!this.stopped) on.onConnected(false);
        },
        onSpeak: (s) => {
          if (!this.stopped) on.onSpeak(s);
        },
        onRoom: (r) => {
          if (!this.stopped) on.onRoom(r);
        },
      },
    );
  }

  /** Post one thing the engine asked for. A failure is the same as silence: the drill has its own fallback. */
  async send(item: OutItem): Promise<void> {
    try {
      switch (item.kind) {
        case 'blood':
          await this.session.act('blood', { n: item.n ?? 1, units: item.units ?? 1, emergency: !!item.emergency });
          break;
        case 'sample':
          await this.session.act('sample');
          break;
        case 'unconfirmed':
          await this.session.act('unconfirmed', { n: item.n ?? 1 });
          break;
        case 'allergy':
          await this.session.act('allergy', {
            allergies: this.sc.patient.allergy,
            drug: DRUGS.cefazolin.label,
            dose: `${DRUGS.cefazolin.ideal} ${DRUGS.cefazolin.unit}`,
            drugs: DRUG_IDS.map((id) => ({ id, name: DRUGS[id].label })),
            age: this.sc.patient.age,
            gender: this.sc.patient.sex,
          });
          break;
        case 'help':
          await this.session.act('help', { sbar: item.sbar ?? '' });
          break;
      }
    } catch (err) {
      console.warn(LOG, item.kind, 'not sent:', err instanceof Error ? err.message : err);
    }
  }

  stop(): void {
    this.stopped = true;
    this.session.stop();
  }
}
