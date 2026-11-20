@echo off
REM ---------------------------------------------------------------------------
REM  MedSim: one-click local start (Windows)
REM  Starts the FastAPI backend (127.0.0.1:8787) and the Vite frontend
REM  (http://localhost:5173) in their own windows, then opens the browser.
REM  Keys live in backend\.env.local (copy backend\.env.example first).
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
title MedSim launcher

echo.
echo   MedSim  ^|  voice-first clinical training
echo   -----------------------------------------
echo.

REM 1. Prerequisites -----------------------------------------------------------
where node >nul 2>nul || (echo [x] Node.js 22+ is required: https://nodejs.org & pause & exit /b 1)
where python >nul 2>nul || (echo [x] Python 3.12 is required: https://www.python.org & pause & exit /b 1)

if not exist "backend\.env.local" (
  echo [x] backend\.env.local is missing.
  echo     Copy backend\.env.example to backend\.env.local and fill in the Agora, Murf, Sarvam and Groq keys.
  pause & exit /b 1
)

REM 2. First-run installs ---------------------------------------------------------
if not exist "node_modules" (
  echo [..] Installing frontend packages (first run only^)...
  call npm ci || (echo [x] npm ci failed & pause & exit /b 1)
)
if not exist "backend\.venv\Scripts\python.exe" (
  echo [..] Creating the Python virtual environment (first run only^)...
  python -m venv backend\.venv || (echo [x] venv creation failed & pause & exit /b 1)
  backend\.venv\Scripts\python.exe -m pip install --upgrade pip >nul
  backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt || (echo [x] pip install failed & pause & exit /b 1)
)

REM 3. Free the ports if a previous run is still holding them --------------------
for %%P in (8787 5173) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    echo [..] Port %%P is busy (PID %%I^), stopping the old process...
    taskkill /PID %%I /F >nul 2>nul
  )
)

REM 4. Start backend and frontend in their own windows --------------------------
echo [..] Starting backend on http://127.0.0.1:8787
start "MedSim backend" cmd /k "cd /d "%~dp0" && backend\.venv\Scripts\python.exe backend\server.py"

echo [..] Starting frontend on http://localhost:5173
start "MedSim frontend" cmd /k "cd /d "%~dp0" && node node_modules\vite\bin\vite.js --port 5173 --strictPort"

REM 5. Wait for both, then open the browser ---------------------------------------
echo [..] Waiting for the backend...
set /a tries=0
:waitbackend
set /a tries+=1
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/health -TimeoutSec 2) | Out-Null; exit 0}catch{exit 1}" >nul 2>nul
if errorlevel 1 (
  if %tries% GEQ 40 (echo [!] Backend did not answer in 80 s; check the "MedSim backend" window.& goto openbrowser)
  timeout /t 2 /nobreak >nul
  goto waitbackend
)
echo [ok] Backend is up.

:openbrowser
echo [..] Waiting for the frontend...
set /a tries=0
:waitfront
set /a tries+=1
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing http://localhost:5173 -TimeoutSec 2) | Out-Null; exit 0}catch{exit 1}" >nul 2>nul
if errorlevel 1 (
  if %tries% GEQ 30 (echo [!] Frontend did not answer in 60 s; check the "MedSim frontend" window.& goto done)
  timeout /t 2 /nobreak >nul
  goto waitfront
)
echo [ok] Frontend is up. Opening MedSim...
start "" http://localhost:5173

:done
echo.
echo   Backend : http://127.0.0.1:8787/health
echo   App     : http://localhost:5173
echo   Live    : https://medsim-0cla.onrender.com
echo.
echo   Tip: if backend\.env.local has PATIENT_LLM_TUNNEL=cloudflared, the noise-safe
echo   patient route turns on 15 to 90 s after start (see /health: llm.patient_route).
echo   Close the two MedSim windows to stop everything.
echo.
pause
endlocal
