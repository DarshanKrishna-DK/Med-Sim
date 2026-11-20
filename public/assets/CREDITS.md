# Third-party assets (3D world)

All files are local copies so the demo does not depend on third-party CDNs.

| File | Source | Licence |
|---|---|---|
| characters/rpm-male.glb | three.js examples, `examples/models/gltf/readyplayer.me.glb` (Ready Player Me avatar) | Ready Player Me avatar terms, as redistributed with the three.js examples (MIT repository) |
| characters/rpm-female.glb | TalkingHead by met4citizen, `avatars/brunette-t.glb` (Ready Player Me avatar), https://github.com/met4citizen/TalkingHead | CC BY-NC 4.0 (non-commercial use, attribution: Ready Player Me / TalkingHead) |
| characters/Xbot.glb | three.js examples, `examples/models/gltf/Xbot.glb` (Mixamo). Used only as the animation source (idle / walk / run), never rendered | Mixamo / Adobe, as redistributed with the three.js examples |
| hdri/hospital_room_1k.hdr | Poly Haven, "Hospital Room" HDRI, https://polyhaven.com/a/hospital_room | CC0 |
| models/potted_plant_02/*_lod.glb | Poly Haven, "Potted Plant 02", https://polyhaven.com/a/potted_plant_02 (decimated with glTF-Transform) | CC0 |
| models/wheelchair_01/*_lod.glb | Poly Haven, "Wheelchair 01", https://polyhaven.com/a/wheelchair_01 (decimated) | CC0 |
| models/korean_fire_extinguisher_01/*_lod.glb | Poly Haven, "Korean Fire Extinguisher 01", https://polyhaven.com/a/korean_fire_extinguisher_01 (decimated) | CC0 |
| models/wall_clock/ | Poly Haven, "Wall Clock", https://polyhaven.com/a/wall_clock | CC0 |
| models/plastic_monobloc_chair_01/ | Poly Haven, "Plastic Monobloc Chair 01", https://polyhaven.com/a/plastic_monobloc_chair_01 | CC0 |
| fonts/inter-*.woff, *.woff2 | Inter by Rasmus Andersson, via @fontsource/inter 5.0.18 | SIL Open Font License 1.1 |
| fonts/noto-devanagari-600.woff2 | Noto Sans Devanagari (Google), via @fontsource/noto-sans-devanagari 5.3.0 | SIL Open Font License 1.1 |

Everything else in the corridor and clinic room (walls, doors, signage, furniture,
textures for floor, ceiling, sky view, artwork, hair, dupatta, stethoscope) is
generated procedurally in code.

## Auscultation sounds (sounds/)

Trimmed to 8-10 s, mixed to mono, loudness-normalised and re-encoded as 64 kbps MP3 with ffmpeg.
The CC BY-SA clips stay under CC BY-SA (same licence as the source); the code of this repository stays MIT.

| File | Source | Author | Licence |
|---|---|---|---|
| sounds/normal-heart.mp3 | Wikimedia Commons, "Human heart beating at 61 bpm (Cc-by-3.0).ogg", https://commons.wikimedia.org/wiki/File:Human_heart_beating_at_61_bpm_(Cc-by-3.0).ogg | Benboncan (Freesound.org) | CC BY 3.0 |
| sounds/murmur-systolic.mp3 | Wikimedia Commons, "Ventricular Septal Defect.wav" (pansystolic murmur, 6-14 s segment), https://commons.wikimedia.org/wiki/File:Ventricular_Septal_Defect.wav | Emmadon3 (Emma Donnelly) | CC BY-SA 4.0 |
| sounds/crackles.mp3 | Wikimedia Commons, "Crackles pneumoniaO.ogg", https://commons.wikimedia.org/wiki/File:Crackles_pneumoniaO.ogg | James Heilman, MD | CC BY-SA 3.0 |
| sounds/wheeze.mp3 | Wikimedia Commons, "Wheeze2O noise reduced.ogg", https://commons.wikimedia.org/wiki/File:Wheeze2O_noise_reduced.ogg | James Heilman, MD; noise reduction by Natural Philo | CC BY-SA 3.0 |

No openly licensed recordings were found for diastolic murmur, S3 gallop, pericardial rub, normal
vesicular breathing, bronchial breathing or absent breath sounds. Those are synthesised at runtime with
the Web Audio API in `src/voice/auscultation.ts` (no files).

## Radiology reading room images (radiology/)

Downloaded from Wikimedia Commons (licence re-checked on each file page via the Commons API, 2026-11-21),
resized to at most 1200 px and re-encoded as JPEG (each under 400 KB). The attribution is also shown on
screen under every film. CC BY-SA images stay under CC BY-SA; the code of this repository stays MIT.
The patient vignettes paired with the images are synthetic and are not the people in the images.

| File | Source | Author | Licence | Changes |
|---|---|---|---|---|
| radiology/cxr-normal.jpg | Wikimedia Commons, "Chest Xray PA 3-8-2010.png", https://commons.wikimedia.org/wiki/File:Chest_Xray_PA_3-8-2010.png | Stillwaterising | CC0 1.0 | resized |
| radiology/cxr-lobar-pneumonia.jpg | Wikimedia Commons, "X-ray of lobar pneumonia.jpg", https://commons.wikimedia.org/wiki/File:X-ray_of_lobar_pneumonia.jpg | Mikael Häggström, M.D. | CC0 1.0 | resized |
| radiology/cxr-pneumothorax.jpg | Wikimedia Commons, "Chest X-ray of pneumothorax.png", https://commons.wikimedia.org/wiki/File:Chest_X-ray_of_pneumothorax.png | Bonilla A, Blair AJ, Alamro SM, et al., J Med Case Reports 2019 | CC BY 4.0 | cropped to panel A, resized |
| radiology/cxr-pleural-effusion.jpg | Wikimedia Commons, "Bilateral Pleural Effusion.jpg", https://commons.wikimedia.org/wiki/File:Bilateral_Pleural_Effusion.jpg | Sara Nabih | CC BY-SA 4.0 | resized |
| radiology/cxr-cardiomegaly.jpg | Wikimedia Commons, "Cardiomegalia.JPG", https://commons.wikimedia.org/wiki/File:Cardiomegalia.JPG | SCiardullo | CC BY-SA 3.0 | resized |
| radiology/cxr-tb-cavitation.jpg | Wikimedia Commons, "Tuberculosis-x-ray-1.jpg", https://commons.wikimedia.org/wiki/File:Tuberculosis-x-ray-1.jpg | CDC Public Health Image Library | Public domain | re-encoded |
| radiology/axr-sbo.jpg | Wikimedia Commons, "Upright X-ray demonstrating small bowel obstruction.jpg", https://commons.wikimedia.org/wiki/File:Upright_X-ray_demonstrating_small_bowel_obstruction.jpg | James Heilman, MD | CC BY-SA 3.0 | resized |
| radiology/cxr-pneumoperitoneum.jpg | Wikimedia Commons, "Chest X-ray showing presence of free air under left diaphragm.png", https://commons.wikimedia.org/wiki/File:Chest_X-ray_showing_presence_of_free_air_under_left_diaphragm.png | Cerevisae | CC BY-SA 4.0 | cropped to the chest film, caption removed, resized |
| radiology/ecg-stemi.jpg | Wikimedia Commons, "12 Lead EKG ST Elevation tracing only.jpg", https://commons.wikimedia.org/wiki/File:12_Lead_EKG_ST_Elevation_tracing_only.jpg | Displaced (Wikimedia Commons user) | Public domain | resized |
| radiology/ecg-af.jpg | Wikimedia Commons, "ECG Atrial Fibrillation 98 bpm.jpg", https://commons.wikimedia.org/wiki/File:ECG_Atrial_Fibrillation_98_bpm.jpg | Ewingdo | CC BY-SA 4.0 | resized |
| radiology/ecg-chb.jpg | Wikimedia Commons, "3rd degree heart block.PNG", https://commons.wikimedia.org/wiki/File:3rd_degree_heart_block.PNG | Gregory Marcus, MD, MAS, FACC | CC BY 3.0 | re-encoded |
| radiology/ecg-hyperk.jpg | Wikimedia Commons, "Hyperkalemia ECG.jpg", https://commons.wikimedia.org/wiki/File:Hyperkalemia_ECG.jpg | Dr. Michael-Joseph F. Agbayani and Dr. Eddieson Gonzales | CC BY 4.0 | re-encoded |
| radiology/ct-edh.jpg | Wikimedia Commons, "EpiduralHematoma.jpg", https://commons.wikimedia.org/wiki/File:EpiduralHematoma.jpg | James Heilman, MD | CC BY-SA 4.0 | re-encoded |
| radiology/ct-sdh.jpg | Wikimedia Commons, "Trauma subdural.jpg", https://commons.wikimedia.org/wiki/File:Trauma_subdural.jpg | Glitzy queen00 (English Wikipedia) | Public domain | resized |
| radiology/ct-stroke.jpg | Wikimedia Commons, "Leftsidedstroke.png", https://commons.wikimedia.org/wiki/File:Leftsidedstroke.png | James Heilman, MD | CC BY-SA 4.0 | re-encoded |
| radiology/us-gallstones.jpg | Wikimedia Commons, "Gallstones.PNG", https://commons.wikimedia.org/wiki/File:Gallstones.PNG | James Heilman, MD | CC BY-SA 3.0 | re-encoded |
| radiology/xr-colles.jpg | Wikimedia Commons, "Collesfracture.jpg", https://commons.wikimedia.org/wiki/File:Collesfracture.jpg | Lucien Monfils | CC BY-SA 3.0 | resized |
| radiology/xr-nof.jpg | Wikimedia Commons, "Cdm hip fracture 343.jpg", https://commons.wikimedia.org/wiki/File:Cdm_hip_fracture_343.jpg | Booyabazooka | CC BY-SA 3.0 | resized |
