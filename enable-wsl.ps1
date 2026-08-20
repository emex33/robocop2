$ErrorActionPreference = "Stop"
Write-Host "=== Enabling WSL2 Windows Features ===" -ForegroundColor Cyan

Write-Host "1. Enabling Windows Subsystem for Linux..." -ForegroundColor Yellow
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart

Write-Host "2. Enabling Virtual Machine Platform..." -ForegroundColor Yellow
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

Write-Host "3. Setting WSL default version to 2..." -ForegroundColor Yellow
wsl --set-default-version 2 2>$null

Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "A REBOOT is required for WSL to work." -ForegroundColor Red
Write-Host "After reboot:" -ForegroundColor Cyan
Write-Host "  1. Open Docker Desktop (it should start automatically)" -ForegroundColor White
Write-Host "  2. Open a terminal in C:\Users\Administratori\Desktop\Robocop" -ForegroundColor White
Write-Host "  3. Run: docker compose up -d --build" -ForegroundColor White
Write-Host ""
Read-Host "Press Enter to reboot now (or Ctrl+C to reboot later)"
Restart-Computer -Force
