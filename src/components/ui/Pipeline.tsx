import { Fragment } from 'react';

/** "How a consultation runs": the real data path, drawn as three lanes:
 *  the real-time voice loop (teal), the nurse agent acting on the
 *  transcript (amber), and the attending grading at the end (ink). */

interface Node {
  title: string;
  detail: string;
  /** Inner sub-stages, drawn as a chain inside the node. */
  chain?: string[];
  /** Tool names, drawn as mono chips. */
  tools?: string[];
}

interface Lane {
  id: 'voice' | 'nurse' | 'attending';
  name: string;
  when: string;
  nodes: Node[];
}

const LANES: Lane[] = [
  {
    id: 'voice',
    name: 'Voice loop',
    when: 'Every sentence, in real time',
    nodes: [
      { title: 'Your microphone', detail: 'You talk; no push-to-talk' },
      { title: 'Agora RTC', detail: 'Low-latency audio both ways' },
      {
        title: 'Agora Conversational AI',
        detail: 'Hears you, answers in character, speaks',
        chain: ['Sarvam STT', 'sarvam-105b', 'Murf Falcon'],
      },
      { title: 'Patient voice', detail: 'Answers, interrupts, worries' },
    ],
  },
  {
    id: 'nurse',
    name: 'Nurse agent',
    when: 'When you give an order',
    nodes: [
      { title: 'Live transcript', detail: '“Get a troponin and check allergies”' },
      { title: 'Charge nurse', detail: 'Plans the order, calls tools' },
      {
        title: 'Tool calls',
        detail: 'Each one checked and logged',
        tools: ['order_test', 'check_allergies', 'prescribe', 'schedule_follow_up'],
      },
      { title: 'Chart', detail: 'Results land; nurse confirms aloud' },
    ],
  },
  {
    id: 'attending',
    name: 'Attending',
    when: 'After you end the consultation',
    nodes: [
      { title: 'Encounter log', detail: 'Questions, orders, diagnosis, Rx' },
      { title: 'Attending agent', detail: 'Sarvam marks it against an OSCE rubric' },
      { title: 'Debrief', detail: 'Scores, evidence, guideline citations' },
    ],
  },
];

export function Pipeline() {
  return (
    <div className="pipeline" role="list" aria-label="How a MedSim consultation runs">
      {LANES.map((lane) => (
        <div key={lane.id} className={`lane lane--${lane.id}`} role="listitem">
          <div className="lane-head">
            <span className="lane-name">{lane.name}</span>
            <span className="lane-when">{lane.when}</span>
          </div>
          <ol className="lane-nodes">
            {lane.nodes.map((n, i) => (
              <Fragment key={n.title}>
                {i > 0 && <li className="pipe-link" aria-hidden="true" />}
                <li className="pipe-node">
                  <span className="pipe-title">{n.title}</span>
                  <span className="pipe-detail">{n.detail}</span>
                  {n.chain && (
                    <span className="pipe-chain">
                      {n.chain.map((c, ci) => (
                        <Fragment key={c}>
                          {ci > 0 && <span className="pipe-chain-arrow" aria-hidden="true" />}
                          <span className="pipe-chip">{c}</span>
                        </Fragment>
                      ))}
                    </span>
                  )}
                  {n.tools && (
                    <span className="pipe-tools">
                      {n.tools.map((t) => (
                        <code key={t} className="tool-chip">{t}</code>
                      ))}
                    </span>
                  )}
                </li>
              </Fragment>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
