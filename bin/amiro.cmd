@echo off
rem Amiro runtime CLI (Windows) -- delegation shim, not a runtime implementation.
rem It locates a runtime engine binary and runs it with the caller's arguments
rem unchanged: nothing added, nothing removed, no engine output rewritten. The
rem engine keeps its own command surface, authorship and licensing as shipped.
rem
rem Engine resolution order (first usable hit wins):
rem   1. AMIRO_RUNTIME_BIN                   explicit override, must be usable
rem   2. amiro-runtime.exe beside this file  packaged runtime
rem   3. %~dp0..\runtime\target\release\amiro-runtime.exe   owned native build
rem   4. %~dp0..\runtime\target\debug\amiro-runtime.exe     owned native build
rem   5. AMIRO_JCODE_BIN, JCODE_BIN, jcode   compatibility fallback: a separately
rem      installed engine on PATH. That engine is NOT bundled with Amiro, and
rem      --help/--version say so rather than implying otherwise.
rem
rem Only --help and --version are answered locally. A packaged Amiro install
rem stages the owned runtime as the real native amiro.exe, so this shim is not
rem shipped in that stage.
setlocal EnableExtensions

set "SELF_DIR=%~dp0"
if "%SELF_DIR:~-1%"=="\" set "SELF_DIR=%SELF_DIR:~0,-1%"
set "REPO_ROOT=%SELF_DIR%\.."
set "SELF=%~f0"

rem Re-entrancy guard: an engine candidate that resolves back to this shim must
rem not loop.
if not "%AMIRO_CLI_DEPTH%"=="" (
  echo amiro: refusing to re-enter the Amiro CLI shim. 1>&2
  echo        Set AMIRO_RUNTIME_BIN to a real runtime engine binary. 1>&2
  exit /b 127
)

set "ENGINE_PATH="
set "ENGINE_KIND="

rem No goto-based "call :try <kind> <candidate>" helper: cmd's call/return plus
rem `where` quoting is fragile, so each candidate is checked in place. A
rem candidate counts only when it is a real file, never this script itself.
if not "%AMIRO_RUNTIME_BIN%"=="" (
  if not exist "%AMIRO_RUNTIME_BIN%" (
    echo amiro: AMIRO_RUNTIME_BIN="%AMIRO_RUNTIME_BIN%" is not a usable executable file. 1>&2
    echo        Refusing to fall back to a different engine while an override is set. 1>&2
    exit /b 127
  )
  if /I "%AMIRO_RUNTIME_BIN%"=="%SELF%" (
    echo amiro: AMIRO_RUNTIME_BIN points at this shim itself. 1>&2
    exit /b 127
  )
  set "ENGINE_PATH=%AMIRO_RUNTIME_BIN%"
  set "ENGINE_KIND=explicit"
  goto :amiro_dispatch
)

if exist "%SELF_DIR%\amiro-runtime.exe" (
  set "ENGINE_PATH=%SELF_DIR%\amiro-runtime.exe"
  set "ENGINE_KIND=packaged"
  goto :amiro_dispatch
)
if exist "%REPO_ROOT%\runtime\target\release\amiro-runtime.exe" (
  set "ENGINE_PATH=%REPO_ROOT%\runtime\target\release\amiro-runtime.exe"
  set "ENGINE_KIND=owned"
  goto :amiro_dispatch
)
if exist "%REPO_ROOT%\runtime\target\debug\amiro-runtime.exe" (
  set "ENGINE_PATH=%REPO_ROOT%\runtime\target\debug\amiro-runtime.exe"
  set "ENGINE_KIND=owned-debug"
  goto :amiro_dispatch
)

set "COMPAT_CANDIDATE=%AMIRO_JCODE_BIN%"
if "%COMPAT_CANDIDATE%"=="" set "COMPAT_CANDIDATE=%JCODE_BIN%"
if "%COMPAT_CANDIDATE%"=="" set "COMPAT_CANDIDATE=jcode"
for %%F in ("%COMPAT_CANDIDATE%") do set "COMPAT_PATH=%%~$PATH:F"
if "%COMPAT_PATH%"=="" if exist "%COMPAT_CANDIDATE%" set "COMPAT_PATH=%COMPAT_CANDIDATE%"
if not "%COMPAT_PATH%"=="" (
  set "ENGINE_PATH=%COMPAT_PATH%"
  set "ENGINE_KIND=compatibility"
)

:amiro_dispatch
if "%~1"=="--help" goto :amiro_help
if "%~1"=="-h" goto :amiro_help
if "%~1"=="--version" goto :amiro_version
if "%~1"=="-V" goto :amiro_version

if "%ENGINE_PATH%"=="" (
  echo amiro: no runtime engine found. 1>&2
  echo        amiro delegates to a separate runtime engine binary and has none 1>&2
  echo        of its own. Set AMIRO_RUNTIME_BIN, place amiro-runtime.exe beside 1>&2
  echo        this CLI, build the owned engine with scripts\build-native.sh, or 1>&2
  echo        install a compatible engine on PATH. 1>&2
  exit /b 127
)

set "AMIRO_CLI_DEPTH=1"
"%ENGINE_PATH%" %*
exit /b %errorlevel%

:amiro_help
echo amiro - Amiro runtime CLI
echo.
echo Usage: amiro ^<command^> [options]
echo.
echo This CLI is a delegation shim: it runs a separate runtime engine binary and
echo passes your command to it unchanged, so the engine's own command surface is
echo available here as-is. Common commands:
echo.
echo   auth status --json           connected providers and credential state
echo   provider list --json         full provider catalog
echo   model list -p ^<id^> --json    models available for one provider
echo   usage --json                 quota and usage buckets
echo   login ^<provider^>             connect a provider
echo   run [--json] ^<prompt^>        run a headless turn
echo.
echo   --version, -V                print the version of the engine being delegated to
echo   --help, -h                   show this help
echo.
if "%ENGINE_PATH%"=="" (
  echo No runtime engine was found, so only --help and --version work here.
  echo Set AMIRO_RUNTIME_BIN, or build the owned engine with scripts\build-native.sh.
  exit /b 0
)
echo Engine in use: %ENGINE_PATH%
echo Engine source: %ENGINE_KIND%
if "%ENGINE_KIND%"=="compatibility" (
  echo   ^(a separately installed engine on PATH, not bundled with Amiro^)
)
echo Set AMIRO_RUNTIME_BIN to use a specific runtime engine binary.
exit /b 0

:amiro_version
if "%ENGINE_PATH%"=="" (
  echo amiro: no runtime engine found, so there is no runtime version to report. 1>&2
  echo        This CLI is a delegation shim and has no version of its own. 1>&2
  exit /b 127
)
echo amiro: delegation shim over the Amiro runtime engine ^(no engine of its own^)
echo engine: %ENGINE_PATH%
echo engine source: %ENGINE_KIND%
echo --- output of the engine's own --version ---
set "AMIRO_CLI_DEPTH=1"
"%ENGINE_PATH%" --version
exit /b %errorlevel%
