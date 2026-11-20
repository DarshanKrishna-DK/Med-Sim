# MedSim backend

One FastAPI process (`server.py`, `127.0.0.1:8787`):

- `/voice/*`: Agora Conversational AI Engine (ASR Sarvam, LLM Sarvam/Groq, TTS Murf Falcon) plus Agora RTC/RTM token mint (vendored builder in `agora_token/`).
- `/agent/nurse/act`: agentic charge nurse (function-calling loop, server-side tools).
- `/agent/debrief/simple`: JSON debrief via Sarvam/Groq (no Anthropic needed).
- `/agent/*` (optional), Claude Managed Agents attending, triage classifier, text-chat SSE. Needs `ANTHROPIC_API_KEY`.

## Install / run

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
cp .env.example .env.local   # fill in keys
.venv/Scripts/python.exe server.py
```

Tests: `backend/.venv/Scripts/python.exe -m unittest discover backend/tests`

## Endpoints (camelCase JSON)

- `GET /health`: configured providers (voice, llm, agent).
- `POST /voice/start` `{caseId, systemPrompt, initialLine, gender:'M'|'F', locale?}` returns `{appId, channel, uid, token, agentUid, agentId}`
- `POST /voice/stop` `{agentId}`: idempotent.
- `POST /voice/speak` `{agentId, text, priority?}`: text truncated to 500 bytes.
- `POST /voice/context` `{agentId, systemPrompt}`: Agora `/update` (only `llm.system_messages` is updatable).
- `POST /voice/tts` `{text, voice?:'nurse'|'M'|'F'}` returns `audio/mpeg`.
- `POST /agent/nurse/act`, `POST /agent/debrief/simple`: see `nurse.py`, `debrief.py`.

- `POST /llm/patient/chat/completions`: OpenAI-compatible patient-LLM proxy Agora calls (bearer = per-agent token minted at `/voice/start`). Replaces blank noise turns with "(inaudible, background noise)", injects the provider key, streams SSE unchanged. Needs an HTTPS URL: set `PUBLIC_URL=https://...` or `PATIENT_LLM_TUNNEL=cloudflared` (auto quick tunnel, `/health` shows `llm.patient_route`). Without either, Agora calls Sarvam directly.

Missing config returns 503 naming the missing env vars (never values). Agora errors return 502 with Agora's body.
Legacy `MEDKIT_AGENT_ID` / `MEDKIT_ENV_ID` are still read as fallbacks.
