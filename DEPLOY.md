# Deploying MedSim (Render)

One Render web service (Python 3.12, Singapore) builds the Vite app and serves it
from FastAPI (`backend/server.py` serves `dist/`), alongside `/voice/*`, `/agent/*`
and `/llm/*`. Same origin, so no CORS or proxy rewrites are needed.

- Build: `pip install -r backend/requirements.txt && npm ci && npm run build`
- Start: `cd backend && uvicorn server:app --host 0.0.0.0 --port $PORT`
- Health: `/health`; autodeploy from `main`. See `render.yaml`.

## Environment variables (set in the Render dashboard, never commit)

AGORA_APP_ID, AGORA_APP_CERTIFICATE, AGORA_CUSTOMER_ID, AGORA_CUSTOMER_SECRET,
MURF_API_KEY, MURF_REGION, SARVAM_API_KEY, GROQ_API_KEY, PATIENT_LLM_PROVIDER=sarvam,
PUBLIC_URL=https://<service>.onrender.com (lets Agora reach `/llm/patient` with no
tunnel; do not set PATIENT_LLM_TUNNEL), FRONTEND_ORIGINS=https://<service>.onrender.com
(trusted browser origin, exempt from the shared secret).

## Notes

- Free plan sleeps after 15 minutes idle; the first request takes about 50 s.
- `vercel.json` and `middleware.ts` are the legacy Vercel setup and are unused.
