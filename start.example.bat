@echo off
chcp 65001 >nul
setlocal
title QQ-DSH Bridge

rem ===========================================================================
rem  TEMPLATE launcher. Copy this file to start.bat and edit the block below.
rem  start.bat itself is git-ignored (it holds machine-specific paths).
rem
rem  Keep this file ASCII-only: cmd keeps reading a batch file by BYTE offset
rem  after `chcp` changes the code page, so any multibyte (e.g. Chinese)
rem  character makes it execute the middle of a `rem` line as a command.
rem  Chinese output belongs in node (logs / console), not here.
rem ===========================================================================

rem ---- edit these two ports if your setup differs --------------------------
set "DSH_PROBE=http://127.0.0.1:3130"
set "SNOWLUMA_PORT=3001"
rem -------------------------------------------------------------------------

cd /d "%~dp0"

echo.
echo   QQ-DSH Bridge
echo   ==============
echo.

rem Unused / stale env vars that would silently change behaviour.
if defined DSH_HOME (
    echo   [WARN] env DSH_HOME is set - clearing it ^(config.json dsh.* wins^)
    set "DSH_HOME="
)
if defined DSH_LAUNCH_TOKEN (
    echo   [WARN] env DSH_LAUNCH_TOKEN is set - clearing it ^(unused by this bridge^)
    set "DSH_LAUNCH_TOKEN="
)

rem Locate node: PATH first, then the two usual install locations.
set "NODE_BIN="
for %%P in (node.exe) do if not defined NODE_BIN set "NODE_BIN=%%~$PATH:P"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN (
    echo   [ERROR] node not found. Install Node.js 20+ or add it to PATH.
    pause
    exit /b 1
)
for %%D in ("%NODE_BIN%") do set "PATH=%%~dpD;%PATH%"

if not exist "src\main.js" (
    echo   [ERROR] src\main.js not found - run this script from the qq-dsh-bridge folder.
    pause
    exit /b 1
)
if not exist "config.json" (
    echo   [WARN] no config.json - copy config.example.json and edit it.
)

for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
echo   node:      %NODEV%
echo   cwd:       %CD%

rem Preflight probes. Both are informational only - the bridge starts either way.
node -e "fetch('%DSH_PROBE%/api/status').then(function(){console.log('   DSH:       ok')}).catch(function(){console.log('   DSH:       down - bridge still starts, will retry on send')})" 2>nul

netstat -ano | findstr /r /c:":%SNOWLUMA_PORT% .*LISTENING" >nul 2>nul
if errorlevel 1 (
    echo   SnowLuma:  down ^(port %SNOWLUMA_PORT%^) - bridge will keep retrying
) else (
    echo   SnowLuma:  ok ^(port %SNOWLUMA_PORT%^)
)

echo.
echo   ------------------------------------------------------------
echo    Ctrl+C to stop.  Log file: logs\bridge.log
echo   ------------------------------------------------------------
echo.

node src\main.js %*
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
    echo   [EXIT] code %EXITCODE%
) else (
    echo   [EXIT] clean
)
pause
