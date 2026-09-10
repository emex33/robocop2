# Robocop recording auto-cleanup (safety net)
#
# Retention is handled by the app itself (src/services/recording-retention.js):
#   - appointments / callbacks / interested / transferred : kept 30 days
#   - real conversations (4+ transcript turns)            : kept 3 days
#   - no-conversation calls (voicemail, no answer, ...)   : kept 2 hours
#
# This script is only a disk guard. When a recordings folder exceeds THRESHOLD
# files it deletes the OLDEST files until the folder is back under the limit.
# It never wipes the whole folder (that used to erase recordings the team still
# needed to listen to, roughly every 50 minutes at 35 concurrent lines).
# Runs from Windows Task Scheduler task "RobocopRecordingCleanup".

$ErrorActionPreference = "SilentlyContinue"

$THRESHOLD = 40000          # ~40 GB at ~1 MB per recording
$folders = @(
    "C:\Users\Administratori\OneDrive\Desktop\Robocop\data\recordings",
    "C:\Users\Administratori\OneDrive\Desktop\Robocop\data2\recordings"
)
$logFile = "C:\Users\Administratori\OneDrive\Desktop\Robocop\cleanup-recordings.log"

function Write-Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -LiteralPath $logFile -Value $line
}

foreach ($dir in $folders) {
    if (-not (Test-Path -LiteralPath $dir)) {
        Write-Log "SKIP (missing): $dir"
        continue
    }

    $files = @(Get-ChildItem -LiteralPath $dir -File -Include *.wav, *.raw -Recurse)
    $count = $files.Count

    if ($count -gt $THRESHOLD) {
        $excess = $count - $THRESHOLD
        $victims = $files | Sort-Object LastWriteTime | Select-Object -First $excess
        $sizeMB = [math]::Round((($victims | Measure-Object Length -Sum).Sum) / 1MB, 1)
        Write-Log "GUARD: $dir has $count files (> $THRESHOLD). Deleting the $excess oldest ($sizeMB MB)..."
        foreach ($f in $victims) { Remove-Item -LiteralPath $f.FullName -Force }
        $left = @(Get-ChildItem -LiteralPath $dir -File).Count
        Write-Log "Done. Files remaining in $dir : $left"
    }
    else {
        Write-Log "OK: $dir has $count files (under $THRESHOLD)."
    }
}
