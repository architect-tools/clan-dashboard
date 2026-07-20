param(
  [string]$TaskName = 'ClanDashboard QA Worker'
)

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  [pscustomobject]@{
    TaskName = $TaskName
    State = $task.State
    LastRunTime = $info.LastRunTime
    LastTaskResult = $info.LastTaskResult
    NextRunTime = $info.NextRunTime
  } | Format-List
} else {
  Write-Output "Scheduled task is not installed: $TaskName"
}

$log = Join-Path $root '.qa-worker\worker.log'
if (Test-Path -LiteralPath $log) {
  Write-Output 'Recent worker log:'
  Get-Content -LiteralPath $log -Encoding UTF8 -Tail 20
}
