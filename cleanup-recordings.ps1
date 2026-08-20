# Robocop recording auto-cleanup
# When a recordings folder reaches THRESHOLD files, permanently delete all
# recording files in it (and empty the Recycle Bin as a safety net).
# Intended to be run on a schedule (see Windows Task Scheduler task
# "RobocopRecordingCleanup"). Keeps disk usage bounded on a low-memory server.

$ErrorActionPreference = "SilentlyContinue"

$THRESHOLD = 3000
$folders = @(
    "C:\Users\Administratori\OneDrive\Desktop\Robocop\data\recordings",
    "C:\Users\Administratori\OneDrive\Desktop\Robocop\data2\recordings"
)
$logFile = "C:\Users\Administratori\OneDrive\Desktop\Robocop\cleanup-recordings.log"

function Write-Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -LiteralPath $logFile -Value $line
}

$didDelete = $false

foreach ($dir in $folders) {
    if (-not (Test-Path -LiteralPath $dir)) {
        Write-Log "SKIP (missing): $dir"
        continue
    }

    # Count only recording files
    $files = Get-ChildItem -LiteralPath $dir -File -Include *.wav, *.raw -Recurse
    $count = ($files | Measure-Object).Count

    if ($count -ge $THRESHOLD) {
        $sizeMB = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 1)
        Write-Log "THRESHOLD reached in $dir : $count files ($sizeMB MB). Deleting..."

        # Fast permanent purge via robocopy mirror-from-empty (does NOT use Recycle Bin)
        $empty = Join-Path $env:TEMP ("rc_empty_" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $empty | Out-Null
        $roboArgs = @($empty, $dir, "/MIR", "/NFL", "/NDL", "/NJH", "/NC", "/NS", "/R:0", "/W:0")
        Start-Process -FilePath "robocopy.exe" -ArgumentList $roboArgs -WindowStyle Hidden -Wait | Out-Null
        Remove-Item -LiteralPath $empty -Recurse -Force

        $left = (Get-ChildItem -LiteralPath $dir -File | Measure-Object).Count
        Write-Log "Done. Files remaining in $dir : $left"
        $didDelete = $true
    }
    else {
        Write-Log "OK: $dir has $count files (under $THRESHOLD)."
    }
}

# Empty the Recycle Bin regardless, per requirement (belt-and-suspenders)
if ($didDelete) {
    Clear-RecycleBin -Force -ErrorAction SilentlyContinue
    Write-Log "Recycle Bin cleared."
}
