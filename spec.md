# Spec: MedSim, Build with Agora submission

**Event:** Build with Agora – Bengaluru 2026 (solo).
**Track:** 3, "AI Agents That Get Things Done".
**One sentence:** A voice-driven clinical simulator where an Agora Conversational AI agent plays the patient, the player is the doctor, and a charge-nurse agent turns the doctor's spoken orders into coordinated tool calls on the chart.

---

## Requirements checklist

| Requirement | Status | Where it lives |
|---|---|---|
| Agora Conversational AI | done | `POST /voice/start` mints RTC+RTM tokens and calls Agora REST v2 `/join`; browser joins via `agora-rtc-sdk-ng`, transcripts over `agora-rtm`. `POST /voice/context` pushes `llm.system_messages` via `/update`. `/voice/speak`, `/voice/stop`. |
| Murf AI Falcon TTS | done | Patient voice: TTS vendor `murf` inside the Agora agent. Nurse voice: `POST /voice/tts` (Murf Falcon HTTP, `audio/mpeg`). |
| Agentic tool calls (>= 2 coordinated) | done | `POST /agent/nurse/act`: `find_in_catalog`, `order_test`, `check_allergies_and_interactions`, `prescribe`, `schedule_follow_up`. |
| End-to-end user journey | done | Corridor -> specialty door -> patient interview -> spoken orders -> nurse executes -> patient informed -> debrief. |
| Working demo | done | `npm run dev` + `backend/server.py`; see README for setup. |

## Agent loop (Track 3)

1. **Initiate.** Doctor picks a door and a case. `/voice/start` launches the patient agent (persona prompt from `src/voice/`).
2. **Plan.** A final doctor transcript (or typed order) goes to `/agent/nurse/act`. The nurse decides which tools to call.
3. **Execute.** At least two coordinated calls, e.g. `find_in_catalog` then `order_test`, then `prescribe`.
4. **Adapt.** `check_allergies_and_interactions` flags a conflict (e.g. penicillin allergy); the nurse holds the drug and substitutes or asks.
5. **Confirm and follow-up.** The nurse speaks the result (Murf), `schedule_follow_up` is called, the chart updates, and `/voice/context` tells the patient agent what was done.

## Models and providers

| Call | Provider |
|---|---|
| Patient STT | Sarvam STT inside Agora (language auto-detect) |
| Patient LLM | Sarvam `sarvam-105b`; Groq or Agora-managed OpenAI as fallbacks (`PATIENT_LLM_PROVIDER`) |
| Patient and nurse TTS | Murf Falcon |
| Nurse agent, debrief | Sarvam, falling back to Groq |
| Optional attending | Anthropic Opus via Managed Agents, only if `ANTHROPIC_API_KEY` is set |

## Demo script (<= 3 minutes)

| Time | Beat |
|---|---|
| 0:00-0:20 | Pitch in one sentence. Doctor avatar walks the corridor, shows the 24 specialty doors, enters one. |
| 0:20-0:55 | Patient appears. Press `T`, interview by voice. Show live transcript and the patient answering in a Murf Falcon voice. Mention language auto-detect. |
| 0:55-1:35 | Say: "Order a CBC and a chest X-ray, and start amoxicillin." Show the nurse panel: plan, `find_in_catalog`, `order_test`, `prescribe`. |
| 1:35-2:10 | Adapt: allergy check blocks amoxicillin (penicillin allergy). Nurse speaks the substitution in her Murf voice. |
| 2:10-2:30 | Follow-up scheduled; patient agent now references what was ordered (`/voice/context`). Chart updated. |
| 2:30-2:50 | Finish the encounter, debrief screen with score and strengths/improvements. |
| 2:50-3:00 | Architecture slide (Agora RTC/RTM + ConvoAI, Sarvam, Murf), repo link. |

Pre-flight: backend `/health` shows all providers configured, mic allowed, case chosen with a documented allergy.

## Test surface

- `npm run verify` - invariants on `src/data/*` and the scene.
- `npm test` - Node test runner in `scripts/test/`.
- `backend/.venv/Scripts/python.exe -m unittest discover backend/tests` - FastAPI TestClient tests (voice, nurse, triage, vault).

## Optional extras (not required for judging)

- Opus attending via Claude Managed Agents with custom render tools (`src/agents/customTools.ts`, `backend/server.py`).
- `agent/skills/` skill prompts for case generation, patient roleplay, simulation ticks.
- `docs/evolution.md` historical idea log (from the earlier Anthropic hackathon version, then named medkit).

## Out of scope

- Multi-agent handoffs.
- Persistent accounts, multiplayer, server-side simulation authority.
- Pharmacology beyond the curated `medications.ts` table.
- Mobile / touch; desktop browsers only.
- Any claim of clinical accuracy. Cases are synthetic.

## Success criteria

The demo shows, in order: a voice conversation with the patient agent; a spoken order producing at least two coordinated tool calls; the nurse adapting to an allergy; a Murf-voiced confirmation; and the patient agent's context updated afterwards.
