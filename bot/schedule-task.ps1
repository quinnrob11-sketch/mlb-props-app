# Registers a Windows Task Scheduler job that runs the Kalshi bot several times a
# day. Run it yourself, once, from PowerShell in the repo folder:
#
#   powershell -ExecutionPolicy Bypass -File bot\schedule-task.ps1
#
# Add -Live to schedule live trading (it still also requires "live": true in
# bot\config.json and API keys). Without -Live the scheduled runs are dry runs.
# Remove the job with:  Unregister-ScheduledTask -TaskName "MLB Kalshi Bot" -Confirm:$false
param(
  [switch]$Live,
  [string[]]$Times = @('10:30', '12:30', '14:30', '16:30', '17:45', '19:00'),
  [string]$NodePath = ''
)

$repo = Split-Path -Parent $PSScriptRoot
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodePath = $cmd.Source }
  elseif (Test-Path "$env:USERPROFILE\mlbwork\node\node.exe") { $NodePath = "$env:USERPROFILE\mlbwork\node\node.exe" }
  else { throw 'node.exe not found; pass -NodePath' }
}
New-Item -ItemType Directory -Force (Join-Path $repo 'bot\state') | Out-Null

$liveArg = if ($Live) { ' --live' } else { '' }
$log = Join-Path $repo 'bot\state\scheduler.log'
$command = "`"$NodePath`" bot\run.mjs$liveArg >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $command" -WorkingDirectory $repo
$triggers = $Times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'MLB Kalshi Bot' -Action $action -Trigger $triggers -Settings $settings -Description 'MLB model vs Kalshi order books. See bot\README.md.' -Force | Out-Null
Write-Host "Scheduled 'MLB Kalshi Bot' at $($Times -join ', ') local time$(if ($Live) { ' (LIVE)' } else { ' (dry run)' })."
Write-Host "Log: $log"
Write-Host "Emergency stop: create an empty file at $(Join-Path $repo 'bot\STOP')"
