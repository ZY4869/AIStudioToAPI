@echo off
setlocal

cd /d "%~dp0"

echo [1/5] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found. Please install Node.js 18+ and try again.
    goto :error
)

where npm >nul 2>&1
if errorlevel 1 (
    echo npm was not found. Please reinstall Node.js and try again.
    goto :error
)

echo [2/5] Checking npm dependencies...
if not exist "node_modules\" (
    echo node_modules was not found. Running npm install...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        goto :error
    )
) else (
    echo Dependencies are already installed.
)

echo [3/5] Checking auth files...
dir /b "configs\auth\auth-*.json" >nul 2>&1
if errorlevel 1 (
    echo No auth file was found under configs\auth.
    echo Running npm run setup-auth...
    call npm run setup-auth
    if errorlevel 1 (
        echo setup-auth failed or was cancelled.
        goto :error
    )
) else (
    echo Auth file detected.
)

echo [4/5] Checking whether the server is already running...
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:7860/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
    echo Server is already running at http://127.0.0.1:7860
    start "" "http://127.0.0.1:7860"
    exit /b 0
)

echo [5/5] Starting AIStudioToAPI...
start "AIStudioToAPI" cmd /k "title AIStudioToAPI && cd /d ""%~dp0"" && npm start"

echo Waiting for the web console...
timeout /t 6 /nobreak >nul
start "" "http://127.0.0.1:7860"

exit /b 0

:error
echo.
echo Startup aborted.
pause
exit /b 1
