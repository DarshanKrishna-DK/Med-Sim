# Clinical accuracy audit (2026-11-21)

Scope: 255 polyclinic cases (240 synthetic in `polyclinicPatients.ts`, 15 adapted real cases in `realCases.ts`), the ER cases in `patients.ts` (automated checks only), `medications.ts`, `defaultTestResults.ts`.

Two passes:

1. **Automated**: `scripts/verify/clinical-consistency.ts`, wired into `npm run verify` as the 5th check. It covers diagnosis ids and labels, test, treatment and medication ids, abnormal flags against a reference-range table (Hb by sex, age and pregnancy, WBC, platelets, Na, K, creatinine, glucose, HbA1c, TSH, ALT/AST, bilirubin, CRP, troponin) and explicit "(low)/(high)" annotations, vitals plausibility for age, sex-specific diagnoses and tests, and paediatric dosing guidance for drugs indicated in cases under 12. Intentional edge cases are in its `WHITELIST`, each with a reason.
2. **Clinical review** of each specialty against ICMR, NICE/BNF/BNFc, WHO, IAP, ADA, GINA, KDIGO, ESC, EULAR/ACR, ECCO, EAU and AAO guidance. Only clear errors were changed. Items that need a judgement call are listed at the end under "Left for a human".

Notes on the tables: "abx" means antibiotics. In treatment ids, `analgesia` is morphine and `steroids-iv` is IV methylprednisolone (see `treatments.ts`). That is why many outpatient cases had these removed.

## Demo data added

| Case | Field | Change | Reason |
|---|---|---|---|
| im-005 | anamnesis | + `allergy`: "Any drug allergies?" / penicillin rash and lip swelling after amoxicillin | Gives the nurse agent a documented penicillin allergy to hold amoxicillin against (CAP case). |
| ent-003 | anamnesis | + `allergy`: "Any allergy to medicines?" / penicillin hives | Same, for a strep tonsillitis case. |

## polyclinicPatients.ts

