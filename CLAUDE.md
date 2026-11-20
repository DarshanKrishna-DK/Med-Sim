# MedSim: Claude Code project notes

Browser-based clinical training simulator, built for the "Build with Agora – Bengaluru 2026" hackathon (Track 3, "AI Agents That Get Things Done"). Doctor-POV game: a third-person doctor avatar spawns in a hospital corridor, walks through one of 24 specialty doors into a clinic room, and sees one outpatient at a time (~10 cases per specialty, 240 in total). You interview the patient by voice, speak orders, and a charge-nurse agent carries them out with tool calls. Voice runs over Agora RTC + Agora Conversational AI (Sarvam STT → Sarvam LLM → Murf Falcon TTS), with transcripts over Agora RTM. Tests resolve instantly; unbuilt domains show "Coming soon".

## Tech stack

- **Frontend:** React 18 + TypeScript + Vite, Three.js via `@react-three/fiber` and `@react-three/drei`. 2D UI follows a pixel-art night/paper design system (Jersey 10 + Amarna fonts).
- **Voice (transport):** `agora-rtc-sdk-ng` (mic + remote agent audio) and `agora-rtm` v2 (transcripts) in the browser.
- **Voice (agent):** Agora Conversational AI Engine, REST v2 `/join`, started by the backend. ASR = Sarvam STT (inside Agora, language auto-detect), LLM = Sarvam (`sarvam-105b`, OpenAI-compatible; Groq or Agora-managed OpenAI as fallbacks via `PATIENT_LLM_PROVIDER`), TTS = Murf Falcon (vendor `murf`). There is no separate voice worker process.
- **Backend HTTP:** one FastAPI process at `http://127.0.0.1:8787`. `/voice/*` (start, stop, speak, context, tts) mints RTC+RTM tokens (vendored AgoraIO builder in `backend/agora_token/`) and drives the Agora agent. `/agent/nurse/act` is the agentic charge nurse. `/agent/debrief/simple` grades the encounter.
- **Nurse agent:** function-calling loop with tools `find_in_catalog`, `order_test`, `check_allergies_and_interactions`, `prescribe`, `schedule_follow_up`. Plans, runs at least two coordinated calls, adapts (e.g. holds amoxicillin for a penicillin allergy), confirms by voice (Murf), updates the chart and the patient's context. Triggered by the doctor's final transcripts or typed orders.
- **State:** single `Store` class with `useSyncExternalStore` (see `src/game/store.ts`). No Redux/Zustand, don't add one.
- **MCP:** project `.mcp.json` has `agora-docs` (https://mcp.agora.io). Murf MCP (`uvx murf-mcp`) is configured in local scope.

## Key files (what to read first)

- `src/game/store.ts`: single source of truth for game state (polyclinic encounter, chart, notifications, archive).
- `src/game/types.ts`: `PatientCase`, `ActivePatient`, `GameState`.
- `src/game/clinic.ts`: the 24 specialty IDs and display order.
- `src/data/polyclinicPatients.ts` / `tests.ts` / `treatments.ts` / `medications.ts`: pure data files (240 cases).
- `src/components/three/`: corridor + clinic room scenes, player avatar (`Player.tsx`), interaction bus.
- `src/components/encounter/`: encounter HUD, voice panel, nurse feed.
- `src/voice/`: Agora RTC/RTM session and the patient persona prompt builder (adult vs pediatric: parent speaks for child).
- `src/agents/nurseAgent.ts` / `simpleDebrief.ts`: clients for `/agent/nurse/act` and `/agent/debrief/simple`.
- `src/agents/managedAgent.ts` / `customTools.ts`: optional Anthropic Managed Agent attending (only if `ANTHROPIC_API_KEY` is set).
- `backend/server.py`: FastAPI app, routes, CORS, shared-secret check.
- `backend/voice.py`: Agora Conversational AI + Murf wiring. `backend/nurse.py`: nurse agent and tools. `backend/debrief.py`: debrief grading. `backend/llm_provider.py`: Sarvam/Groq/managed selection.
- `backend/README.md`: endpoint reference.
- `spec.md`: hackathon submission plan and requirements checklist.

## Commands

- `npm run dev`: Vite dev server (proxies `/agent/*` and `/voice/*` to the backend).
- `npm run build`: tsc + vite build.
- `npm run preview`: preview production build.
- `npm run verify`: deterministic invariant checks on `src/data/*` and the scene. Run after every data/type/store edit.
- `npm test`: Node test runner over `scripts/test/`.
- Backend: `backend/.venv/Scripts/python.exe backend/server.py`: listens on 8787; one process hosts everything voice and agent related.
- Backend tests: `backend/.venv/Scripts/python.exe -m unittest discover backend/tests`.

### Running node-binary wrappers on this machine

Group policy on BrynQ dev machines blocks `.exe` wrappers under `node_modules/.bin/`: this hits `tsx.exe`, `vite.exe`, `tsc.exe`, `npx`, and anything else that gets compiled to a shim executable. Symptom: `This program is blocked by group policy`.

Workarounds baked into the repo:
- `npm run dev` → `node node_modules/vite/bin/vite.js`
- `npm run build` → `node node_modules/typescript/bin/tsc -b && node node_modules/vite/bin/vite.js build`
- `npm run verify` → `node scripts/verify/run-all.ts` (Node 22+ runs `.ts` natively via type-stripping)

When adding a new script that would normally invoke a binary wrapper, use the same `node node_modules/<pkg>/bin/<entry>.js` pattern. Do not add `tsx` as a devDependency.

## How to work in this repo

- **Keep changes minimal.** Bug fix = bug fix. Don't refactor adjacent code "while you're there."
- **Data files are data.** If you're adding a new case/test/medication, edit the data file, don't plumb new shape through the store unless the game mechanic genuinely changed.
- **Three.js scene edits:** the corridor and clinic rooms have fixed floor/wall dimensions. New meshes must respect the floor plane and not overlap existing furniture, verify by running the dev server and rotating the camera, not by eyeballing numbers.
- **No new state libraries.** The `Store` class handles everything. If you need derived state, compute it in a selector or in the component.
- **Voice runs through Agora.** The browser loads no STT/TTS models; ASR, LLM and TTS all run inside the Agora Conversational AI agent. Only `/voice/context` can change the running agent's prompt (`llm.system_messages`).
- **New agent tools** live server-side in `backend/nurse.py`. Keep the tool list and the frontend's expectations in sync.
- **Reference docs:** use the `agora-docs` MCP for Agora questions rather than guessing at REST parameters.

## Model routing

| Call | Model | Why |
|---|---|---|
| Patient voice (inside Agora Conversational AI) | Sarvam `sarvam-105b` (Groq / Agora-managed OpenAI as fallbacks) | Low latency, multilingual, runs inside Agora |
| Charge nurse agent (`/agent/nurse/act`) | Sarvam → Groq fallback | Function calling over the OpenAI-compatible API |
| Debrief grading (`/agent/debrief/simple`) | Sarvam → Groq fallback | JSON output: score, domains, strengths, improvements |
| Optional `medsim-attending` Managed Agent | Anthropic Opus | Only active if `ANTHROPIC_API_KEY` is set |

When you add a new LLM-backed feature, decide which bucket it falls in and route it through the backend.

## API keys

All keys server-side only, in `backend/.env.local` (template: `backend/.env.example`). The browser never sees them.

- `AGORA_APP_ID` / `AGORA_APP_CERTIFICATE`: RTC/RTM token minting.
- `AGORA_CUSTOMER_ID` / `AGORA_CUSTOMER_SECRET`: Conversational AI REST auth.
- `MURF_API_KEY` / `MURF_REGION` (+ voice IDs), Murf Falcon TTS, both inside Agora and for `/voice/tts`.
- `SARVAM_API_KEY`: STT inside Agora, patient LLM, nurse, debrief.
- `GROQ_API_KEY`: fallback LLM. `PATIENT_LLM_PROVIDER` selects `sarvam` | `groq` | `managed`.
- `ANTHROPIC_API_KEY`: optional, Managed Agent attending only.

Vite proxies `/agent/*` and `/voice/*` to `127.0.0.1:8787` in dev. Never print or copy values from `.env.local`, and never reintroduce a `VITE_*` secret.

## Out of scope

- Multi-agent handoffs and self-verifying rubrics.
- A persistent user account system, the simulator is single-player, single-shift.
- Any medical claim of clinical accuracy. Cases are plausible but synthetic.

## Don't

- Don't create specialist sub-agents (`triage-expert`, `pharmacology-expert`, …). Use skills in `.claude/skills/` and let Claude compose them.
- Don't write long rigid bullet lists of rules here, Opus follows them literally and over-triggers. Encode hard rules as hooks or lint instead.
- Don't commit `.env.local`, large voice sample clips, or anything under `node_modules/`, `backend/.venv/`, `dist/`.
