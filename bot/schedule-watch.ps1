# Registers a Windows Task Scheduler job that watches for stale prices during
# the evening slate, and starts it now.
#
#   powershell -ExecutionPolicy Bypass -File bot\schedule-watch.ps1
#
# tools\stale-watch.mjs reads the public MLB play feed and the public Kalshi
# book and logs every contract the box score has already decided that is still
# quoted. It needs no credentials and never places an order. See
# docs\MARKET-EDGE-SEARCH.md for what the rule is and why it is worth watching
# but probably not worth building a trading system around.
#
# The default start is local 15:30, which is 17:30 Eastern — ahead of a normal
# evening slate — and the run is capped at eight hours so it cannot outlive the
# games.
#
# Remove with:  Unregister-ScheduledTask -TaskName "MLB Stale Watch" -Confirm:$false
param(
  [string]$At = '15:30',
  [int]$Every = 25,
  [string]$NodePath = '',
  [switch]$NoStartNow
)

$repo = Split-Path -Parent $PSScriptRoot
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodePath = $cmd.Source }
  elseif (Test-Path "$env:USERPROFILE\mlbwork\node\node.exe") { $NodePath = "$env:USERPROFILE\mlbwork\node\node.exe" }
  else { throw 'node.exe not found; pass -NodePath' }
}
New-Item -ItemType Directory -Force (Join-Path $repo 'bot\state') | Out-Null

$log = Join-Path $repo 'bot\state\stale-watch.log'
# Task Scheduler runs node directly: no cmd.exe and no shell redirect. The
# script writes its own log, which is one fewer thing between it and the
# record — wrapping a long-running process in cmd to get ">> file" was one
# more thing that failed silently.
$action = New-ScheduledTaskAction -Execute $NodePath -Argument "tools\stale-watch.mjs --every=$Every" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 8) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'MLB Stale Watch' -Action $action -Trigger $trigger -Settings $settings -Description 'Logs contracts the box score has already decided that are still quoted. Never orders.' -Force | Out-Null
Write-Host "Scheduled 'MLB Stale Watch' daily at $At local (8 hour cap)."
Write-Host "Log:   $log"
Write-Host "Hits:  $(Join-Path $repo 'bot\state\stale-watch.ndjson')"
if (-not $NoStartNow) {
  Start-ScheduledTask -TaskName 'MLB Stale Watch'
  Write-Host 'Started now.'
}