| Case | Field | Before | After | Reason / reference |
|---|---|---|---|---|
| card-007 | cbc | Hgb 12.8 "Normal" (76 M) | Hgb 13.6 | 12.8 is anaemia in a man (WHO <13). |
| card-007 | arrivalBlurb | no orthostatic BP | + lying 136/80, standing at 3 min 110/68 | The diagnosis needs a documented fall of at least 20/10 (ESC Syncope 2018). |
| ortho-006 | hba1c | 5.7% "Normal" | 5.4% | 5.7% is the prediabetes threshold (ADA 2025). |
| ortho-007 | crp | CRP 6 "mildly elevated", flagged normal | CRP 3 mg/L, normal | Text contradicted the flag, and degenerative tendinopathy does not raise CRP. |
| ortho-008, peds-002, peds-003, peds-004 | crp abnormal | false | true | CRP 6-9 mg/L, described as elevated, is above the ULN of 5. |
| obgyn-010 | cbc | Hgb 11, normal | "Hgb 11 (mild anemia)", abnormal | At 8 weeks postpartum the non-pregnant WHO cut-off (<12) applies. |
| im-001 | acceptableTreatmentIds | + analgesia | removed | Morphine has no role in iron deficiency anaemia. |
| im-002 | acceptableTreatmentIds | + admit-floor | removed | Stable B12 deficiency is treated as an outpatient (BSH 2014). |
| im-004 | hba1c | 9.4% (75 mmol/mol) | 9.4% (79 mmol/mol) | IFCC conversion. |
| im-004 | acceptableTreatmentIds | + iv-fluids | removed | Euvolaemic, no DKA. |
| im-005 | rubric cm-04 | amoxicillin first line | doxycycline or clarithromycin, avoiding amoxicillin and co-amoxiclav | The patient now has a documented penicillin allergy (NICE NG250). |
| im-005 | acceptableTreatmentIds | + analgesia | removed | Morphine is not needed in low-risk CAP. |
| im-005 | safety net | call 999 | call 108/112 | Indian emergency numbers. |
| im-007 | urine-cx | "Pending; >10^5 ..." | ">10^5 ..." | The result contradicted itself. |
| card-002 | acceptableTreatmentIds | + aspirin | removed | Aspirin is not stroke prevention in AF; a DOAC is needed at CHA2DS2-VASc 3 (ESC 2024, NICE NG196). |
| card-003 | chiefComplaint, orthopnoea | mailbox, three pillows | one flight of stairs, two pillows | The history read as NYHA III against an NYHA II answer. |
| card-003 | troponin | 12 ng/L "chronic elevation", abnormal | 22 ng/L chronic stable, no delta | 12 is below the 99th centile. |
| card-003 | lft | values normal, flagged abnormal | "Normal", flagged normal | All values in range. |
| card-006 | treatments | analgesia critical | aspirin critical; aspirin, discharge, admit-floor acceptable | Pericarditis: high-dose aspirin or NSAID plus colchicine (ESC 2015). |
| neuro-001 | treatments | analgesia critical | discharge critical; analgesia removed | No opioids for migraine (NICE CG150). |
| neuro-002, neuro-004, neuro-006 | acceptableTreatmentIds | + analgesia | removed | TTH, CTS and TN: opioids are inappropriate (NICE CG150, CG173). |
| neuro-007 | treatments | analgesia critical | discharge critical; surgery-consult acceptable | NICE NG59. Foot drop warrants spinal referral. |
| neuro-007 | diagnosisOptions | lumbar-disc-herniation | piriformis-syndrome | The MRI-proven herniation made that distractor equally correct. |
| neuro-008 | acceptableTreatmentIds | + analgesia | removed | NICE CG150 cluster headache. |
| neuro-010 | rpr | "neurosyphilis excluded" | "Non-reactive." | A serum RPR cannot exclude neurosyphilis. |
| derm-001, derm-009 | acceptableTreatmentIds | + steroids-iv | removed | Psoriasis: systemic steroids risk a rebound flare (NICE CG153). Alopecia areata: IV steroids are not indicated (BAD 2012). |
| endo-005 | testResults | no cortisol | + cortisol 2.1 mcg/dL, ACTH 640 | Addison's needs biochemical confirmation (Endocrine Society 2016). |
| endo-007 | testResults | no BMD | + DEXA T -2.9 / -2.6 | Osteoporosis needs a confirming BMD (NOGG 2022). |
| endo-008 | arrival, CC, answer | bitemporal field loss | headache, low libido, nipple discharge; vision fine | Field loss contradicts "8 mm microadenoma, no chiasmal effect". |
| gi-006 | treatments | admit-floor critical, steroids-iv | discharge critical, steroids-iv removed | Moderate UC that does not meet Truelove-Witts is managed as an outpatient (ECCO 2022). |
| gi-008 | diagnosisOptions | hemorrhoids-grade2 | anal-fistula | A spontaneously reducing prolapse is grade II, so the distractor was equally correct. |
| pulm-005 | cbc | Eosinophils 6%, abnormal | 9% | 6% is within normal limits. |
| pulm-009 | bmp | Ca 10.8 (high-normal) | (mildly elevated) | Above 10.4. |
| neph-001 | diagnosisOptions | diabetic-nephropathy, hypertensive-nephrosclerosis | iga-nephropathy, nephrotic-syndrome-membranous | Both distractors were valid causes of this CKD (KDIGO CGA). |
| neph-002 | diagnosisOptions | kidney-stone-5mm | appendicitis | Same disease as the answer. |
| neph-010 | acceptableTreatmentIds | + steroids-iv | removed | KDIGO 2021: no steroid monotherapy in membranous nephropathy. |
| rheum-003 | treatments | analgesia critical | discharge critical; analgesia removed | Gout flare: NSAID, colchicine or steroid (ACR 2020). |
| rheum-006 | treatments | steroids-iv critical | discharge critical | PMR: oral prednisolone 12.5-25 mg (EULAR/ACR 2015). |
| rheum-001, 004, 005, 009, 010 | acceptableTreatmentIds | analgesia (and steroids-iv in rheum-001) | removed | Opioids are not recommended in RA, OA, axSpA, fibromyalgia or ReA (EULAR, NICE NG226). |
| heme-002 | correctDiagnosisId | iron-deficiency (with iron-deficiency-anemia as a distractor) | iron-deficiency-anemia; distractor anemia-chronic-disease | Hb 9.5 with MCV 72 is IDA, so the keyed answer was the less correct one. |
| heme-005 | treatments | admit-floor critical | discharge critical | Chronic-phase CML without leukostasis is managed as an outpatient (ELN 2020). |
| heme-009 | anamnesis | "Mediterranean background" | cousin with thalassaemia major | Indian setting; the family history is the relevant cue. |
| id-008 | testResults | mri-brain "Not performed." | removed | Placeholder artifact. |
| allergy-004 | diagnosisOptions | urticaria-chronic | atopic-dermatitis | Synonym of the correct answer. |
| allergy-006 | name | Rajinder Singh (F) | Rajinder Kaur | A Sikh woman's surname is Kaur. |
| obgyn-004 | diagnosisOptions | pcos | ovarian-cyst | Synonym of pcos-obgyn. |
| obgyn-006 | acceptableTreatmentIds | + analgesia | removed | No opioids for endometriosis pain (ESHRE 2022). |
| obgyn-008 | treatments | discharge acceptable; abx critical | discharge removed; admit-floor critical | A tubo-ovarian abscess needs admission (CDC 2021, RCOG GTG 32). |
| uro-002 | acceptableTreatmentIds | + analgesia | removed | EAU chronic pelvic pain guideline. |
| uro-003 | anamnesis | prior stone 2 years ago | first episode | A prior stone made the nephrolithiasis-recurrent distractor true. |
| uro-008 | diagnosisOptions | bph-moderate (55 F) | bladder-cancer | Sex mismatch. |
| ent-003 | diagnosisOptions | strep-pharyngitis-child | herpangina | At 17 this was also correct. |
| ent-006 | cbc, options | Eos 5% abnormal; allergic-rhinitis-seasonal | Eos 9% (AEC 720); deviated-septum | 5% is normal. The distractor was equally correct. |
| ent-007 | options, treatments | chronic-rhinosinusitis; steroids-iv | allergic-rhinitis-seasonal; removed | CRSwNP is the same disease (EPOS 2020). IV steroids are not indicated. |
| ent-010 | testResults | no audiometry | + audiometry 45 dB SNHL over 3 frequencies | SSNHL needs audiometric confirmation (AAO-HNS 2019). |
| oph-008 | acceptableTreatmentIds | + steroids-iv | removed | Anterior uveitis is treated with topical steroid and cycloplegic (AAO PPP). |
| oph-009 | vitals rr | 18 (5 y) | 22 | Below the age norm. |
| ortho-002 | xr | high-riding head, AHI <7 mm | AHI preserved 9 mm | The original findings imply a massive tear, not a partial one. |
| ortho-003 | options, critical | sciatica-l5; analgesia critical | trochanteric-bursitis; discharge critical | Duplicate correct answer. NICE NG59. |
| ortho-008 | xr text | "Ottawa rules negative on imaging" | removed | Ottawa rules are a clinical rule applied before imaging. |
| peds-001, peds-003, peds-005 | acceptableTreatmentIds | + analgesia | removed | No morphine for AOM, HFMD or febrile seizure in toddlers. |
| peds-002 | vitals | HR 132, SpO2 91, RR 32 | HR 122, SpO2 93, RR 28 | The old values met BTS "severe" criteria, contradicting "moderate" and discharge. |
| peds-003, peds-009 | vitals rr | 20, 22 | 26, 28 | Below the age norms (APLS). |
| peds-007 | options, treatments | atopic-dermatitis; antihistamine (IV) | seborrheic-dermatitis; removed | Duplicate answer. IV antihistamine is not used for eczema (NICE CG57). |
| peds-008 | options, treatments | tonsillitis-strep; analgesia | herpangina; removed | Duplicate answer. Use paracetamol, not morphine. |
| peds-009 | options, tests | iron-deficiency-anemia; Hb/MCV only | anemia-chronic-disease; + RBC/Mentzer/RDW, ferritin 4 | Duplicate answer. The data now separates IDA from thalassaemia trait (IAP). |
| gs-002 | options | hemorrhoids | colorectal-cancer | Superset of the answer. |
| gs-004 | options | gallstones-biliary-colic | acute-hepatitis | The history was textbook biliary colic. |
| onc-001 | cxr | left upper lobe mass | right upper lobe | The shoulder pain is right-sided. |
| onc-003 | treatments | discharge acceptable | steroids-iv and surgery-consult added, discharge removed | Suspected MSCC (NICE NG234). |
| onc-004 | options, urine | cervical-cancer; microscopic haematuria | bladder-cancer; gross haematuria | The US proves a cervical primary (duplicate answer). The patient reports visible blood. |
| onc-006 | bnp | 110 pg/mL, normal | 28 pg/mL | 110 is abnormal and the CHF distractor needed excluding. |
| onc-010 | acceptableTreatmentIds | iv-fluids | admit-icu | An NS bolus worsens SIADH hyponatraemia (European hyponatraemia guideline 2014). |
| nsg-001 | anamnesis | word-finding trouble | apathy, slowed thinking | A right frontal lesion does not cause dysphasia. |
| nsg-002, 003, 004, 006, 007, pmr-002, pmr-005 | diagnosisOptions | a distractor that was a synonym or superset of the answer | replaced (frozen-shoulder, hip-oa-moderate, trochanteric-bursitis, meningioma, normal-pressure-hydrocephalus, epidural-fibrosis, compression-fracture-pathologic) | Two correct options per case. |
| nsg-008 | mri | "no cord" at L5-S1 | "no cauda equina compression" | The cord ends at L1-2. |
| ctv-006 | cbc, ecg | WBC 9.8 "mildly elevated"; diffuse PR depression | within normal limits; no PR depression or ST elevation | 9.8 is normal. PR depression made the pericarditis distractor correct. |
| (labels) | POLYCLINIC_DIAGNOSIS_LABELS | missing | + low-back-pain, uterine-fibroid, pulmonary-embolism | Distractors in onc-003, 004 and 006 had no label. |

