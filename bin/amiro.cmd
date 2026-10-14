@echo off
rem Amiro CLI (Windows) -- thin wrapper around the upstream Jcode CLI.
rem Amiro does not fork/vendor/patch Jcode; every argument is forwarded to the
rem installed `jcode` binary, retaining upstream authorship and licensing.
setlocal
if "%AMIRO_JCODE_BIN%"=="" (set "JCODE_BIN=jcode") else (set "JCODE_BIN=%AMIRO_JCODE_BIN%")

where %JCODE_BIN% >nul 2>nul
if errorlevel 1 (
  echo amiro: the Jcode CLI ^(%JCODE_BIN%^) was not found on PATH. 1>&2
  echo        amiro is a thin wrapper over Jcode; install Jcode first, 1>&2
  echo        or set AMIRO_JCODE_BIN to its path. 1>&2
  exit /b 127
)

"%JCODE_BIN%" %*
exit /b %errorlevel%
