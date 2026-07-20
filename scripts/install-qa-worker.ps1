param(
  [string]$TaskName = 'ClanDashboard QA Worker'
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$worker = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'qa-worker.mjs'))
$node = (Get-Command node -ErrorAction Stop).Source
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $worker)) {
  throw "Worker script not found: $worker"
}

$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $worker + '"') -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settingsArgs = @{
  AllowStartIfOnBatteries = $true
  DontStopIfGoingOnBatteries = $true
  RestartCount = 3
  RestartInterval = (New-TimeSpan -Minutes 1)
  ExecutionTimeLimit = [TimeSpan]::Zero
  MultipleInstances = 'IgnoreNew'
}
$settings = New-ScheduledTaskSettingsSet @settingsArgs
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$registerArgs = @{
  TaskName = $TaskName
  Action = $action
  Trigger = $trigger
  Settings = $settings
  Principal = $principal
  Description = 'Automatically processes ClanDashboard bug and improvement requests with Codex.'
  Force = $true
}
Register-ScheduledTask @registerArgs | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Output "Installed and started scheduled task: $TaskName"
Write-Output "Worker log: $root\.qa-worker\worker.log"
