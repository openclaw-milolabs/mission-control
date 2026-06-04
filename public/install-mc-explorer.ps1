# ============================================================
# Mission Control — "Open in Explorer" one-click setup
# ============================================================
# Registers the custom "mc-explorer:" URL protocol for the CURRENT USER so that
# path links in the Mission Control dashboard open in Windows File Explorer —
# even though the dashboard server itself may run on Linux.
#
# No administrator rights are required (everything goes under HKCU).
#
# To install:   right-click this file -> "Run with PowerShell"
#   …or from a terminal:
#       powershell -NoProfile -ExecutionPolicy Bypass -File install-mc-explorer.ps1
#
# To uninstall: run with the -Uninstall switch:
#       powershell -NoProfile -ExecutionPolicy Bypass -File install-mc-explorer.ps1 -Uninstall
#
# Security: the handler ONLY ever launches explorer.exe pointed at the path. It
# never executes the target file, so the worst a rogue page can do is pop open a
# File Explorer window. It also refuses anything that isn't an absolute drive or
# UNC path.
# ============================================================

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$base = 'HKCU:\Software\Classes\mc-explorer'

if ($Uninstall) {
    if (Test-Path $base) { Remove-Item -Path $base -Recurse -Force }
    Write-Host "Removed the mc-explorer: handler." -ForegroundColor Yellow
    return
}

# --- 1. Write the helper script to a stable per-user location ----------------
$appDir = Join-Path $env:LOCALAPPDATA 'MissionControl'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
$helper = Join-Path $appDir 'mc-explorer-open.ps1'

$helperBody = @'
param([string]$Uri)
Add-Type -AssemblyName System.Windows.Forms
try {
    if (-not $Uri) { return }
    # Strip the scheme (case-insensitive) and any trailing slash the browser may
    # append, then URL-decode back into a real Windows path.
    $raw  = $Uri -replace '^[Mm][Cc]-[Ee][Xx][Pp][Ll][Oo][Rr][Ee][Rr]:', ''
    $raw  = $raw.TrimEnd('/')
    $path = [System.Uri]::UnescapeDataString($raw)

    # Only absolute drive paths (M:\...) or UNC paths (\\server\share) are allowed.
    if ($path -notmatch '^[A-Za-z]:[\\/]' -and $path -notmatch '^\\\\') {
        [System.Windows.Forms.MessageBox]::Show("Not a valid path:`n$path", "Mission Control") | Out-Null
        return
    }

    if (Test-Path -LiteralPath $path) {
        if (Test-Path -LiteralPath $path -PathType Container) {
            Start-Process explorer.exe -ArgumentList "`"$path`""
        } else {
            # A file: open its folder with the file selected.
            Start-Process explorer.exe -ArgumentList "/select,`"$path`""
        }
    } else {
        [System.Windows.Forms.MessageBox]::Show("Path not found:`n$path`n`nIs the drive connected?", "Mission Control") | Out-Null
    }
} catch {
    [System.Windows.Forms.MessageBox]::Show("Could not open the location:`n$($_.Exception.Message)", "Mission Control") | Out-Null
}
'@
Set-Content -Path $helper -Value $helperBody -Encoding UTF8

# --- 2. Register the protocol under HKCU -------------------------------------
New-Item -Path $base -Force | Out-Null
Set-ItemProperty -Path $base -Name '(default)'    -Value 'URL:Mission Control Explorer Opener'
Set-ItemProperty -Path $base -Name 'URL Protocol' -Value ''

$cmdKey = Join-Path $base 'shell\open\command'
New-Item -Path $cmdKey -Force | Out-Null

$psExe   = Join-Path $PSHOME 'powershell.exe'
$command = '"{0}" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}" "%1"' -f $psExe, $helper
Set-ItemProperty -Path $cmdKey -Name '(default)' -Value $command

Write-Host ""
Write-Host "  Mission Control 'Open in Explorer' is installed." -ForegroundColor Green
Write-Host "  Path links in the dashboard will now open in File Explorer." -ForegroundColor Green
Write-Host "  (The first click per browser may ask once for permission to open the link.)" -ForegroundColor DarkGray
Write-Host ""
