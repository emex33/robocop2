<#
.SYNOPSIS
    Launch a new Robocop instance on the same server.

.DESCRIPTION
    Spins up a fully independent Robocop stack (drachtio + rtpengine + app)
    with non-overlapping ports and a separate database directory.

.PARAMETER N
    Instance number (0 = default/original, 1, 2, 3...).

.PARAMETER Action
    "up" to start (default), "down" to stop, "restart" to restart, "logs" to tail logs.

.PARAMETER ExternalIP
    Your server's public IP. Defaults to 45.87.212.182.

.EXAMPLE
    .\launch-instance.ps1 -N 1
    .\launch-instance.ps1 -N 2 -Action down
    .\launch-instance.ps1 -N 1 -Action logs
#>
param(
    [Parameter(Mandatory=$true)]
    [int]$N,

    [ValidateSet("up","down","restart","logs")]
    [string]$Action = "up",

    [string]$ExternalIP = "45.87.212.182"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# Port allocation — each instance gets non-overlapping ranges
$dashboardPort    = 3000 + $N
$sipPort          = 5060 + ($N * 2)
$rtpMin           = 20000 + ($N * 200)
$rtpMax           = $rtpMin + 100
$rtpEngineMin     = 40000 + ($N * 300)
$rtpEngineMax     = $rtpEngineMin + 200
$drachtioAdmin    = 9022 + $N

$dataDir  = if ($N -eq 0) { "data" }  else { "data-$N" }
$logDir   = if ($N -eq 0) { "logs" }  else { "logs-$N" }
$envFile  = if ($N -eq 0) { ".env" }  else { ".env.$N" }
$project  = if ($N -eq 0) { "robocop" } else { "robocop-$N" }

# Ensure data and log dirs exist
$dataPath = Join-Path $projectRoot $dataDir
$logPath  = Join-Path $projectRoot $logDir
if (!(Test-Path $dataPath)) { New-Item -ItemType Directory -Path $dataPath -Force | Out-Null }
if (!(Test-Path $logPath))  { New-Item -ItemType Directory -Path $logPath  -Force | Out-Null }

# Copy .env for this instance if it doesn't exist yet
$envPath = Join-Path $projectRoot $envFile
if (!(Test-Path $envPath)) {
    $baseEnv = Join-Path $projectRoot ".env"
    if (Test-Path $baseEnv) {
        Copy-Item $baseEnv $envPath
        Write-Host "Created $envFile (copied from .env - edit as needed)" -ForegroundColor Yellow
    } else {
        Write-Host "ERROR: No .env file found to copy from!" -ForegroundColor Red
        exit 1
    }
}

# Build environment for docker compose
$env:DASHBOARD_PORT    = $dashboardPort
$env:SIP_PORT          = $sipPort
$env:RTP_PORT_MIN      = $rtpMin
$env:RTP_PORT_MAX      = $rtpMax
$env:RTPENGINE_PORT_MIN = $rtpEngineMin
$env:RTPENGINE_PORT_MAX = $rtpEngineMax
$env:DATA_DIR          = $dataDir
$env:LOG_DIR           = $logDir
$env:ENV_FILE          = $envFile
$env:EXTERNAL_IP       = $ExternalIP
$env:DRACHTIO_ADMIN_PORT = $drachtioAdmin
$env:DRACHTIO_SECRET   = "cymru"
$env:DRACHTIO_HOST     = "172.18.0.1"

Write-Host ""
Write-Host "=== ROBOCOP Instance #$N ===" -ForegroundColor Cyan
Write-Host "  Project:      $project"
Write-Host "  Dashboard:    http://localhost:$dashboardPort"
Write-Host "  SIP Port:     $sipPort"
Write-Host "  Drachtio:     admin port $drachtioAdmin"
Write-Host "  RTP Range:    $rtpMin - $rtpMax"
Write-Host "  RTPEngine:    $rtpEngineMin - $rtpEngineMax"
Write-Host "  Data Dir:     $dataDir/"
Write-Host "  Env File:     $envFile"
Write-Host ""

Set-Location $projectRoot

switch ($Action) {
    "up" {
        Write-Host "Starting instance #$N..." -ForegroundColor Green
        docker compose -p $project -f docker-compose.instance.yml up -d --build 2>&1
    }
    "down" {
        Write-Host "Stopping instance #$N..." -ForegroundColor Yellow
        docker compose -p $project -f docker-compose.instance.yml down 2>&1
    }
    "restart" {
        Write-Host "Restarting instance #$N..." -ForegroundColor Yellow
        docker compose -p $project -f docker-compose.instance.yml restart app 2>&1
    }
    "logs" {
        docker compose -p $project -f docker-compose.instance.yml logs -f app 2>&1
    }
}
