# New clinical domains (8 clinics, 64 cases)

Source: `src/data/newDomainCases.ts`. Merged into `POLYCLINIC_CASES` and
`POLYCLINIC_DIAGNOSIS_LABELS` in `polyclinicPatients.ts`; new drugs are appended
to `MEDICATIONS` (with de-duplicated links onto existing drugs) in
`medications.ts`. All cases are synthetic teaching cases for Indian MBBS
students and interns, not clinical guidance.

Wiring: `ClinicId` + labels (`src/game/clinic.ts`), corridor doors now `built(...)`
(`src/components/world/corridorLayout.ts`), Hindi signage (`hindi.ts`,
palliative care changed to उपशामक देखभाल), pixel glyphs (`PixelIcon.tsx`, new
`tooth`), 18 new tests (`tests.ts` + normal defaults in `defaultTestResults.ts`),
17 new treatment ids (`treatments.ts`, so auto-rubric "critical actions" read
as real actions), 2 new drug categories (`emergency`, `dental-oral`).

## Geriatrics

| Case | Diagnosis (correct) | Key teaching point |
|---|---|---|
| ger-001 | falls-polypharmacy | Zolpidem + amitriptyline + glimepiride (HbA1c 5.9%); deprescribe, vitamin D |
| ger-002 | delirium-uti | 4AT 8, acute fluctuating course, collateral history; no sedatives |
| ger-003 | alzheimer-dementia | Gradual 2-year course, MMSE 19, attention intact; ECG before donepezil |
| ger-004 | osteoporosis-fragility-fracture | L1 wedge, T-score -3.1, steroids, early menopause; replete vitamin D, dental check before bisphosphonate |
| ger-005 | bph-moderate | PSA age-appropriate, PVR 70 mL, OTC antihistamine worsens LUTS |
| ger-006 | hypothyroidism-elderly | TSH 28 with IHD: levothyroxine 25 mcg, start low |
| ger-007 | b12-deficiency-neuropathy | Metformin + Jain vegetarian diet + PPI; Romberg positive, MCV 106 |
| ger-008 | orthostatic-hypotension-drug-induced | Prazosin + tamsulosin duplication + new thiazide; lying-standing BP |

## Palliative care

| Case | Diagnosis | Key teaching point |
|---|---|---|
| pal-001 | cancer-pain-bone-mets | WHO step 3: oral morphine IR 5 mg 4-hourly + 1/6 breakthrough, laxative; exclude MSCC and hypercalcaemia; RT referral |
| pal-002 | cancer-related-breathlessness | SpO2 94%, oxygen not indicated; fan, breathing techniques, low-dose morphine |
| pal-003 | opioid-induced-constipation | No laxative co-prescribed; flatus present, Ca normal |
| pal-004 | opioid-induced-nausea | Haloperidol 0.5-1.5 mg nocte (CTZ) |
| pal-005 | end-of-life-transition | Breaking news, wishes (home in Varanasi), deprescribe BP and statin |
| pal-006 | persistent-hiccups | Gastric distension; metoclopramide, baclofen; Na/Ca/urea normal |
| pal-007 | malignant-bowel-obstruction | Multi-level MBO: admit, stop senna and metoclopramide (colic), hyoscine butylbromide, dexamethasone |
| pal-008 | caregiver-burden | Carer strain, risk screen negative; respite and family meeting |

## Neonatology (parent answers)

| Case | Diagnosis | Key teaching point |
|---|---|---|
| neo-001 | physiological-jaundice | TSB 13.8 at 144 h, well below threshold; sunlight not a treatment |
| neo-002 | breastfeeding-inadequate-intake | Not back to birth weight at 3 weeks; latch, frequency, no prelacteal water |
| neo-003 | oral-thrush-neonatal | Nystatin to baby, treat maternal nipples and nappy rash, sterilise pacifier |
| neo-004 | umbilical-granuloma | Exclude omphalitis and urachal / vitelline remnant; salt or silver nitrate |
| neo-005 | gonococcal-ophthalmia-neonatorum | Onset day 2-5, GNID on Gram stain; admit, ceftriaxone, treat parents |
| neo-006 | infantile-colic | Thriving baby, no red flags; carer coping (shaken-baby prevention) |
| neo-007 | lbw-cold-stress | 36.2 C, 1.8 kg preterm: KMC, delay bathing, sepsis screen negative |
| neo-008 | ddh | Breech, first-born girl, family history; Graf IIc; stop tight swaddling, Pavlik |

## Sports medicine

