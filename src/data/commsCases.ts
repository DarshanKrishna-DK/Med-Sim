/**
 * Communication Skills stations (8 cases). The "clinic" is a communication
 * OSCE bay: the trainee is marked on HOW they talk, not on a diagnosis.
 *
 *  1. Breaking bad news (new metastatic colon cancer), SPIKES
 *  2. Telling a mother her baby has died in the womb (stillbirth)
 *  3. Informed consent for elective surgery (risks, benefits, alternatives)
 *  4. An angry relative after a long delay (de-escalation)
 *  5. A patient refusing admission (capacity, respect, safety netting)
 *  6. Disclosing a medication error (duty of candour)
 *  7. Telling a man he is HIV positive (confidentiality, partner notification)
 *  8. Tobacco / gutka cessation counselling (5 A's, motivational approach)
 *
 * Same `PatientCase` shape as newDomainCases.ts and merged into POLYCLINIC_CASES.
 * `correctDiagnosisId` / `diagnosisOptions` are framed as the KEY COMMUNICATION
 * GOAL (the right approach) versus common poor approaches. Every case carries an
 * `emotionProfile` so the voice patient or relative reacts to the doctor's manner,
 * and an authored rubric of communication criteria (SPIKES, NURSE, teach-back,
 * no jargon, safety netting) used by the debrief and OSCE marking.
 * Frameworks: SPIKES (Baile 2000), NURSE (Back 2005), 5 A's (US PHS 2008).
 * Cases are synthetic teaching cases, not clinical guidance.
 */

import type { AnamnesisQA, CaseRubric, PatientCase, RubricCriterion, TestResult } from '../game/types';

const q = (id: string, question: string, answer: string, relevant = true): AnamnesisQA => ({
  id,
  question,
  answer,
  relevant,
});
const t = (testId: string, result: string, abnormal: boolean): TestResult => ({ testId, result, abnormal });
const c = (
  criterion_id: string,
  label: string,
  weight: number,
  framework: RubricCriterion['framework'],
  evidence: string,
): RubricCriterion => ({ criterion_id, label, weight, framework, evidence });

// Shared interpersonal criteria used by every station (ids ip-01.. are case specific below).
const rubric = (r: Omit<CaseRubric, 'global_rating'>): CaseRubric => ({ ...r, global_rating: 'borderline-regression' });