## realCases.ts

| Case | Field | Before | After | Reason |
|---|---|---|---|---|
| rc-infectious-disease-2 | hba1c | 5.9%, flagged normal | "(prediabetes range)", abnormal | ADA 5.7-6.4%. |
| rc-infectious-disease-2 | peripheral-smear | bone-marrow text only | + "Smear: severe thrombocytopenia, no blasts." | The result is filed under the smear test. |
| rc-infectious-disease-3 | cbc | Platelets 145, normal | "(mildly low)", abnormal | <150. |
| rc-endocrinology-1 | free-t4 | 66.66 ng/dL | 66.66 pmol/L | 66.66 ng/dL is physiologically impossible. Please verify against the paper. |
| rc-endocrinology-2 | acceptableTreatmentIds | + discharge | removed | TSH 221, Na 119 and effusions: discharge is unsafe. |
| rc-allergy-immunology-1 | acceptableTreatmentIds | no epi-im | + epi-im | Tongue swelling, dysphagia and dyspnoea meet anaphylaxis criteria (WAO 2020). |
| rc-hematology-1 | cbc | TLC 4.65 | TLC 4.65 x10^3/uL | Missing unit. |
| REAL_CASE_DIAGNOSIS_LABELS | | 45 distractor ids with no label | labels added | Every option now has a display label. |
| REAL_CASE_MED_LINKS | montelukast-10 | indicated for amitriptyline-hypersensitivity | removed | No role in a drug exanthem or angioedema. |
| REAL_CASE_MED_LINKS | ferrous-sulfate-325 | absent | indicated for hht | Ferritin 5 in HHT (HHT guideline 2020). |

