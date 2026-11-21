import { Fragment } from 'react';

/** "How a consultation runs": the real data path, drawn as five lanes:
 *  the real-time voice loop, the nurse agent acting on the transcript,
 *  the real-world systems she writes to, the follow-up she runs later,
 *  and the attending grading at the end. */

interface Node {
  title: string;
  detail: string;
  /** Inner sub-stages, drawn as a chain inside the node. */
  chain?: string[];
  /** Tool names, drawn as mono chips. */
  tools?: string[];
}

interface Lane {
  id: 'voice' | 'nurse' | 'world' | 'followup' | 'attending';
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
      { title: 'Agora RTC + RTM', detail: 'Audio both ways, live transcript' },
      {
        title: 'Agora Conversational AI',
        detail: 'Hears you, answers in character, speaks in 7 languages',
        chain: ['Sarvam STT', 'MedSim custom LLM', 'Murf Falcon'],
      },
      { title: 'Patient voice', detail: 'Answers, interrupts, worries; stays quiet when you talk to the nurse' },
    ],
  },
  {
    id: 'nurse',
    name: 'Nurse agent',
    when: 'When you give an order',
    nodes: [
      { title: 'Live transcript', detail: '“Get a CBC and start amoxicillin”' },
      { title: 'Charge nurse Asha', detail: 'Plans the order, calls tools, adapts' },
      {
        title: 'Tool calls',
        detail: 'Each one checked and logged',
        tools: ['order_test', 'check_allergies', 'prescribe', 'schedule_follow_up', 'send_to_patient', 'refer_patient'],
      },
      { title: 'Chart + voice', detail: 'Results land; she confirms in her Murf voice' },
    ],
  },
  {
    id: 'world',
    name: 'Real world',
    when: 'As the nurse acts',
    nodes: [
      { title: 'Drug safety', detail: 'NIH RxNorm / RxClass and openFDA labels' },
      { title: 'Health record', detail: 'HL7 FHIR R4 orders, prescriptions, appointments' },
      { title: 'Calendar', detail: 'Follow-ups booked straight into Google Calendar, recurring' },
      { title: 'Patient’s phone', detail: 'Telegram / WhatsApp with a Murf voice prescription' },
    ],
  },
  {
    id: 'followup',
    name: 'Follow-up',
    when: 'At the scheduled time',
    nodes: [
      { title: 'Reminder', detail: '“Nurse Asha is ready for your check-in”' },
      { title: 'Asha calls the patient', detail: 'Agora voice agent with Murf, in their language' },
      { title: 'Acts mid-call', detail: 'Red flag alerts the doctor, reschedules the call' },
      { title: 'Report', detail: 'Adherence, side effects, red flags on the chart' },
    ],
  },
  {
    id: 'attending',
    name: 'Attending',
    when: 'After you end the consultation',
    nodes: [
      { title: 'Encounter log', detail: 'Questions, exam, orders, diagnosis, Rx' },
      { title: 'Attending agent', detail: 'Marks it against an OSCE rubric' },
      { title: 'Debrief', detail: 'Scores, evidence, guideline citations' },
      { title: 'Logbook', detail: 'CBME row in Google Sheets; teacher reports by email' },
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
