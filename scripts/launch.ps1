# Starts agent-boss (daemon + board server) if it is not running, then opens the board
# in a new browser tab. Used by "Agent Boss.cmd" (double-click). Safe to run repeatedly.
param(
  [int]$Port = 7777,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port"
$log = Join-Path $root 'data\launcher.log'
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null

function Write-Log([string]$msg) {
  [System.IO.File]::AppendAllText($log, "[$(Get-Date -Format s)] $msg`n", [System.Text.UTF8Encoding]::new($false))
}

function Test-Board {
  try {
    $h = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2
    return [bool]$h.ok
  } catch {
    return $false
  }
}

if (Test-Board) {
  Write-Log "already running on $url"
} else {
  $node = (Get-Command node -ErrorAction Stop).Source
  $daemon = Join-Path $root 'src\daemon.ts'
  Write-Log "starting daemon: $node $daemon --port $Port"
  Start-Process -FilePath $node `
    -ArgumentList @('--disable-warning=ExperimentalWarning', "`"$daemon`"", '--port', "$Port") `
    -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Board) { $ok = $true; break }
  }
  if (-not $ok) {
    Write-Log "server did not answer on $url within 10s; see data\agent-boss.log"
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("O agent-boss não respondeu em $url.`nVeja data\agent-boss.log.", 'Agent Boss') | Out-Null
    exit 1
  }
  Write-Log "up on $url"
}

if (-not $NoBrowser) { Start-Process $url }
