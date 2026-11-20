# Real published cases in MedSim

Source: PubMed Central open access (Europe PMC), CC BY only. Each case is a paraphrased adaptation: new de-identified patient names, short patient-voice answers, vitals not in the report are plausible fills (noted). Provenance lives in `PatientCase.source` and shows as a chip and Source line in the Library. Code: `src/data/realCases.ts`. Attribution: authors retain copyright; changes were made (adaptation for simulation).

Not clinical guidance. Distractor diagnoses and treatment ids are ours, not the authors'.

| Our id | Condition | Citation | URL | Licence | Adapted |
|---|---|---|---|---|---|
| rc-infectious-disease-1 | Dengue + leptospirosis + paratyphoid A co-infection | Simon J et al., Cureus 2024 | https://doi.org/10.7759/cureus.67487 | CC BY 4.0 | 33M, fever 5d; vitals, CBC/LFT/CRP/ESR, serology, culture values as reported. Temp filled in (not reported). |
| rc-infectious-disease-2 | Post-dengue immune thrombocytopenia | Sahoo D et al., Cureus 2024 | https://doi.org/10.7759/cureus.75124 | CC BY 4.0 | Female 'in her forties' (44 chosen); bleeding history, platelets 5,000, C3/C4, ANA, bone marrow as reported. Temp filled. |
| rc-infectious-disease-3 | Peritoneal TB with pulmonary TB | Gundapaneni SRC et al., Clin Case Rep 2026 | https://doi.org/10.1002/ccr3.73493 | CC BY 4.0 | 48M; labs, imaging, ascitic fluid as reported. Vitals not reported, filled. Treatment (second-line regimen) mapped to admission. |
| rc-hematology-1 | Hereditary hemorrhagic telangiectasia type 1 | Dhaka M et al., Cureus 2026 | https://doi.org/10.7759/cureus.117613 | CC BY 4.0 | 70M; Hb 4.1, MCV 59, ferritin 5, echo/CTA findings as reported. Vitals not reported, filled. |
| rc-endocrinology-1 | Graves thyroid storm with thyrotoxic periodic paralysis | Banavathu T et al., Arch Acad Emerg Med 2021 | https://doi.org/10.22037/aaem.v9i1.1083 | CC BY 3.0 | 40F; HR 160, BP 98/68, K 2.25, TSH/FT4/FT3, TRAb, liver abscess as reported. SpO2 filled. |
| rc-endocrinology-2 | Myxedema ascites | Sankar A et al., Cureus 2026 | https://doi.org/10.7759/cureus.115389 | CC BY 4.0 | 63M; HR 54, BP 145/68, TSH 221.2, ascitic fluid indices as reported. Temp, RR filled. |
| rc-endocrinology-3 | Carbimazole-induced cholestatic hepatitis | Maliyakkal AM et al., Cureus 2021 | https://doi.org/10.7759/cureus.15241 | CC BY 4.0 | 30F (Doha, Qatar report); LFT and thyroid values as reported. Vitals not reported, filled. |
| rc-dermatology-1 | Vitiligo vulgaris with autoimmune hypothyroidism | Kumar P et al., Cureus 2025 | https://doi.org/10.7759/cureus.91669 | CC BY 4.0 | 34F; TSH 2.5, FT4 15.3, Hb 11.6, SGPT 30.9 as reported. HR 72 reported; other vitals filled. |
| rc-dermatology-2 | Lepromatous leprosy (histoid-like) | Varun H et al., Front Med 2025 | https://doi.org/10.3389/fmed.2025.1596617 | CC BY 4.0 | 50M; BI 6+, MI 95%, biopsy as reported. Vitals not reported, filled. |
| rc-pediatrics-1 | Wilson disease presenting as nephrotic syndrome | Gupta G et al., Cureus 2025 | https://doi.org/10.7759/cureus.86250 | CC BY 4.0 | 8M; BP 108/68, LFT, INR 2.7, ceruloplasmin 9.88, urinary Cu 536, USG as reported. Other vitals filled. |
| rc-pediatrics-2 | Scrub typhus meningoencephalitis | Singh P et al., Cureus 2024 | https://doi.org/10.7759/cureus.53060 | CC BY 4.0 | 5F; CBC, LFT, CSF values, scrub IgM index 76.25 as reported. Vitals not reported, filled. |
| rc-neurology-1 | GBS (AMSAN) after chikungunya | Sreelakshmi V et al., Neurol Res Pract 2024 | https://doi.org/10.1186/s42466-024-00315-6 | CC BY 4.0 | 21F; Na 126, K 3.4, CSF albuminocytological dissociation, chik IgM, NCS as reported. Vitals filled. |
| rc-allergy-immunology-1 | Amitriptyline hypersensitivity (exanthem + angioedema) | Singh BP et al., Cureus 2025 | https://doi.org/10.7759/cureus.91469 | CC BY 4.0 | 34F; HR 130, RR 25, ESR 30, CRP 9, urine findings as reported. BP, SpO2, temp filled. |
| rc-gastroenterology-1 | Losartan-induced sub-fulminant hepatitis | Sadhu K et al., Cureus 2026 | https://doi.org/10.7759/cureus.112160 | CC BY 4.0 | 43M; ALT 940, AST 1,240, bili 12.8, INR 2.8, CT as reported. BP, temp, RR reported; HR, SpO2 filled. |
| rc-pulmonology-1 | Pulmonary hydatid cyst after treated TB | Shahid AR et al., Clin Case Rep 2026 | https://doi.org/10.1002/ccr3.71799 | CC BY 4.0 | 28F, Peshawar patient (South Asian name used); vitals, CXR/CT, labs as reported. |

Skipped: Sureja 2023 (organising pneumonia in RA) because its licence text conflicts (CC BY-NC text vs CC BY link).
