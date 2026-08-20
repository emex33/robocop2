$ErrorActionPreference = "Continue"
$logFile = "C:\Users\Administratori\Desktop\Robocop\install-log.txt"

function Log($msg) {
    $ts = Get-Date -Format "HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line
}

"" | Set-Content $logFile
Log "=== ROBOCOP INSTALL SCRIPT STARTED ==="

# 1. Enable WSL + Virtual Machine Platform
Log "--- Enabling Windows Subsystem for Linux ---"
$r1 = dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart 2>&1
Log ($r1 | Out-String)

Log "--- Enabling Virtual Machine Platform ---"
$r2 = dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart 2>&1
Log ($r2 | Out-String)

# 2. Install WSL Ubuntu distro
Log "--- Installing WSL Ubuntu ---"
$r3 = wsl --install -d Ubuntu --no-launch 2>&1
Log ($r3 | Out-String)

# Set WSL2 as default
Log "--- Setting WSL default version to 2 ---"
$r4 = wsl --set-default-version 2 2>&1
Log ($r4 | Out-String)

# 3. Install Node.js LTS via winget
Log "--- Installing Node.js LTS ---"
$r5 = winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent 2>&1
Log ($r5 | Out-String)

# 4. Install Python via winget
Log "--- Installing Python ---"
$r6 = winget install Python.Python.3.12 --accept-source-agreements --accept-package-agreements --silent 2>&1
Log ($r6 | Out-String)

# 5. Install Docker Desktop via winget
Log "--- Installing Docker Desktop ---"
$r7 = winget install Docker.DockerDesktop --accept-source-agreements --accept-package-agreements --silent 2>&1
Log ($r7 | Out-String)

# Refresh PATH for this session
Log "--- Refreshing PATH ---"
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$env:Path = "$machinePath;$userPath"

# 6. Verify installations
Log "--- Verification ---"
Log "Node: $(node --version 2>&1)"
Log "npm: $(npm --version 2>&1)"
Log "Python: $(python --version 2>&1)"
Log "Docker: $(docker --version 2>&1)"
Log "WSL: $(wsl --version 2>&1 | Select-Object -First 1)"

# 7. npm install for root project
Log "--- npm install (root project) ---"
Set-Location "C:\Users\Administratori\Desktop\Robocop"
$r8 = & npm install 2>&1
Log ($r8 | Out-String)

# 8. npm install for dashboard-ui
Log "--- npm install (dashboard-ui) ---"
Set-Location "C:\Users\Administratori\Desktop\Robocop\dashboard-ui"
$r9 = & npm install 2>&1
Log ($r9 | Out-String)

Log "=== INSTALL SCRIPT COMPLETED ==="
Log "NOTE: A REBOOT is required for WSL and Docker Desktop to fully work."
Log "After reboot: open Docker Desktop, then run 'docker compose up -d --build' in the Robocop folder."
