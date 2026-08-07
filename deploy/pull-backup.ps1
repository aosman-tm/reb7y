# Copies the server's database backups onto this computer.
#
# Backups that live only on the VPS die with the VPS. This pulls them somewhere
# else so a dead disk cannot take your cost data with it.
#
# Registered as a daily Scheduled Task by deploy/install-backup-task.ps1.
# It only runs while this computer is on, so it is a safety net, not a
# replacement for off-site cloud storage.

$ErrorActionPreference = "Stop"

$Server  = "root@162.35.184.237"
$Remote  = "/var/backups/reb7y/daily"
$Dest    = "C:\shopify\reb7y-backups"
$KeyFile = Join-Path $env:USERPROFILE ".ssh\reb7y_deploy"
$LogFile = Join-Path $Dest "pull-backup.log"

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

function Write-Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $LogFile -Value $line -Encoding utf8
    Write-Output $line
}

try {
    if (-not (Test-Path $KeyFile)) { throw "SSH key not found at $KeyFile" }

    # BatchMode: never sit at a password prompt inside a scheduled task.
    & scp -i $KeyFile -o BatchMode=yes -o ConnectTimeout=20 -q `
        "${Server}:${Remote}/*.gz" $Dest
    if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }

    $files = Get-ChildItem -Path $Dest -Filter "prod-*.sqlite.gz" -ErrorAction SilentlyContinue
    if (-not $files) { throw "no backup files were copied" }

    $newest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $ageDays = (New-TimeSpan -Start $newest.LastWriteTime -End (Get-Date)).TotalDays

    # A stale newest backup means the server-side job stopped without anyone
    # noticing, which looks identical to everything being fine.
    if ($ageDays -gt 3) {
        Write-Log "WARNING: newest backup is $([math]::Round($ageDays,1)) days old - check reb7y-backup.timer on the server"
    }

    # Keep 60 days locally; the server already rotates its own copies.
    Get-ChildItem -Path $Dest -Filter "prod-*.sqlite.gz" |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-60) } |
        Remove-Item -Force

    Write-Log "OK: $($files.Count) backup(s) present, newest $($newest.Name)"
}
catch {
    Write-Log "FAILED: $_"
    exit 1
}