## medications.ts

| Drug | Field | Change | Reason |
|---|---|---|---|
| hctz-25 | CI | - nephrolithiasis-recurrent | Thiazides prevent calcium stones (AUA 2019, EAU). |
| metformin-500 | CI | - ckd-stage3a | Continue at eGFR 45 or above (KDIGO 2022). |
| amlodipine-5 | CI | - chf-nyha2 | Neutral in HFrEF (PRAISE, ESC 2021). |
| metoprolol-50 | CI | - copd-gold2 | Cardioselective beta-blockers are safe in COPD (GOLD 2024). |
| paracetamol-500 | CI, dose | - chronic-hepatitis-b/c; + child 15 mg/kg/dose, max 60 mg/kg/day | Paracetamol is the preferred analgesic in viral hepatitis (BNF). IAP/BNFc dosing. |
| tacrolimus-01-oint | indications | - atopic-dermatitis-child | The 0.1% strength is licensed from 16 y; children need 0.03% (NICE TA82). |
| pantoprazole-40 | indications | - gerd-infant | No PPI for regurgitation in a thriving infant (NICE NG1). |
| prednisone-burst | dose, indications | + asthma, child and PMR doses; - nephrotic-syndrome-membranous | GINA 2024, BTS, EULAR/ACR 2015, KDIGO 2021. |
| amoxicillin-clavulanate-1g | dose, indications | + child mg/kg; - pid-outpatient | IAP/AAP AOM. Not a PID regimen (CDC 2021, NACO). |
| azithromycin-500 | dose, indications | 3-day / enteric-fever regimen; - chronic-bronchitis | The old regimen summed to 3 g, which is not a recognised course (ICMR 2019). No antibiotics for stable bronchitis (GOLD). |
| doxycycline-100 | dose, indications | + child 2.2 mg/kg; - chronic-bronchitis | AAP Red Book, ICMR scrub typhus. GOLD. |
| ciprofloxacin-500 | indications | - uti-uncomplicated, - brucellosis | No FQ for cystitis (ICMR 2019, NICE NG109). WHO brucellosis regimen is doxycycline plus rifampicin. |
| acyclovir-800 | dose | + HSV keratitis 400 mg 5×, child varicella 20 mg/kg, renal | AAO, Red Book, BNF. |
| estradiol-patch | dose | + progestogen if uterus intact | Prevents endometrial hyperplasia (NICE NG23). |
| aspirin-100 | indications | - paroxysmal-afib | NICE NG196. |
| sumatriptan-50 | indications | - cluster-headache | No oral triptan for cluster (NICE CG150). |
| gabapentin-300 | indications | - sciatica-l5, carpal-tunnel, lumbar-disc-herniation | NICE NG59, CKS. |
| donepezil-5 | indications | - mild-cognitive-impairment | AAN 2018, NICE NG97. |
| loperamide-2 | indications, CI | ibs-c moved to CI | Constipating (NICE CG61). |
| lactulose-syrup | indications, dose | - ibs-c; + child doses | NICE CG61, BNFc. |
| metoclopramide-10 | indications | - gerd | ACG 2022. Tardive dyskinesia risk. |
| methotrexate-15 | indications | - ulcerative-colitis | ECCO 2022 (MERIT-UC). |
| calcium-vitd | indications | - hyperparathyroidism-primary | Hypercalcaemia with stones. |
| folic-acid-5 | indications | - b12-deficiency, b12-pernicious, iron-deficiency-anemia | Folate alone can precipitate SACD (BNF). Not indicated for IDA. |
| ferrous-sulfate-325 | indications, CI, dose | thalassemia-trait moved to CI; + child 3 mg/kg/day | Iron overload risk. IAP. |
| spironolactone-25 | indications, dose | - pcos, pcos-obgyn; + child mg/kg | Both PCOS cases are trying to conceive (teratogenic anti-androgen). BNFc. |
| furosemide-40 | indications | - pleural-effusion-parapneumonic | Treatment is antibiotics and drainage (BTS 2023). |
| thiamine-100 | indications | - chronic-fatigue | NICE NG206. |
| empagliflozin-10 | indications | + ckd-stage3a | KDIGO 2022 1A. |
| allopurinol-300 | dose | start 100 mg and titrate | ACR 2020 hypersensitivity risk. |
| quetiapine-25 | dose | + bipolar titration targets | 25 mg is sub-therapeutic (NICE CG185). |
| hydroxychloroquine-200 | dose | max 5 mg/kg/day | AAO 2016 retinopathy. |
| penicillin-v-500, cetirizine-10, salbutamol-inh, budesonide-inh | dose | + paediatric clauses | BNFc, NICE NG84, GINA 2024. |

