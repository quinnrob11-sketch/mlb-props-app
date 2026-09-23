# Registers a Windows Task Scheduler job that keeps the PAPER RECORD.
#
#   powershell -ExecutionPolicy Bypass -File bot\schedule-tracker.ps1
#
# Each run does three things (tools\track.mjs daily):
#   1. snapshots every priced row on today's board, first write wins, so the
#      entry price is the one the board first showed;
#   2. overwrites today's closing prices — the last run before first pitch is
#      the one that counts, which is what a closing line is;
#   3. grades yesterday against the real box scores.
#
# The default times bracket a normal slate: morning board, afternoon, then two
# runs close to the first pitches. Grading happens on the morning run.
#
# Cost: every run reads the board through the production deployment, so it uses
# that CDN cache and the Odds API key in Vercel's env rather than spending
# fresh credits per run.
#
# Remove with:  Unregister-ScheduledTask -TaskName "MLB Paper Record" -Confirm:$false
param(
  [string[]]$Times = @('09:00', '13:00', '16:30', '18:45'),
  [string]$NodePath = ''
)

$repo = Split-Path -Parent $PSScriptRoot
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodePath = $cmd.Source }
  elseif (Test-Path "$env:USERPROFILE\mlbwork\node\node.exe") { $NodePath = "$env:USERPROFILE\mlbwork\node\node.exe" }
  else { throw 'node.exe not found; pass -NodePath' }
}
New-Item -ItemType Directory -Force (Join-Path $repo 'bot\state\track') | Out-Null

$log = Join-Path $repo 'bot\state\tracker.log'
$command = "`"$NodePath`" tools\track.mjs daily >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $command" -WorkingDirectory $repo
$triggers = $Times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'MLB Paper Record' -Action $action -Trigger $triggers -Settings $settings -Description 'Snapshots the board, captures closing prices and grades yesterday. See docs\PAPER-RECORD.md.' -Force | Out-Null
Write-Host "Scheduled 'MLB Paper Record' at $($Times -join ', ') local time."
Write-Host "Log:    $log"
Write-Host "Record: $(Join-Path $repo 'bot\state\track')"
Write-Host "Read it with:  node tools\track.mjs report"