| Case | Diagnosis | Key teaching point |
|---|---|---|
| spm-001 | ankle-sprain-gr2 | Ottawa rules negative; functional rehab, no heat or massage early |
| spm-002 | acl-tear | Pop + haemarthrosis + giving way; MRI; reconstruction for pivoting athlete |
| spm-003 | patellar-tendinopathy | Load management; steroid injection contraindicated |
| spm-004 | tibial-stress-fracture | Focal tenderness, night pain, X-ray normal, MRI positive; RED-S (amenorrhoea, low vit D, iron) |
| spm-005 | rotator-cuff-tendinopathy | Painful arc, strength preserved, no tear on US |
| spm-006 | sport-concussion-graded-return | Still symptomatic on SCAT6: no play this weekend, graded RTL/RTS |
| spm-007 | exertional-heat-stroke-recovery | Labs normalised; graded return with 10-14 day heat acclimatisation |
| spm-008 | hamstring-strain-gr2 | Mid-thigh MTJ tear, avulsion excluded |

## Plastic surgery

| Case | Diagnosis | Key teaching point |
|---|---|---|
| pls-001 | deep-partial-thickness-burn-hand | Hand is a special area; unhealed at day 10: refer for excision and grafting; Td |
| pls-002 | keloid | Recurs after simple excision; intralesional triamcinolone, silicone |
| pls-003 | cleft-lip-palate-fit-for-repair | Rule of 10s met (12 weeks, 5.6 kg, Hb 10.8) |
| pls-004 | pressure-injury-stage3 | Offloading, cushion, nutrition; colonisation is not infection |
| pls-005 | lipoma | Under 5 cm, superficial, slow: benign features |
| pls-006 | ganglion-cyst | Reassure, aspiration or excision only if symptomatic |
| pls-007 | superficial-ssi | Open and drain, MSSA, uncontrolled diabetes; necrotising fasciitis features absent |
| pls-008 | flexor-tendon-injury-zone2 | FDS + FDP test, digital nerve, glass FB on X-ray; urgent hand surgery, Td |

## Dentistry

| Case | Diagnosis | Key teaching point |
|---|---|---|
| den-001 | irreversible-pulpitis | Lingering cold pain; RCT; antibiotics NOT indicated (contraindicated) |
| den-002 | acute-periapical-abscess | Systemic spread (fever): drainage + amoxicillin (+/- metronidazole); airway red flags absent |
| den-003 | chronic-periodontitis | Smoking, HbA1c 8.8%; scaling and root planing, chlorhexidine short course |
| den-004 | oral-submucous-fibrosis | Gutka, trismus, no dysplasia; cessation is the key action |
| den-005 | recurrent-aphthous-stomatitis | Behcet, IBD, haematinic screen negative; topical steroid |
| den-006 | pericoronitis | Fever + node: irrigation, metronidazole; recurrent, so plan extraction |
| den-007 | dentine-hypersensitivity | Short sharp pain, vital pulp, abrasion and erosion; KNO3 toothpaste |
| den-008 | leukoplakia-dysplasia | Speckled lateral-tongue patch, otalgia, moderate dysplasia: excise, tobacco cessation |

## Emergency medicine (walk-in ED)

| Case | Diagnosis | Key teaching point |
|---|---|---|
| emd-001 | kidney-stone-5mm | NSAID first line, MET with tamsulosin for distal stone; no fever |
| emd-002 | anaphylaxis-food-observed | After IM adrenaline, observe (biphasic risk), adrenaline plan, allergy referral |
| emd-003 | viper-envenomation-hemotoxic | 20WBCT incoagulable = envenomated: ASV now, ICU (AKI); no NSAIDs or IM injections |
| emd-004 | dog-bite-category-3 | Wash 15 min, ARV + RIG infiltration, Td (last dose 6 y), breastfeeding no barrier |
| emd-005 | organophosphate-poisoning | Decontaminate (staff PPE), atropine doubling to atropinisation, ICU |
| emd-006 | heat-stroke | Cool first (target under 39 C fast); antipyretics contraindicated |
| emd-007 | acute-diarrhoea-some-dehydration | WHO Plan B ORS 75 mL/kg over 4 h + zinc; no antibiotics or antidiarrhoeals |
| emd-008 | sulfonylurea-hypoglycemia | IV dextrose; glibenclamide + CKD = recurrent hypos, admit, stop glibenclamide |

## Anaesthesiology (pre-anaesthesia check-up)