const comms: PatientCase[] = [
  // ───────────── 1. Breaking bad news (SPIKES) ─────────────
  {
    id: 'comm-001',
    name: 'Ramesh Iyer',
    age: 58,
    gender: 'M',
    severity: 'stable',
    arrivalBlurb: 'Retired schoolteacher, came alone to collect his scan and biopsy results. His wife is waiting in the corridor.',
    chiefComplaint: 'Doctor, I have come for my reports. I have been unable to sleep these last few days waiting.',
    vitals: { hr: 82, bp: '134/84', spo2: 98, temp: 36.7, rr: 16 },
    anamnesis: [
      q('know', 'What do you understand about why the tests were done?', 'The surgeon said there was a growth in the bowel and that they had to check it. I have been telling myself it is piles or an infection.'),
      q('want', 'How much would you like to know about the results?', 'Tell me everything, doctor. I would rather know. But please, go slowly.'),
      q('family', 'Who is with you today?', 'My wife is outside. She gets very anxious, so I came in alone first. I will tell her myself.', false),
      q('symptoms', 'What brought you in originally?', 'Blood in the stool for four months and I lost seven kilos. I thought it was haemorrhoids.'),
      q('fear', 'What are you most worried about?', 'That it is cancer. My elder brother died of it. And my daughter is getting married in March.'),
      q('support', 'Who supports you at home?', 'My wife and my daughter. My son is in Pune. We are a close family.', false),
      q('future', 'What matters most to you now?', 'To see my daughter married. To not be a burden. To not suffer.'),
    ],
    testResults: [
      t('ct-abdomen', 'Irregular circumferential wall thickening of the sigmoid colon (5 cm) with three hypodense lesions in the right lobe of the liver (largest 3 cm) and enlarged mesenteric nodes. Findings suggest metastatic sigmoid carcinoma.', true),
      t('cbc', 'Hb 10.2 g/dL (low), WBC 7,400/mm3, platelets 3.1 lakh.', true),
      t('fobt', 'Positive.', true),
    ],
    correctDiagnosisId: 'comm-spikes-bad-news',
    diagnosisOptions: ['comm-spikes-bad-news', 'comm-blunt-disclosure', 'comm-false-reassurance', 'comm-disclose-to-family-first', 'comm-jargon-dump'],
    acceptableTreatmentIds: ['counselling', 'surgery-consult', 'discharge'],
    criticalTreatmentIds: ['counselling'],
    emotionProfile: {
      opening: 'anxious',
      notes: 'You already suspect the worst. You want the truth but you are frightened, and you need the doctor to go step by step. You keep thinking about your brother and your daughter wedding.',
      softenedBy: ['asks what you already know and how much you want to hear', 'gives a clear warning that the news is serious before saying it', 'uses plain words and pauses after the news', 'names how you feel ("this is a lot to take in")', 'gives a realistic plan and says you will not be alone'],
      escalatedBy: ['says the word cancer in the first sentence without preparation', 'uses medical terms like metastasis, adenocarcinoma or nodes', 'gives survival numbers unasked', 'false cheer ("do not worry, all will be fine")', 'talks to the file instead of to you'],
      reactions: ['goes silent for a moment, then "Is it cancer?"', 'eyes fill and the voice breaks', 'asks "Why me? I never smoked, never drank"', 'asks "How much time do I have?"', 'asks whether to tell his wife and daughter and how', 'asks "Can it be cured?" and then "Will I suffer?"'],
      goal: 'Deliver a serious new cancer diagnosis using SPIKES: set up, perception, invitation, warning shot, plain-language knowledge, empathic response to emotion, then a summary and next steps.',
    },
    rubric: rubric({
      data_gathering: [
        c('dg-01', 'Setting up the conversation', 2, 'SPIKES', 'Introduces self, checks privacy and time, sits down, invites a companion if the patient wants one before sharing the results.'),
        c('dg-02', 'Assesses perception', 3, 'SPIKES', 'Asks what the patient already understands about the tests and why they were done, before giving any results.'),
        c('dg-03', 'Invitation: how much to know', 2, 'SPIKES', 'Asks how much detail the patient wants and whether they want family present. Respects the answer.'),
        c('dg-04', 'Explores fears and goals', 2, 'ICE', 'Asks about worries, family and what matters most (daughter wedding, not suffering), and uses them later in the plan.'),
      ],
      clinical_management: [
        c('cm-01', 'Warning shot then clear news', 3, 'SPIKES', 'Gives a warning shot ("I am afraid it is not the news we hoped for") then states the diagnosis (cancer of the large bowel that has spread to the liver) once, simply, and stops to let it sink in.'),
        c('cm-02', 'Honest, realistic plan without false hope', 3, 'SPIKES', 'Explains that treatment (chemotherapy, possible surgery) aims to control the illness and keep him well, does not promise cure or quote unasked survival numbers, and says a specialist team will see him soon.'),
        c('cm-03', 'Strategy and summary', 2, 'SPIKES', 'Summarises in two or three sentences, agrees the next step (oncology appointment, who will call), offers a follow-up visit and a contact point.'),
      ],
      interpersonal: [
        c('ip-01', 'Empathic responses (NURSE)', 3, 'NURSE', 'Names or acknowledges emotion (naming, understanding, respecting, supporting, exploring), e.g. "This is very hard to hear", after the news and at each emotional cue.'),
        c('ip-02', 'Silence and pacing', 2, 'SPIKES', 'Allows silence after the news, does not fill it with information, checks readiness before the next piece.'),
        c('ip-03', 'No jargon', 2, 'PLAB2', 'Avoids terms such as metastasis, adenocarcinoma, lesions, nodes or staging, or explains them immediately in everyday words.'),
        c('ip-04', 'Answers "why me" and "how long" honestly', 2, 'NURSE', 'Responds to "why me" without blame or false cause, and to "how long" by exploring what he is really asking and being honest about uncertainty.'),
        c('ip-05', 'Teach-back', 2, 'TEACH-BACK', 'Asks the patient to say in his own words what he has understood and corrects gently.'),
        c('ip-06', 'Support for telling the family', 1, 'SPIKES', 'Offers to be present or help when he tells his wife and daughter.'),
      ],
      safety_netting: {
        required_elements: [
          'Date and who will contact him for the oncology appointment',
          'What to do and whom to call if there is heavy bleeding, severe abdominal pain, vomiting or inability to pass stool',
          'Offer to talk again and a way to reach the clinic with questions',
        ],
        weight: 2,
      },
    }),
  },

  // ───────────── 2. Stillbirth (gentle disclosure) ─────────────
  {
    id: 'comm-002',
    name: 'Sunita Yadav',
    age: 27,
    gender: 'F',
    severity: 'urgent',
    arrivalBlurb: 'Thirty-seven weeks pregnant, second baby. Came with her mother-in-law because she has not felt the baby move since last night. The scan has just shown no heartbeat.',
    chiefComplaint: 'Doctor, my baby has stopped moving since yesterday night. Please check, is everything alright?',
    vitals: { hr: 92, bp: '118/76', spo2: 98, temp: 36.8, rr: 18 },
    anamnesis: [
      q('moves', 'When did you last feel the baby move?', 'Yesterday evening after dinner. In the night I waited and waited, I drank cold water and lay on my side, nothing.'),
      q('pregnancy', 'How has this pregnancy been?', 'All check-ups were normal. My sugar test was normal. I took the iron tablets. My first child is a boy, four years old, normal delivery.'),
      q('husband', 'Is your husband with you?', 'He works in Surat. My mother-in-law is outside. She is not very kind about these things.', false),
      q('fear', 'What are you thinking might be wrong?', 'I do not want to think. Please just tell me the baby is fine.'),
      q('blame', 'Did anything unusual happen in the last few days?', 'I carried two buckets of water up the stairs two days ago. And I had a fall in the bathroom last week, a small one. Is it because of that?'),
      q('wish', 'What would help you right now?', 'I want my husband. And I want to see the baby if... if something has happened.'),
      q('belief', 'Are there beliefs or customs your family will want us to know about?', 'My mother-in-law will want the body taken home for the rites. And she will say I was careless.', false),
    ],
    testResults: [
      t('us-pelvis', 'Singleton, cephalic, about 37 weeks. No fetal cardiac activity and no fetal movements on repeated assessment. Liquor adequate. Placenta fundal, no retroplacental clot seen. Findings confirm intrauterine fetal demise.', true),
      t('cbc', 'Hb 10.8 g/dL (mild anaemia of pregnancy), WBC 9,800/mm3, platelets 2.2 lakh.', true),
      t('glucose', 'Random CBG 96 mg/dL.', false),
    ],
    correctDiagnosisId: 'comm-stillbirth-disclosure',
    diagnosisOptions: ['comm-stillbirth-disclosure', 'comm-euphemism-lost-baby', 'comm-platitudes-have-another', 'comm-defer-to-mother-in-law', 'comm-rush-to-induction'],
    acceptableTreatmentIds: ['counselling', 'admit-floor', 'observe'],
    criticalTreatmentIds: ['counselling'],
    emotionProfile: {
      opening: 'fearful',
      notes: 'You are praying the scan is wrong. When you are told, you will be in shock and then grief, and you will ask what you did wrong. You want your husband and to see the baby.',
      softenedBy: ['sits at your level and speaks slowly in plain words', 'gives a clear warning before the news and then says plainly that the baby has died', 'says it is not your fault and names your grief', 'offers to call your husband and allows you time', 'offers to let you see and hold the baby and explains what happens next step by step', 'treats your mother-in-law respectfully but asks what you want'],
      escalatedBy: ['says "we lost the baby" or "no heartbeat" without saying clearly what it means', 'rushes to induction or paperwork', 'says "you are young, you can have another"', 'blames the fall or the buckets, or is vague about cause', 'speaks over you to the mother-in-law'],
      reactions: ['"No, no, please check again"', 'goes completely silent and stares', 'cries and asks "What did I do wrong?"', 'asks "Will I have to deliver it?" and "Can I see the baby?"', 'asks for her husband', 'asks "Will it happen again next time?"'],
      goal: 'Break the news that the baby has died gently and clearly, respond to grief without false reassurance or blame, explain the options and next steps, and offer support and follow-up.',
    },
    rubric: rubric({
      data_gathering: [
        c('dg-01', 'Private, unhurried setting', 2, 'SPIKES', 'Moves to a private space, sits, introduces self, asks who she wants present (husband by phone, mother-in-law) and respects her wish.'),
        c('dg-02', 'Perception and wishes', 2, 'SPIKES', 'Asks what she has noticed and what she fears before giving the result.'),
        c('dg-03', 'Elicits guilt and beliefs', 2, 'ICE', 'Explores her worries about what caused it (fall, buckets) and family or cultural wishes about rites and the baby.'),
      ],
      clinical_management: [
        c('cm-01', 'Clear, compassionate disclosure', 3, 'SPIKES', 'Gives a warning shot then says clearly that the baby has died (not "lost", "no heartbeat" alone or other euphemisms), once, in simple words.'),
        c('cm-02', 'Explains options and next steps', 3, 'SPIKES', 'Explains that labour will usually be induced to deliver, that she may see and hold the baby, that tests will look for a cause, and that she will not be left alone, with time for questions.'),
        c('cm-03', 'Follow-up and support', 2, 'SPIKES', 'Arranges bereavement or counselling support, follow-up appointment, plan for a future pregnancy, and gives a named contact.'),
      ],
      interpersonal: [
        c('ip-01', 'Empathic responses (NURSE)', 3, 'NURSE', 'Names and acknowledges grief ("I am so sorry", "this is a terrible loss") and responds to each emotional cue without hurrying.'),
        c('ip-02', 'Does not blame and does not over-reassure', 3, 'NURSE', 'Tells her honestly that nothing she did, including the fall or lifting water, is known to have caused it, and avoids "you can have another".'),
        c('ip-03', 'Silence and presence', 2, 'SPIKES', 'Allows silence and tears, stays with her, does not fill gaps with information.'),
        c('ip-04', 'Respect for family and culture', 2, 'NURSE', 'Asks what she wants, handles the mother-in-law respectfully, and addresses the rites and the body with sensitivity.'),
        c('ip-05', 'Teach-back, plain words', 2, 'TEACH-BACK', 'Checks her understanding of the plan in her own words and avoids jargon such as IUFD or induction without explaining it.'),
      ],
      safety_netting: {
        required_elements: [
          'Warning signs after delivery to report urgently: heavy bleeding, fever, severe pain, breast engorgement distress',
          'Offer of emotional support, with a named person or counsellor to call',
          'Follow-up visit date to discuss test results and plan for the next pregnancy',
        ],
        weight: 2,
      },
    }),
  },

  // ───────────── 3. Informed consent for surgery ─────────────
  {
    id: 'comm-003',
    name: 'Hemant Kulkarni',
    age: 62,
    gender: 'M',
    severity: 'stable',
    arrivalBlurb: 'Retired bank manager with symptomatic gallstones. Surgeon has advised laparoscopic cholecystectomy. Needs a full consent discussion before the form is signed.',
    chiefComplaint: 'The surgeon says I need my gallbladder removed. They gave me a form to sign, but I want to understand before I sign anything.',
    vitals: { hr: 76, bp: '138/84', spo2: 98, temp: 36.7, rr: 16 },
    anamnesis: [
      q('symptoms', 'How have the gallstone attacks been?', 'Pain on the right side after oily food, four attacks in six months. Last month I needed an injection at the casualty.'),
      q('know', 'What have you been told about the operation?', 'That it is keyhole and a day or two in hospital. Nothing about what can go wrong.'),
      q('fear', 'What worries you most?', 'My neighbour had a bile duct problem after the same surgery and was in hospital for two months. And I have sugar. Will I wake up properly?'),
      q('medical', 'Any other illnesses or medicines?', 'Diabetes for ten years, metformin. Blood pressure tablet. I am not on blood thinners.'),
      q('alternatives', 'Have you thought about not having surgery?', 'The chemist says there are tablets to dissolve stones. Is that true? My son says do not operate at all.'),
      q('decision', 'Who helps you decide?', 'My son wants to decide, he is a software engineer in Bengaluru. But it is my body.'),
      q('values', 'What is important to you in this decision?', 'I want to be safe. I do not want another attack on the train when I travel to my daughter in March. And cost, a little.'),
    ],
    testResults: [
      t('us-abdomen', 'Multiple gallstones, largest 12 mm, thin-walled gallbladder, no pericholecystic fluid. Common bile duct 5 mm. No intrahepatic biliary dilatation.', true),
      t('hba1c', 'HbA1c 7.2%.', true),
      t('lft', 'Bilirubin 0.8 mg/dL, AST 28, ALT 31 U/L, ALP 96 U/L. Normal.', false),
    ],
    correctDiagnosisId: 'comm-informed-consent',
    diagnosisOptions: ['comm-informed-consent', 'comm-signature-only', 'comm-risks-minimised', 'comm-decision-by-son', 'comm-risk-list-no-context'],
    acceptableTreatmentIds: ['counselling', 'clear-for-surgery', 'defer-surgery'],
    criticalTreatmentIds: ['counselling'],
    emotionProfile: {
      opening: 'anxious',
      notes: 'You are intelligent and careful, scared by your neighbour story, and you do not want to be rushed or bullied into signing. You want to feel in control of the decision.',
      softenedBy: ['explains the operation and why it is advised in plain words', 'gives honest numbers and says plainly that bile duct injury is uncommon but serious', 'offers the alternative of not operating and what would happen', 'asks what matters to you and what you are most afraid of', 'invites questions and offers time to decide, including involving your son'],
      escalatedBy: ['pushes the form and says "it is only routine"', 'dismisses your neighbour story', 'lists risks very fast in jargon', 'says the surgeon knows best', 'makes you feel stupid for asking'],
      reactions: ['"What exactly can go wrong, doctor?"', '"What if I do nothing?"', '"How many of these have you seen go wrong?"', 'asks "Will they have to cut open the stomach?"', 'hesitates and says he needs to discuss with his son', 'asks about cost and recovery time'],
      goal: 'Obtain valid informed consent: purpose, benefits, material risks in understandable numbers, reasonable alternatives including doing nothing, check understanding and capacity, and make clear he can say no or take time.',
    },
    rubric: rubric({
      data_gathering: [
        c('dg-01', 'Establishes understanding and values', 3, 'ICE', 'Asks what he has been told, what worries him and what matters to him (travel in March, safety, cost) before explaining.'),
        c('dg-02', 'Relevant risk factors', 2, 'PLAB2', 'Asks about diabetes control, medicines (blood thinners), anaesthetic problems and previous operations that change his personal risk.'),
        c('dg-03', 'Who decides', 1, 'SEGUE', 'Clarifies that the decision is his and asks whether and how he wants his son involved.'),
      ],
      clinical_management: [
        c('cm-01', 'Explains the procedure and its benefit', 3, 'PLAB2', 'Describes keyhole removal of the gallbladder in simple words and the benefit (stops attacks, prevents complications such as infection or pancreatitis).'),
        c('cm-02', 'Material risks with context', 3, 'PLAB2', 'Names the common and the serious risks that matter to him: pain, wound infection, bleeding, possible conversion to open surgery, bile leak or bile duct injury (uncommon, can be serious), anaesthetic and diabetic risks, with rough likelihood.'),
        c('cm-03', 'Reasonable alternatives including no surgery', 3, 'PLAB2', 'Discusses waiting with dietary change, why stone-dissolving tablets are rarely effective, and what may happen if he does nothing.'),
        c('cm-04', 'Capacity, voluntariness and time', 2, 'PLAB2', 'Confirms he can understand and weigh the information, that signing is voluntary, that he can change his mind and take time, and documents the discussion.'),
      ],
      interpersonal: [
        c('ip-01', 'Responds to his fear', 2, 'NURSE', 'Acknowledges the neighbour story without dismissing it and explains how his case differs.'),
        c('ip-02', 'Plain language', 2, 'PLAB2', 'Explains terms such as laparoscopic, cholecystectomy and bile duct injury in everyday words.'),
        c('ip-03', 'Teach-back', 3, 'TEACH-BACK', 'Asks him to explain in his own words what the operation involves, its main risks and the alternative.'),
        c('ip-04', 'Shared decision making', 2, 'RCGP', 'Elicits his preference and respects his decision either way, without pressure.'),
      ],
      safety_netting: {
        required_elements: [
          'Before surgery: what to do if another attack, fever or yellow eyes occur while waiting',
          'After surgery: when to call urgently (fever, vomiting, jaundice, worsening abdominal pain, wound discharge)',
          'How to ask more questions or withdraw consent before the operation',
        ],
        weight: 2,
      },
    }),
  },

  // ───────────── 4. Angry relative (de-escalation) ─────────────
  {
    id: 'comm-004',
    name: 'Vikram Malhotra',
    age: 45,
    gender: 'M',
    severity: 'stable',
    arrivalBlurb: 'Son of a 78-year-old man who has waited three hours in the OPD for an ECG and blood test results. He is shouting at the desk and has asked for the doctor in charge.',
    chiefComplaint: 'Three hours! My father is seventy-eight with chest discomfort and you people have kept him sitting on a bench. Who is responsible for this?',
    vitals: { hr: 98, bp: '148/92', spo2: 98, temp: 36.8, rr: 20 },
    anamnesis: [
      q('wait', 'Tell me what has happened since you arrived.', 'We came at nine. Token number forty. They did the ECG after one hour, then said the blood test machine is down. Nobody told us anything. Now it is twelve.'),
      q('father', 'How is your father right now?', 'He says the discomfort is mild now but he is tired and has not eaten or taken his tablets. He has sugar and BP.'),
      q('fear', 'What are you most afraid of?', 'That something is happening to him and nobody is watching. My mother died in a hospital after they ignored her.'),
      q('threat', 'What do you want to happen?', 'I want to see someone senior. I want the report now. Otherwise I will post this on social media and complain to the medical superintendent.'),
      q('apology', 'Has anyone explained or apologised?', 'Nobody. The nurse only said "wait, wait".'),
      q('options', 'What would help now?', 'Tell me honestly what is happening and when. I need my father examined by a doctor, not by a bench.'),
    ],
    testResults: [
      t('ecg', "Father's ECG: sinus rhythm 78/min, no ST-T changes, no acute ischaemia.", false),
      t('troponin', "Father's troponin I below the cut-off (normal) on the point-of-care sample sent at 10:30.", false),
    ],
    correctDiagnosisId: 'comm-deescalation-complaint',
    diagnosisOptions: ['comm-deescalation-complaint', 'comm-defensive-excuses', 'comm-call-security', 'comm-blame-staff', 'comm-ignore-until-calm'],
    acceptableTreatmentIds: ['counselling', 'observe'],
    criticalTreatmentIds: ['counselling'],
    emotionProfile: {
      opening: 'angry',
      speakerRole: 'the son of an elderly man who has waited three hours with chest discomfort',
      notes: 'You are angry because you feel ignored and scared for your father. Underneath the shouting you want to be listened to, told the truth, and see someone examine your father now.',
      softenedBy: ['lets you finish without interrupting', 'apologises sincerely for the wait and for no one explaining', 'checks on your father right away or says exactly when a doctor will', 'explains honestly what happened (lab machine down) without blaming staff', 'gives a concrete plan with times and a name', 'says your concern was right to raise'],
      escalatedBy: ['makes excuses or blames the lab or other staff', 'says "everyone is waiting"', 'tells you to calm down', 'mentions security or that you are being rude', 'is vague ("soon", "we are trying")', 'stays on the defensive about the complaint'],
      reactions: ['raises voice and points to the clock', '"Do you know who I am? I will write to the minister"', 'softens and says "I just want someone to look at him"', 'asks "Is my father in danger?"', 'goes quiet and says he is sorry for shouting if the doctor listens', 'asks for the doctor name and phone number'],
      goal: 'De-escalate: listen, apologise, check on the patient promptly, explain honestly, agree a concrete plan, and follow up the complaint properly, without blame or defensiveness.',
    },
    rubric: rubric({
      data_gathering: [
        c('dg-01', 'Lets him speak first', 3, 'NURSE', 'Introduces self, invites him to explain, listens without interrupting and summarises the complaint back accurately.'),
        c('dg-02', 'Checks the patient safety first', 3, 'PLAB2', 'Asks about the father current symptoms and says the father will be seen or reviewed immediately, or checks the results.'),
        c('dg-03', 'Finds the real concern', 2, 'ICE', 'Explores what he fears (neglect, danger to his father) and what he wants to happen.'),
      ],
      clinical_management: [
        c('cm-01', 'Honest explanation without blame', 3, 'PLAB2', 'Explains that the lab machine was down and results were delayed, accepts the system failed, does not blame individual staff or give excuses.'),
        c('cm-02', 'Concrete plan with times', 3, 'PLAB2', 'Gives a specific plan (reviews the father now, results or ECG explained, food and tablets arranged, who will update him and when).'),
        c('cm-03', 'Complaint route and follow-up', 2, 'PLAB2', 'Offers the formal feedback route, takes his contact details and promises feedback, without discouraging the complaint.'),
      ],
      interpersonal: [
        c('ip-01', 'Genuine apology', 3, 'NURSE', 'Apologises specifically for the wait and for no one explaining, without defensiveness.'),
        c('ip-02', 'Empathic statement', 2, 'NURSE', 'Names his worry and fear ("you were worried about your father") and validates raising it.'),
        c('ip-03', 'Calm tone and posture', 2, 'SEGUE', 'Stays calm, does not say "calm down", does not threaten security.'),
        c('ip-04', 'Summary and check', 1, 'TEACH-BACK', 'Summarises the plan and asks whether it meets his needs.'),
      ],
      safety_netting: {
        required_elements: [
          'Tell the family which symptoms need immediate attention (worsening chest pain, breathlessness, sweating, fainting)',
          'Name of a person or number to contact for updates',
          'Time frame for the next update or review',
        ],
        weight: 1,
      },
    }),
  },

  // ───────────── 5. Refusal of treatment (capacity) ─────────────
  {
    id: 'comm-005',
    name: 'Lakshmi Narayanan',
    age: 71,
    gender: 'F',
    severity: 'urgent',
    arrivalBlurb: 'Fever and cough for four days, chest X-ray shows pneumonia. The team advises admission. She refuses and wants to go home.',
    chiefComplaint: 'I know you want to keep me here, doctor, but I am not staying. Please give me tablets and let me go home.',
    vitals: { hr: 104, bp: '118/72', spo2: 93, temp: 38.4, rr: 22 },
    anamnesis: [
      q('why', 'Can you tell me why you do not want to stay?', 'My son is thirty-eight, he has cerebral palsy. I am his only caregiver. My husband passed away. No one else can lift him or feed him.'),
      q('understand', 'What do you understand about your illness?', 'The doctor said pneumonia, infection in the lung. I know it can be serious at my age. I have had it before.'),
      q('risks', 'Do you understand what could happen if you go home?', 'It could get worse, I could stop breathing, I could die. I understand. But my son would be alone tonight.'),
      q('options', 'What would make staying possible?', 'If someone could take care of him. My neighbour can look after him for one night, perhaps, but not for many days.'),
      q('symptoms', 'How are you feeling right now?', 'Tired, a little breathless on walking, cough with yellow phlegm, fever. I took paracetamol.'),
      q('values', 'What matters to you most?', 'My son. And I want to decide for myself. I am not confused, doctor.'),
      q('past', 'Any past illness or allergies?', 'Sugar and BP. No allergy to medicines.'),
    ],
    testResults: [
      t('cxr', 'Right lower zone consolidation with air bronchogram. No effusion.', true),
      t('cbc', 'WBC 15,800/mm3 (high), Hb 12.4 g/dL, platelets 2.6 lakh.', true),
      t('crp', 'CRP 112 mg/L (high).', true),
    ],
    correctDiagnosisId: 'comm-refusal-capacity',
    diagnosisOptions: ['comm-refusal-capacity', 'comm-paternalistic-override', 'comm-accept-without-exploring', 'comm-threaten-consequences', 'comm-relative-decides'],
    acceptableTreatmentIds: ['counselling', 'admit-floor', 'abx-broad', 'discharge', 'observe'],
    criticalTreatmentIds: ['counselling'],
    emotionProfile: {
      opening: 'defensive',
      notes: 'You are clear-headed and fiercely independent. You feel pressured and worried about your son. You will not be talked down to, but you will listen to someone who respects you and offers a workable plan.',
      softenedBy: ['asks why you want to go home before arguing', 'treats you as able to decide', 'explains the risk honestly in plain words', 'offers practical alternatives (home care help, early review, safe oral treatment, a shorter stay)', 'says you can change your mind and come back at any time', 'asks about your son and offers to arrange help for him'],
      escalatedBy: ['talks down to you or calls you "ammachi" or "aunty" dismissively', 'threatens "you will die"', 'phones your relatives to override you', 'says "sign here that you take responsibility" without exploring', 'ignores what you said about your son'],
      reactions: ['"I am not confused, doctor, I know what I am saying"', 'tears up when speaking about her son', '"If someone can look after him, I will stay"', 'asks "What will happen if I go home today?"', 'asks whether she can come back the next morning for review', 'goes silent and then agrees to a compromise'],
      goal: 'Assess decision-making capacity (understand, retain, weigh, communicate), explore the reason for refusal, respect an informed decision, offer the safest workable alternative, document, and keep the door open with safety netting.',
    },
    rubric: rubric({
      data_gathering: [
        c('dg-01', 'Explores the reason for refusal', 3, 'ICE', 'Asks why she does not want to stay and finds the caregiving concern before trying to persuade her.'),
        c('dg-02', 'Capacity assessment', 3, 'PLAB2', 'Checks that she can understand the information, retain it, weigh it and communicate a choice, e.g. by asking her to explain her illness and the risks of leaving in her own words.'),
        c('dg-03', 'Checks current clinical status', 2, 'PLAB2', 'Asks about breathlessness, fever and confusion and notes her oxygen saturation and respiratory rate when deciding on safe alternatives.'),
      ],
      clinical_management: [
        c('cm-01', 'Explains the risks and the recommended option', 3, 'PLAB2', 'Explains in simple words that admission is advised, why (low oxygen, high infection markers) and what could happen at home, without threats.'),
        c('cm-02', 'Offers workable alternatives', 3, 'RCGP', 'Offers options such as arranging carer support for her son, a shorter observation, oral antibiotics with early review, or a return plan, and agrees one with her.'),
        c('cm-03', 'Respects a capacitous refusal and documents', 3, 'PLAB2', 'States that the decision is hers if she has capacity, documents the discussion, risks explained and her decision, and does not coerce or involve relatives to override her.'),
      ],
      interpersonal: [
        c('ip-01', 'Respectful tone', 3, 'NURSE', 'Acknowledges her independence and her responsibility for her son, uses her name, avoids patronising terms.'),
        c('ip-02', 'Empathic statements', 2, 'NURSE', 'Names her worry for her son and the difficulty of the choice.'),
        c('ip-03', 'Teach-back of risks and plan', 2, 'TEACH-BACK', 'Asks her to repeat the warning signs and the follow-up plan.'),
        c('ip-04', 'Leaves the door open', 2, 'SEGUE', 'Tells her she can change her mind and return any time, and how.'),
      ],
      safety_netting: {
        required_elements: [
          'Return immediately if breathing worsens, lips look blue, confusion, chest pain, unable to drink or very drowsy',
          'Review within 24 hours (clinic visit or a call) and a named contact',
          'She can come back for admission at any time, no questions asked',
        ],
        weight: 3,
      },
    }),
  },

  // ───────────── 6. Medication error disclosure (candour) ─────────────
  {
    id: 'comm-006',
    name: 'Geeta Menon',
    age: 49,
    gender: 'F',
    severity: 'stable',
    arrivalBlurb: 'Day-care follow-up. Yesterday she received a double dose of insulin because of a dosing error, had a hypoglycaemic episode overnight and recovered. She has not yet been told what happened.',
    chiefComplaint: 'Doctor, last night I woke up sweating and shaking and the nurses gave me a drip. Nobody told me why. I want to know what happened to me.',
    vitals: { hr: 84, bp: '124/78', spo2: 99, temp: 36.7, rr: 16 },
    anamnesis: [
      q('night', 'Tell me what you remember from last night.', 'I woke up at three, drenched, hands shaking, I could not speak properly. The nurse checked the sugar and ran to get a drip. I was so frightened.'),
      q('told', 'What have you been told?', 'Only that my sugar was low. When I asked why, they said the doctor would explain.'),
      q('fear', 'What are you worried about?', 'That there is some damage. That it will happen again. My husband says this is negligence.'),
      q('trust', 'How do you feel about the care here?', 'I trusted this hospital. Now I am not sure. I want to know the truth, not a story.'),
      q('feel', 'How do you feel today?', 'Tired, a mild headache. No more shakiness. I ate breakfast.'),
      q('husband', 'Is anyone with you?', 'My husband is outside. He is very angry. He wants to complain.', false),
      q('want', 'What would you like from us now?', 'The truth, an apology if it was a mistake, and a promise it will not happen to me or anyone else.'),
    ],
    testResults: [
      t('glucose', 'Overnight capillary glucose 38 mg/dL at 03:10, 126 mg/dL after IV dextrose. This morning fasting CBG 138 mg/dL.', true),
      t('ecg', 'Sinus rhythm 84/min, normal intervals, no ischaemic change.', false),
      t('bmp', 'Na 139, K 4.0 mmol/L, creatinine 0.8 mg/dL. Normal.', false),
    ],
    correctDiagnosisId: 'comm-duty-of-candour',
    diagnosisOptions: ['comm-duty-of-candour', 'comm-conceal-error', 'comm-vague-complication', 'comm-blame-nurse', 'comm-defensive-legal'],
    acceptableTreatmentIds: ['counselling', 'observe'],
    criticalTreatmentIds: ['counselling'],
    emotionProfile: {
      opening: 'angry',
      notes: 'You were terrified last night and nobody explained. You suspect something went wrong and you want the truth. You are angry at being kept in the dark more than at the mistake itself.',
      softenedBy: ['tells the truth plainly and early that a dosing error happened', 'apologises sincerely and personally', 'explains what happened, the effect on you and that you are now safe', 'says what will be done to stop it happening again and how you will be kept informed', 'invites your husband and your questions', 'does not blame an individual nurse'],
      escalatedBy: ['uses vague words such as "a complication" or "your sugar dipped"', 'blames the nurse or "the system" without owning it', 'talks about legal risk or tells you not to worry', 'hints that you may have eaten wrongly', 'avoids the word error'],
      reactions: ['"So there was a mistake? Say it clearly"', 'voice shaking, "I could have died"', 'asks "Will there be damage to my brain or heart?"', 'asks "Who did this?"', 'asks "How do I know it will not happen again?"', 'cools and says "Thank you for telling me the truth"'],
      goal: 'Disclose the medication error openly and promptly: say what happened, apologise, explain the effect and the current state, what is being done, and what happens next, with an offer of support and follow-up (duty of candour).',
    },
    rubric: rubric({
      data_gathering: [
        c('dg-01', 'Checks what she knows and how she is', 2, 'SPIKES', 'Asks what she remembers and has been told and checks her current symptoms and sugar before disclosing.'),
        c('dg-02', 'Establishes facts before the meeting', 2, 'PLAB2', 'States they have reviewed the chart and incident facts and are giving accurate information, not speculation.'),
        c('dg-03', 'Explores her concerns', 2, 'ICE', 'Asks what worries her (damage, trust, recurrence) and what she wants from the conversation.'),
      ],
      clinical_management: [
        c('cm-01', 'Clear honest disclosure', 3, 'PLAB2', 'Says plainly that she received twice the intended insulin dose because of an error, and that this caused the low sugar, without euphemism.'),
        c('cm-02', 'Explains effect and current safety', 3, 'PLAB2', 'Explains the low sugar was treated, that tests today are reassuring, what monitoring continues and what signs would need urgent review.'),
        c('cm-03', 'Action, reporting and follow-up', 3, 'PLAB2', 'Says the incident is being reported and investigated, what will change, who her named contact is, and offers to share the findings.'),
      ],
      interpersonal: [
        c('ip-01', 'Genuine apology', 3, 'NURSE', 'Gives a sincere personal apology ("I am sorry this happened to you") early, without conditions.'),
        c('ip-02', 'Does not blame an individual', 2, 'PLAB2', 'Takes responsibility for the hospital and avoids blaming a named nurse or doctor.'),
        c('ip-03', 'Empathy for fear and anger', 2, 'NURSE', 'Acknowledges the fear of last night and her anger at not being told.'),
        c('ip-04', 'Invites questions and the husband', 2, 'SEGUE', 'Offers to include her husband and answers questions openly, including about compensation or complaint routes.'),
        c('ip-05', 'Teach-back', 1, 'TEACH-BACK', 'Checks she has understood what happened and what comes next.'),
      ],
      safety_netting: {
        required_elements: [
          'Symptoms of low sugar to report immediately and what to do (sugar, call)',
          'Named contact for questions and the date for the follow-up meeting with the findings',
          'How to raise a formal complaint or concern if she wishes',
        ],
        weight: 2,
      },
    }),
  },

  // ───────────── 7. HIV diagnosis and confidentiality ─────────────
  {
    id: 'comm-007',
    name: 'Sanjay Patil',
    age: 34,
    gender: 'M',
    severity: 'stable',
    arrivalBlurb: 'Long-distance truck driver. Screened HIV reactive at an ICTC, now confirmed. His wife has come with him and is waiting outside; he has not told her.',
    chiefComplaint: 'Doctor, they told me to come for the report. Is it something serious? Please do not say anything in front of my wife.',
    vitals: { hr: 80, bp: '122/78', spo2: 99, temp: 36.8, rr: 16 },
    anamnesis: [
      q('why', 'Why did you get tested?', 'I had fever and weight loss, and a friend at the dhaba said to test. I had unprotected sex with women on the road, a few times, years ago.'),
      q('know', 'What do you know about HIV?', 'Only that people die of it and that families throw you out. A man in our village was.'),
      q('wife', 'Does your wife know you came for the test?', 'No. She thinks I am here for my stomach problem. She is expecting our second baby in three months.'),
      q('fear', 'What are you most afraid of?', 'That she will leave me, my parents will find out, and my company will sack me.'),
      q('confid', 'Who else may know?', 'Nobody. Please, I beg you, do not tell my wife or my owner.'),
      q('health', 'How is your health otherwise?', 'Some weight loss and night sweats. No cough now. No tuberculosis earlier.'),
      q('hope', 'What do you hope to hear?', 'That there is some treatment and that I can still work and see my child.'),
    ],
    testResults: [
      t('hiv', 'Reactive on three different rapid tests per the national testing strategy. Confirmed HIV-1 infection.', true),
      t('cbc', 'Hb 11.9 g/dL (low), WBC 5,900/mm3, platelets 2.1 lakh.', true),
      t('sputum-afb', 'Sputum AFB smear negative x2.', false),
    ],
    correctDiagnosisId: 'comm-hiv-confidentiality',
    diagnosisOptions: ['comm-hiv-confidentiality', 'comm-tell-wife-without-consent', 'comm-stigmatising-language', 'comm-no-partner-plan', 'comm-hiv-no-hope'],
    acceptableTreatmentIds: ['counselling', 'discharge'],
    criticalTreatmentIds: ['counselling'],
    emotionProfile: {
      opening: 'fearful',
      notes: 'You are terrified and ashamed. You came already expecting bad news. Your biggest fear is your wife finding out and the stigma. You hold on to the hope that treatment exists.',
      softenedBy: ['promises confidentiality clearly and explains its limits kindly', 'uses calm, non-judgmental words and does not ask about your sexual history in a shaming way', 'explains that HIV is a manageable condition with daily tablets and that a normal life is possible', 'explains how to protect your wife and unborn baby', 'offers to help you tell your wife, in your own time, and to be present', 'gives a clear next step (ART centre, baseline tests)'],
      escalatedBy: ['moralises or judges', 'uses words such as "positive for AIDS"', 'insists on telling the wife now', 'talks as if it is a death sentence', 'speaks loudly or with the door open'],
      reactions: ['"Please, do not tell my wife"', 'silence, then "I am finished, doctor"', '"Will I die? How long?"', '"Will my baby get it?"', 'asks "Can I still go to work and drive?"', 'asks "How will I tell her?"'],
      goal: 'Disclose an HIV diagnosis with empathy and hope, protect confidentiality (and explain the limits and the legal protections), counsel on treatment, prevention of transmission and the unborn baby, and support voluntary partner notification and linkage to care.',
    },
    rubric: rubric({
      data_gathering: [
        c('dg-01', 'Private setting, consent for who is present', 2, 'SPIKES', 'Ensures privacy, closes the door, asks him alone who may be told, does not discuss in front of the wife without his consent.'),
        c('dg-02', 'Perception and understanding of HIV', 2, 'SPIKES', 'Asks what he knows and what he fears about HIV before explaining.'),
        c('dg-03', 'Risk and partner assessment, non-judgmentally', 2, 'PLAB2', 'Asks about exposure and partners (wife, pregnancy) in neutral language without moralising.'),
      ],
      clinical_management: [
        c('cm-01', 'Clear disclosure with a warning shot', 3, 'SPIKES', 'Gives a warning shot and states clearly that the test confirms HIV infection, distinguishing HIV from AIDS.'),
        c('cm-02', 'Treatment and prognosis with hope', 3, 'PLAB2', 'Explains that daily ART keeps the virus controlled so he can stay healthy and work, that it is available free at the ART centre, and next steps such as CD4 and baseline tests.'),
        c('cm-03', 'Protection of wife and baby, partner notification', 3, 'PLAB2', 'Explains that his wife needs testing and the baby can be protected with treatment during pregnancy, and offers supported voluntary disclosure, with a plan and timeline.'),
        c('cm-04', 'Confidentiality and its limits', 3, 'PLAB2', 'Promises not to disclose without consent, explains the law protects his information and limits are narrow, and explains how his records are kept private.'),
      ],
      interpersonal: [
        c('ip-01', 'Non-judgmental language', 3, 'NURSE', 'Avoids blame and stigmatising words (e.g. "positive patient", "AIDS victim"), uses person-first language.'),
        c('ip-02', 'Empathic statements', 2, 'NURSE', 'Names fear and shame ("this must be frightening", "you were brave to come").'),
        c('ip-03', 'Plain words and teach-back', 2, 'TEACH-BACK', 'Explains in everyday words and asks him to restate the plan and who he can safely tell.'),
        c('ip-04', 'Hope and support', 2, 'NURSE', 'Offers counselling, peer support or support group and a follow-up appointment.'),
      ],
      safety_netting: {
        required_elements: [
          'Date and place of ART centre registration and baseline tests',
          'Symptoms needing urgent review (persistent fever, cough over two weeks, weight loss, diarrhoea)',
          'Safer sex until his wife is tested and counselled, and how to reach the counsellor',
        ],
        weight: 2,
      },
    }),
  },

  // ───────────── 8. Tobacco / gutka cessation (5 A's) ─────────────
  {
    id: 'comm-008',
    name: 'Ramakant Pawar',
    age: 41,
    gender: 'M',
    severity: 'stable',
    arrivalBlurb: 'Auto-rickshaw driver with a burning mouth and difficulty opening it fully. Chews gutka daily. Came because his wife insisted.',
    chiefComplaint: 'My mouth burns when I eat spicy food and I cannot open it fully. My wife made me come. It is nothing, no?',
    vitals: { hr: 78, bp: '130/84', spo2: 98, temp: 36.7, rr: 16 },
    anamnesis: [
      q('use', 'How much gutka and tobacco do you use?', 'Around ten packets a day for fifteen years. And a few bidis in the evening.'),
      q('why', 'What does it do for you?', 'It keeps me awake on night rides, and it calms my nerves. All the drivers chew.'),
      q('tried', 'Have you tried to stop?', 'Twice. I lasted three days. I got headaches, bad temper, could not concentrate. Then I started again.'),
      q('know', 'What do you know about the harm?', 'Some say it causes cancer. But my father chewed till eighty and nothing happened to him.'),
      q('ready', 'How do you feel about quitting?', 'Part of me wants to, for my children. Part of me says it is impossible. Maybe after the festival season.'),
      q('mouth', 'What symptoms in the mouth?', 'Burning for six months, white patches, the mouth does not open like before. Only two fingers fit.'),
      q('support', 'Who can help you?', 'My wife wants me to stop. My friends all chew. Money is short, I cannot afford expensive medicines.', false),
    ],
    testResults: [
      t('oral-biopsy', 'Epithelial atrophy with juxta-epithelial fibrosis, no dysplasia. Consistent with oral submucous fibrosis.', true),
      t('cbc', 'Hb 13.6 g/dL, WBC 7,100/mm3, platelets 2.5 lakh.', false),
    ],
    correctDiagnosisId: 'comm-brief-cessation-5as',
    diagnosisOptions: ['comm-brief-cessation-5as', 'comm-lecture-and-scare', 'comm-advice-only', 'comm-prescribe-no-plan', 'comm-accept-not-ready'],
    acceptableTreatmentIds: ['counselling', 'discharge'],
    criticalTreatmentIds: ['counselling'],
    emotionProfile: {
      opening: 'ambivalent',
      notes: 'You half know it is harming you but chewing is your coping tool at work and with friends. You will shut down if lectured, but you open up to someone who listens, respects your pace, and gives a small, doable plan.',
      softenedBy: ['asks permission before giving advice', 'asks what you enjoy about gutka and what worries you', 'links the mouth problem to your own life, your children and your work', 'accepts that you are not fully ready and offers a small first step', 'offers practical help (quitline, nicotine replacement, a cut-down plan, follow-up)', 'praises your two earlier attempts'],
      escalatedBy: ['lectures or scares you with cancer photos', 'says "just stop"', 'judges your job or friends', 'gives no plan or follow-up', 'pushes a quit date you are not ready for'],
      reactions: ['"Everyone chews, it is nothing"', 'jokes about his father who chewed till eighty', 'goes quiet at the word cancer and then "Could this become cancer?"', 'says "I tried, I failed, I am weak"', 'says "Maybe I can cut down first"', 'asks what he can use when cravings come'],
      goal: 'Use the 5 A\'s (Ask, Advise, Assess readiness, Assist, Arrange follow-up) with motivational, non-judgmental style: link the mouth findings to tobacco, explore ambivalence, agree a small realistic plan and follow-up.',
    },
    rubric: rubric({
      data_gathering: [
        c('dg-01', 'Ask: type and amount of tobacco', 2, '5As', 'Asks about all forms of tobacco (gutka, bidi) and amount, and the pattern (cravings, triggers, work).'),
        c('dg-02', 'Previous attempts and barriers', 2, '5As', 'Explores earlier attempts, what happened and what got in the way (withdrawal, stress, friends).'),
        c('dg-03', 'Assess readiness', 3, '5As', 'Asks how ready he is to quit, using a scale or open question, and responds to his answer.'),
      ],
      clinical_management: [
        c('cm-01', 'Advise: clear, personalised', 3, '5As', 'Asks permission, then advises clearly that quitting is the most important thing for his mouth and health, linking the burning and tight mouth (oral submucous fibrosis) to gutka and the risk of cancer.'),
        c('cm-02', 'Assist: realistic plan', 3, '5As', 'Helps set a small plan (quit date or cut-down), manage cravings and withdrawal, avoid triggers, and offers the national tobacco quitline, counselling or nicotine replacement where appropriate.'),
        c('cm-03', 'Arrange follow-up and treat the mouth', 3, '5As', 'Arranges a follow-up date, mentions mouth-opening exercises and regular oral checks, and refers to dentistry or oral surgery as needed.'),
      ],
      interpersonal: [
        c('ip-01', 'Motivational, non-judgmental style', 3, 'NURSE', 'Uses open questions, reflects, supports autonomy, and avoids lecturing and scare tactics.'),
        c('ip-02', 'Affirms effort and strengths', 2, 'NURSE', 'Acknowledges his two earlier attempts and his motivation (children, wife).'),
        c('ip-03', 'Plain words', 2, 'PLAB2', 'Explains the biopsy and risks without jargon.'),
        c('ip-04', 'Teach-back', 2, 'TEACH-BACK', 'Asks him to say what he will do first and when, and checks his confidence.'),
      ],
      safety_netting: {
        required_elements: [
          'Return sooner for non-healing ulcer, lump, bleeding, increasing difficulty opening the mouth, or voice change',
          'Follow-up date to review progress and mouth opening',
          'Whom to call or visit if cravings or relapse occur, with no judgment',
        ],
        weight: 2,
      },
    }),
  },
];