## defaultTestResults.ts

| Test | Before | After | Reason |
|---|---|---|---|
| troponin | 0.01 ng/mL, ref <0.04 ng/mL | 4 ng/L, ref <26 ng/L (sex-specific) | Labelled high-sensitivity but used a conventional cTnI cut-off (ESC 2023). |
| skin-biopsy | "benign inflammatory dermatosis" as the normal default | Normal epidermis and dermis | The normal default described a disease. |

## Whitelisted in the checker

- derm-009: TSH 4.2 annotated mildly elevated. Many Indian labs use an upper limit of 4.0; the borderline value is the intended autoimmunity clue.
- rc-dermatology-1: SGPT 30.9 "borderline high" is the report's value. The female ULN is 25-33 (ACG 2017).

## Left for a human (not changed)

- **Grading is diagnosis-level, not patient-level.** Amoxicillin/co-amoxiclav remain "indicated" for community-acquired-pna and tonsillitis-strep, so `gradePrescription` still rewards them in im-005 and ent-003 despite the new penicillin allergy. Only the nurse agent's allergy check blocks them.
- **Catalogue gaps:** plain amoxicillin, ceftriaxone/cefixime (gonococcal PID), artesunate, vitamin K, an NSAID or paracetamol treatment id (many outpatient cases list morphine `analgesia` as their only analgesic; ent, ortho and gs-003/004/007 kept it), low-dose prednisolone for PMR, oxcarbazepine, tenofovir/entecavir, omeprazole or alginate for infants, a prolactin test, a PTH test, ABI/duplex, and immunoglobulins.
- **Combined OCP for pcos and endometriosis:** every such case is trying to conceive. Letrozole is first line there, but the OCP is appropriate for these diagnoses in general.
- **PTU for carbimazole cholestatic hepatitis** (REAL_CASE_MED_LINKS): ATA 2016 favours definitive therapy. Check what the source report did.
- **Real-case oddities that are probably faithful to the reports:** rc-endocrinology-1 ABG (pH 7.40 with pCO2 23 and HCO3 19.6), rc-allergy-immunology-1 urine pH 4, rc-infectious-disease-3 GeneXpert reporting INH resistance, rc-endocrinology-2 low SAAG.
- Missing confirmatory data: allergy-008 (C4 and C1-INH), allergy-010 (immunoglobulins), endo-008/009 (prolactin, PTH), oph-001/006, ctv-009/010, onc-010 (CT head). Ambiguity remains in pid-gonococcal vs pid-outpatient, endo-006 (microalbuminuria vs the nephropathy distractor), and gs-005/008/010 (US findings filed under us-abdomen/us-pelvis).
- `steroids-iv` is still acceptable in a few stable outpatient cases (pulm-001, pulm-009, rheum-002, derm-010, ent-010 critical). Bell's palsy and adrenal crisis need oral prednisolone and IV hydrocortisone respectively, not methylprednisolone.
- Implausible distractors: gestational-dm in a 58 F and a 62 F (im-004, endo-006), prostatitis-chronic in a female (im-007), osteoporosis-postmenopausal in a 55 M (im-009).
- `src/data/newDomainCases.ts` did not exist at audit time. The checker runs on it automatically once it is wired into POLYCLINIC_CASES.