| Case | Diagnosis | Key teaching point |
|---|---|---|
| pac-001 | pac-anticipated-difficult-airway | Prior grade 4 laryngoscopy, MP IV, TMD 5.5 cm; airway plan / regional |
| pac-002 | pac-osa-high-risk | STOP-BANG 8/8, bicarbonate normal; proceed with OSA precautions |
| pac-003 | pac-defer-uncontrolled-htn | 188/112 on repeat, LVH; defer elective TKR, restart amlodipine, stop diclofenac |
| pac-004 | pac-defer-uncontrolled-diabetes | HbA1c 10.4% (above 8.5%): defer and optimise |
| pac-005 | pac-warfarin-bridging | Mechanical mitral valve = high thrombotic risk: LMWH bridge; DOAC contraindicated |
| pac-006 | pac-defer-uncontrolled-asthma | PEF 52%, recent exacerbation; defer, step up ICS-formoterol; avoid NSAIDs |
| pac-007 | pac-mh-susceptible | Family history of intra-op hyperthermia and rigidity: trigger-free anaesthesia, dantrolene available |
| pac-008 | pac-defer-pregnancy | Positive hCG with live IUP; defer elective cholecystectomy |

## Dosing references

- Morphine, senna, haloperidol, hyoscine butylbromide, dexamethasone, baclofen (palliative): WHO cancer pain guideline 2018; NICE CG140 (opioids in palliative care); BNF Prescribing in palliative care; Twycross Palliative Care Formulary.
- Levothyroxine 25 mcg start in elderly / IHD: NICE NG145; BNF.
- Hydroxocobalamin 1 mg alternate days (neurological involvement): BNF.
- Alendronate, calcium + vitamin D: NOGG 2022 / NICE TA464.
- Nystatin 100,000 units QDS (neonate and child): BNF for Children.
- Ceftriaxone 25-50 mg/kg single dose, max 125 mg (gonococcal ophthalmia neonatorum): CDC STI Treatment Guidelines 2021; WHO. Cefotaxime if hyperbilirubinaemic or premature.
- Silver sulfadiazine (avoid under 2 months, sulfonamide allergy): BNF.
- Intralesional triamcinolone 10-40 mg/mL: International Advisory Panel on Scar Management.
- Cefalexin 500 mg QDS, amoxicillin 500 mg TDS, metronidazole: BNF; SDCEP Drug Prescribing for Dentistry (antibiotics only with spreading infection / systemic signs, not for pulpitis).
- Chlorhexidine 0.2% 10 mL BD: BNF / SDCEP.
- Adrenaline IM 0.5 / 0.3 / 0.15 mg: Resuscitation Council UK anaphylaxis 2021.
- ASV 8-10 vials initial, 6 vials 6-hourly by 20WBCT, same dose in children: Ministry of Health and Family Welfare India, Standard Treatment Guidelines: Management of Snake Bite (2017).
- Rabies PEP (Essen IM 0,3,7,14,28; updated Thai Red Cross ID 0,3,7,28; ERIG 40 IU/kg, HRIG 20 IU/kg into wounds): National Guidelines for Rabies Prophylaxis, NCDC India 2019; WHO position paper 2018.
- Td 0.5 mL IM: Indian MoHFW / WHO tetanus guidance.
- Atropine doubling regimen, pralidoxime 30 mg/kg then 8 mg/kg/h: Eddleston et al., Lancet 2008; WHO.
- Dextrose 25% 50-100 mL or 10% 150-200 mL (adult), 2 mL/kg 10% (child): JBDS-IP hypoglycaemia guideline 2023 / ISPAD.
- ORS 75 mL/kg over 4 h, zinc 20 mg x 14 days (10 mg under 6 months): WHO/IMNCI, IAP.
- Enoxaparin 1 mg/kg BD bridging; bridging for mechanical mitral valve: ACC 2017 periprocedural anticoagulation pathway; ACCP 2022.
- Dantrolene 2.5 mg/kg then 1 mg/kg (up to 10 mg/kg): AAGBI malignant hyperthermia guideline 2020; EMHG.
- PAC thresholds: AAGBI/BHS 2016 (defer if clinic BP 180/110 or above); JBDS-IP 2023 (HbA1c above 8.5% / 69 mmol/mol); SASM 2016 (OSA); GINA (asthma control before elective surgery).
- Neonatal thresholds: AAP 2022 hyperbilirubinaemia guideline; WHO thermal care (cold stress 36.0-36.4 C); NICE / AAP DDH screening (US at 4-6 weeks for risk factors).
- Concussion: Amsterdam consensus (CISG) 2023, SCAT6. Exertional heat stroke return: ACSM expert consensus 2023.
