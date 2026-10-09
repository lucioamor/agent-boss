@echo off
rem Starts agent-boss (if needed) and keeps it connected to the hosted board, so the board
rem can send commands to this machine. Leave the window open. Settings: data\cloud.env
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bridge.ps1" %*
if errorlevel 1 pause
