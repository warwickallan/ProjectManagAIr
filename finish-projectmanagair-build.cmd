@echo off
REM Project ManagAIr — finish a cloud build.
REM
REM Verifies the handoff, fetches the branch out of its bundle, pushes it to
REM origin, verifies the remote SHA, opens or updates the draft pull request and
REM mirrors the safe deliverables to Google Drive. With no arguments it finds the
REM newest pending handoff by itself.
REM
REM   finish-projectmanagair-build.cmd
REM   finish-projectmanagair-build.cmd --manifest "the full path to a handoff.json"
REM   finish-projectmanagair-build.cmd --list
REM   finish-projectmanagair-build.cmd --dry-run
REM   finish-projectmanagair-build.cmd --connect-drive
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\finish-projectmanagair-build.ps1" %*
set FINALIZER_EXIT=%ERRORLEVEL%
endlocal & exit /b %FINALIZER_EXIT%
