@echo off
rem Double-click: starts agent-boss in the background (if needed) and opens the board.
start "" /min pwsh -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\launch.ps1"
