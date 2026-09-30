@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ============================================================
rem  GPT Image Studio - launcher
rem
rem  NOTE: This file is intentionally PURE ASCII.
rem  A .bat containing Chinese text + "chcp 65001" breaks on
rem  Chinese Windows, because cmd.exe reads the batch file using
rem  the OEM codepage (GBK) while chcp switched the console to
rem  UTF-8. The result is garbled text and errors like
rem  "'xxx' is not recognized as an internal or external command".
rem  Keep everything here in ASCII and it works everywhere.
rem ============================================================

title GPT Image Studio

echo.
echo   ==========================================
echo      GPT Image Studio  -  starting...
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js not found.
  echo   Please install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo   First run: building the page, please wait...
  call npm run build
  if errorlevel 1 (
    echo.
    echo   [ERROR] Build failed. Try running:  npm install
    echo.
    pause
    exit /b 1
  )
)

rem ------------------------------------------------------------
rem  Which API hosts the local proxy may forward to.
rem
rem  "*" = allow ANY external host. This is the default, so you
rem  can switch API providers freely without editing anything.
rem
rem  Want it tighter? Replace * with your own domains, e.g.
rem      set "ALLOW_HOSTS=api.openai.com,*.my-relay.com"
rem  You can also write  *.example.com  to allow all subdomains.
rem
rem  Local / private network addresses (127.x, 10.x, 192.168.x,
rem  localhost, [::1] ...) are ALWAYS blocked, so this can never
rem  be abused to probe your LAN. That limit cannot be turned off.
rem ------------------------------------------------------------
set "ALLOW_HOSTS=*"

rem ------------------------------------------------------------
rem  Set to 1 to skip the host check entirely (still blocks
rem  private addresses). Same effect as ALLOW_HOSTS=*.
rem ------------------------------------------------------------
rem set "ALLOW_ANY=1"

rem ------------------------------------------------------------
rem  Set to 1 to disable the host check entirely (still blocks
rem  private addresses). Equivalent to ALLOW_HOSTS=*.
rem ------------------------------------------------------------
rem set "ALLOW_ANY=1"

rem ------------------------------------------------------------
rem  Generated images go into the project's "image" folder by
rem  default, so the whole project stays portable. You can also
rem  change it later from the web UI (Settings -> Storage).
rem  Uncomment the next line only if you want to override it.
rem ------------------------------------------------------------
rem set "IMAGE_DIR=%~dp0image"

rem ------------------------------------------------------------
rem  Remove a stale .port left over from a previous run, so we
rem  never open the wrong address.
rem ------------------------------------------------------------
del ".port" >nul 2>nul

rem ------------------------------------------------------------
rem  Free ports 8787-8790 if leftover server processes hold them.
rem  (Scans by executable name so we never kill unrelated apps.)
rem ------------------------------------------------------------
for %%P in (8787 8788 8789 8790) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /r /c:"TCP.*:%%P .*LISTENING"') do (
    for /f "tokens=1" %%B in ('tasklist /fi "PID eq %%A" /nh /fo csv 2^>nul') do (
      set "PROC=%%~B"
      if /i "!PROC!"=="node.exe" (
        echo   Port %%P is held by a leftover server ^(PID %%A^) - stopping it...
        taskkill /f /pid %%A >nul 2>nul
      ) else (
        echo   Port %%P is in use by !PROC! ^(PID %%A^) - will use the next free port.
      )
    )
  )
)

rem ------------------------------------------------------------
rem  Start the server in its own window and keep it open.
rem ------------------------------------------------------------
echo   Starting server...
start "GPT Image Studio Server" cmd /k "node server.mjs"

rem ------------------------------------------------------------
rem  Wait for the server to report which port it actually bound.
rem ------------------------------------------------------------
set "PORT="
for /l %%i in (1,1,60) do (
  if exist ".port" (
    set /p PORT=<.port
    goto :ready
  )
  ping -n 1 -w 250 127.0.0.1 >nul
)

:ready
if "!PORT!"=="" (
  rem Fall back to probing the usual ports.
  for %%P in (8787 8788 8789 8790) do (
    if "!PORT!"=="" (
      netstat -ano | findstr /r /c:"TCP.*:%%P .*LISTENING" >nul 2>nul && set "PORT=%%P"
    )
  )
)

if "!PORT!"=="" (
  echo.
  echo   [WARN] Could not detect the port automatically.
  echo   Check the "GPT Image Studio Server" window for the real address.
  echo.
  pause
  exit /b 1
)

del ".port" >nul 2>nul

echo.
echo   Server is up.  Opening http://127.0.0.1:!PORT!
start "" "http://127.0.0.1:!PORT!"

echo.
echo   ------------------------------------------------------------
echo   The server runs in the window titled:
echo        "GPT Image Studio Server"
echo   Close THAT window to stop the service.
echo   ------------------------------------------------------------
echo.
exit /b 0