export type CommsClinicId = 'communication-skills';

export const COMMS_CASES_BY_SPECIALTY: Record<CommsClinicId, PatientCase[]> = {
  'communication-skills': comms,
};

/** "Diagnosis" labels: the key communication goal versus common poor approaches. */
export const COMMS_DIAGNOSIS_LABELS: Record<string, string> = {
  // 1 Breaking bad news
  'comm-spikes-bad-news': 'Break serious news with SPIKES (check understanding, warning shot, plain words, empathise)',
  'comm-blunt-disclosure': 'Blunt disclosure with no preparation',
  'comm-false-reassurance': 'False reassurance or minimising',
  'comm-disclose-to-family-first': 'Tell the family first instead of the patient',
  'comm-jargon-dump': 'Technical explanation with jargon and statistics',
  // 2 Stillbirth
  'comm-stillbirth-disclosure': 'Disclose a stillbirth clearly and gently, without blame',
  'comm-euphemism-lost-baby': 'Use euphemisms ("we lost the baby") without saying the baby has died',
  'comm-platitudes-have-another': 'Platitudes such as "you can have another"',
  'comm-defer-to-mother-in-law': 'Speak mainly to the relative instead of the mother',
  'comm-rush-to-induction': 'Rush to procedures and paperwork',
  // 3 Consent
  'comm-informed-consent': 'Obtain valid informed consent (benefits, material risks, alternatives, time to decide)',
  'comm-signature-only': 'Treat consent as getting a signature',
  'comm-risks-minimised': 'Minimise the risks to get agreement',
  'comm-decision-by-son': 'Let the relative decide instead of the patient',
  'comm-risk-list-no-context': 'Fast risk list with no context or check of understanding',
  // 4 Angry relative
  'comm-deescalation-complaint': 'De-escalate an angry relative: listen, apologise, act, follow up',
  'comm-defensive-excuses': 'Defend the service and make excuses',
  'comm-call-security': 'Threaten security or tell them to calm down',
  'comm-blame-staff': 'Blame other staff or departments',
  'comm-ignore-until-calm': 'Ignore the complaint until the person calms down',
  // 5 Refusal / capacity
  'comm-refusal-capacity': 'Respect a capacitous refusal: assess capacity, explore, offer alternatives, document',
  'comm-paternalistic-override': 'Override the patient wishes paternalistically',
  'comm-accept-without-exploring': 'Accept the refusal without exploring reasons or offering options',
  'comm-threaten-consequences': 'Threaten with consequences ("you will die")',
  'comm-relative-decides': 'Call relatives to overrule the patient',
  // 6 Candour
  'comm-duty-of-candour': 'Disclose the medication error openly and apologise (duty of candour)',
  'comm-conceal-error': 'Conceal or deny the error',
  'comm-vague-complication': 'Describe it vaguely as "a complication"',
  'comm-blame-nurse': 'Blame an individual colleague',
  'comm-defensive-legal': 'Respond defensively citing legal risk',
  // 7 HIV
  'comm-hiv-confidentiality': 'Disclose HIV with empathy, protect confidentiality, support partner notification',
  'comm-tell-wife-without-consent': 'Tell the wife without the patient consent',
  'comm-stigmatising-language': 'Use judgmental or stigmatising language',
  'comm-no-partner-plan': 'Give the result with no plan for partner or baby',
  'comm-hiv-no-hope': 'Present HIV as untreatable',
  // 8 Cessation
  'comm-brief-cessation-5as': 'Brief tobacco cessation using the 5 A\'s with a motivational style',
  'comm-lecture-and-scare': 'Lecture and scare tactics',
  'comm-advice-only': 'Say "stop chewing" and nothing else',
  'comm-prescribe-no-plan': 'Offer medicine with no plan or follow-up',
  'comm-accept-not-ready': 'Drop the topic because he is not ready',
};
