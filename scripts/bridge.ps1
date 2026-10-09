# Runs agent-boss in "external bridge" mode: makes sure the local server is up, then keeps the
# cloud bridge (scripts/agent-boss-cloud.mjs) connected to the hosted board. Used by
# "Agent Boss Bridge.cmd". Settings come from data\cloud.env (git-ignored) or the environment:
#   AGENT_BOSS_CLOUD_TOKEN   required, generated in the hosted board (Conexão)
#   AGENT_BOSS_CLOUD_URL     default https://agentic-boss.lovable.app
#   AGENT_BOSS_REMOTE_ROOTS  directories where board "Nova tarefa" may run (default: none)
param([int]$Port = 7777)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root 'data\cloud.env'

if (Test-Path $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$') {
      Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim('"')
    }
  }
}
if (-not $env:AGENT_BOSS_CLOUD_URL) { $env:AGENT_BOSS_CLOUD_URL = 'https://agentic-boss.lovable.app' }
if (-not $env:AGENT_BOSS_CLOUD_TOKEN) {
  Write-Host "Falta o token do bridge." -ForegroundColor Red
  Write-Host "Crie $envFile com a linha:  AGENT_BOSS_CLOUD_TOKEN=abk_..."
  Write-Host "(modelo em scripts\cloud.env.example; o token é gerado no board, em Conexão)"
  exit 1
}
$env:AGENT_BOSS_LOCAL = "http://127.0.0.1:$Port"

# Starts the local server when it is not running (inherits AGENT_BOSS_REMOTE_ROOTS). A server
# that is already running keeps the roots it was started with.
$global:LASTEXITCODE = 0
& (Join-Path $PSScriptRoot 'launch.ps1') -Port $Port -NoBrowser
if ($LASTEXITCODE) { exit $LASTEXITCODE }

$node = (Get-Command node -ErrorAction Stop).Source
$bridge = Join-Path $PSScriptRoot 'agent-boss-cloud.mjs'
Write-Host "bridge: $env:AGENT_BOSS_LOCAL -> $env:AGENT_BOSS_CLOUD_URL  (Ctrl+C para sair)"
for (;;) {
  & $node $bridge
  # Exit code 1 = token rejected by the cloud: restarting would not help.
  if ($LASTEXITCODE -eq 1) { Write-Host 'Token inválido: gere outro no board e atualize data\cloud.env.' -ForegroundColor Red; exit 1 }
  Write-Host "bridge encerrou (código $LASTEXITCODE); reiniciando em 5 s..."
  Start-Sleep -Seconds 5
}
