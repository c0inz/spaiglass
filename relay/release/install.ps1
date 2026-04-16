# Spaiglass VM installer for Windows 10/11 — Phase 3 binary edition.
#
# Run in PowerShell after registering the VM on https://spaiglass.xyz:
#
#     iwr https://spaiglass.xyz/install.ps1 -useb | iex
#
# Or with explicit credentials:
#
#     & ([scriptblock]::Create((iwr https://spaiglass.xyz/install.ps1 -useb))) `
#         -Token YOUR_TOKEN -Id YOUR_ID -Name YOUR_VM_NAME
#
# This installer downloads a single self-contained .exe (no Node, no npm,
# no node_modules) and registers a per-user Scheduled Task that runs at logon.
#
# Idempotent — re-running upgrades in place, preserves the .env, restarts the
# scheduled task. Pass -Uninstall to remove.
#
# Requires:  PowerShell 5.1+, tar.exe (ships in Windows 10 1803+),
#            %USERPROFILE%\.local\bin\claude.exe (Anthropic Claude Code CLI).
#            No Node, no npm, no developer tools.
# Installs:  %USERPROFILE%\spaiglass\{spaiglass-host.exe,static\,VERSION,.env}
#            Scheduled Task "Spaiglass VM" (At Logon trigger, runs hidden)

[CmdletBinding()]
param(
    [string]$Token,
    [string]$Id,
    [string]$Name,
    [string]$RelayUrl = "https://spaiglass.xyz",
    [string]$InstallDir,
    [int]$Port = 8080,
    [switch]$LanBind,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
if (-not $InstallDir) { $InstallDir = Join-Path $env:USERPROFILE "spaiglass" }
$TaskName = "Spaiglass VM"
$Target   = "windows-x64"  # ARM64 Windows: not yet shipped, x64 binary runs under emulation

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host " OK $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host " !! $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host " XX $msg" -ForegroundColor Red; exit 1 }

# ----- uninstall path -----
if ($Uninstall) {
    Write-Step "Uninstalling Spaiglass"
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
    } catch {}
    # Kill any leftover spaiglass-host processes
    Get-Process spaiglass-host -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    Write-Ok "Removed $InstallDir and the scheduled task"
    Write-Ok "Left $env:USERPROFILE\.local\bin\claude.exe and $env:USERPROFILE\projects untouched"
    exit 0
}

# ----- preflight -----
Write-Step "Pre-flight checks"

# Persistence gate — warn loudly before we download anything. Unlike Linux
# (systemd --user + enable-linger) and macOS (launchd agents), Windows
# scheduled tasks registered as Interactive LogonType only run while the
# user is logged in. The moment the user signs out / switches users / reboots
# without auto-login, the task terminates and the VM goes offline. Getting a
# task to "run whether logged on or not" needs -LogonType Password (stores
# the user's password) or -LogonType S4U (local accounts only, no network),
# neither of which is appropriate for an installer that claims "no admin
# needed". This is a known limitation — document it, don't hide it.
#
# TODO: ship a proper Windows service (nssm / sc.exe create) as a follow-up
# so Windows VMs reach parity with Linux/macOS.
Write-Warn2 "Windows persistence note: this VM stays online only while you are"
Write-Warn2 "logged in. Logging out, switching users, or rebooting without"
Write-Warn2 "auto-login will take the VM offline until you sign back in."
Write-Warn2 "(Linux + macOS hosts do NOT have this limitation.)"

# Reuse credentials from existing .env on upgrade
$EnvPath = Join-Path $InstallDir ".env"
if (-not $Token -and (Test-Path $EnvPath)) {
    Get-Content $EnvPath | ForEach-Object {
        if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
            $k = $matches[1]; $v = $matches[2].Trim('"')
            if ($k -eq 'CONNECTOR_TOKEN' -and -not $Token) { $Token = $v }
            if ($k -eq 'CONNECTOR_ID'    -and -not $Id)    { $Id    = $v }
            if ($k -eq 'CONNECTOR_NAME'  -and -not $Name)  { $Name  = $v }
        }
    }
    if ($Token) { Write-Ok "Upgrading existing install (reusing $EnvPath)" }
}

if (-not $Token) { Write-Fail "Missing -Token (get it from $RelayUrl/fleetrelay)" }
if (-not $Id)    { Write-Fail "Missing -Id" }
if (-not $Name)  { Write-Fail "Missing -Name" }

$ClaudeBin = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
if (-not (Test-Path $ClaudeBin)) {
    $alt = (Get-Command claude.exe -ErrorAction SilentlyContinue).Source
    if ($alt) {
        $ClaudeBin = $alt
        Write-Warn2 "Using claude at $ClaudeBin (not the standard $env:USERPROFILE\.local\bin\claude.exe)"
    } else {
        Write-Fail "Claude Code CLI not found. Install with: irm https://claude.ai/install.ps1 | iex"
    }
}
$ClaudeVer = (& $ClaudeBin --version 2>&1 | Select-Object -First 1)
Write-Ok "Claude $ClaudeVer"
Write-Ok "Target platform: $Target"

# ----- download binary tarball -----
# The relay publishes per-platform tarballs at /releases/spaiglass-host-<target>.tar.gz.
# Each tarball contains the binary, the static/ frontend dir, and a VERSION file.
Write-Step "Fetching $Target binary from $RelayUrl"
$TmpTar = [System.IO.Path]::GetTempFileName() + ".tar.gz"
$TarballUrl = "$RelayUrl/releases/spaiglass-host-$Target.tar.gz"
try {
    Invoke-WebRequest -Uri $TarballUrl -OutFile $TmpTar -UseBasicParsing -TimeoutSec 60
} catch {
    Write-Fail "Could not download $TarballUrl : $_"
}
$TarSize = (Get-Item $TmpTar).Length
Write-Ok "Downloaded $([int]($TarSize/1024/1024)) MB"

# ----- extract -----
Write-Step "Installing to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# tar.exe ships with Windows 10 1803+. Strip the top-level "spaiglass-host-windows-x64/" component.
$tarExe = (Get-Command tar.exe -ErrorAction SilentlyContinue).Source
if (-not $tarExe) { Write-Fail "tar.exe not found — Windows 10 build 17063 or newer required" }
& $tarExe -xzf $TmpTar -C $InstallDir --strip-components=1
if ($LASTEXITCODE -ne 0) { Write-Fail "tar extraction failed" }
Remove-Item $TmpTar -ErrorAction SilentlyContinue

# Strip Mark-of-the-Web from every extracted file. Invoke-WebRequest stamps
# MOTW on the tarball and Windows' tar.exe propagates it to the extracted
# files on current builds. SmartScreen will silently block the first exec of
# an MOTW-tagged unsigned .exe under a hidden Scheduled Task, producing a
# dead service with no user-visible error. Unblock-File is idempotent and a
# no-op when no MOTW is present. Longer term: Authenticode-sign the binary.
Get-ChildItem -Path $InstallDir -Recurse -File -ErrorAction SilentlyContinue |
    Unblock-File -ErrorAction SilentlyContinue
Write-Ok "Cleared Mark-of-the-Web (SmartScreen bypass)"

if (-not (Test-Path (Join-Path $InstallDir "VERSION"))) { Write-Fail "Tarball is missing VERSION" }
$BinPath = Join-Path $InstallDir "spaiglass-host.exe"
if (-not (Test-Path $BinPath)) { Write-Fail "Tarball is missing spaiglass-host.exe" }
$Version = (Get-Content (Join-Path $InstallDir "VERSION")).Trim()
Write-Ok "Extracted spaiglass $Version"

# Clean stale files from a pre-Phase-3 npm-based install if present.
$LegacyBackend = Join-Path $InstallDir "backend"
if (Test-Path $LegacyBackend) {
    Remove-Item -Recurse -Force $LegacyBackend
    Write-Ok "Removed legacy backend\ dir from previous npm-based install"
}
$LegacyNm = Join-Path $InstallDir "node_modules"
if (Test-Path $LegacyNm) {
    Remove-Item -Recurse -Force $LegacyNm
    Write-Ok "Removed legacy node_modules"
}

# ----- write .env -----
if ($LanBind) {
    $BindHost  = "0.0.0.0"
    $BindLabel = "all interfaces — LAN-accessible"
} else {
    $BindHost  = "127.0.0.1"
    $BindLabel = "loopback only — reachable only via spaiglass.xyz"
}

Write-Step "Writing .env (binding: $BindLabel)"
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$envContent = @"
# Spaiglass VM connector — generated by install.ps1 on $timestamp
RELAY_URL=$RelayUrl
CONNECTOR_TOKEN=$Token
CONNECTOR_ID=$Id
CONNECTOR_NAME=$Name
SPAIGLASS_VERSION=$Version
PORT=$Port
HOST=$BindHost
"@
# BOM-less UTF-8 write. `Set-Content -Encoding UTF8` on PowerShell 5.1 (the
# version that ships with stock Windows 10/11) emits a UTF-8 BOM (EF BB BF).
# Reading it back line-by-line makes the first key come out as `\ufeffRELAY_URL`,
# the regex `^\s*([A-Z_]+)` fails to match, and RELAY_URL silently disappears
# from the runner's process env — the binary then crashes on missing config.
# [IO.File]::WriteAllText with UTF8Encoding($false) is BOM-less on BOTH
# 5.1 and 7+, so we route around the cmdlet entirely.
[System.IO.File]::WriteAllText($EnvPath, $envContent, [System.Text.UTF8Encoding]::new($false))
Write-Ok "Wrote $EnvPath"

# Note: ~/projects/*/agents/ auto-registration in .claude.json is now done by
# the binary itself on every boot, so the installer no longer touches it.

# ----- scheduled task -----
Write-Step "Installing Scheduled Task '$TaskName' (runs at logon, hidden)"

$LogsDir = Join-Path $InstallDir "logs"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

# Wrapper script: load .env, exec the binary, redirect stdout/stderr to logs.
$RunnerPath = Join-Path $InstallDir "run.ps1"
$RunnerContent = @"
# Auto-generated by install.ps1 — do not edit by hand.
`$ErrorActionPreference = 'Stop'
Set-Location '$InstallDir'

Get-Content '$EnvPath' | ForEach-Object {
    if (`$_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
        [Environment]::SetEnvironmentVariable(`$matches[1], `$matches[2].Trim('"'), 'Process')
    }
}

`$proc = Start-Process -FilePath '$BinPath' ``
    -ArgumentList '--host',`$env:HOST,'--port',`$env:PORT,'--claude-path','$ClaudeBin' ``
    -WorkingDirectory '$InstallDir' ``
    -RedirectStandardOutput '$LogsDir\spaiglass.out.log' ``
    -RedirectStandardError  '$LogsDir\spaiglass.err.log' ``
    -WindowStyle Hidden -PassThru
`$proc.WaitForExit()
exit `$proc.ExitCode
"@
# BOM-less UTF-8 — same reason as the .env write above. powershell.exe
# tolerates a BOM'd script, but consistency + defensiveness.
[System.IO.File]::WriteAllText($RunnerPath, $RunnerContent, [System.Text.UTF8Encoding]::new($false))

$action    = New-ScheduledTaskAction -Execute "powershell.exe" `
                -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunnerPath`""
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries -StartWhenAvailable `
                -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
                -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description "Spaiglass VM (single-binary host)" | Out-Null

Stop-ScheduledTask  -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
Write-Ok "Scheduled Task installed and started"

# ----- verify -----
Write-Step "Verifying"
Start-Sleep -Seconds 4
$ok = $false
foreach ($p in @("/api/health","/")) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$p" -UseBasicParsing -TimeoutSec 5
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
}
if ($ok) { Write-Ok "Local backend responding on :$Port" }
else { Write-Warn2 "Local backend didn't respond yet. Check: Get-Content $LogsDir\spaiglass.err.log -Tail 50" }

Write-Host ""
Write-Host "Spaiglass $Version installed." -ForegroundColor Green
Write-Host "  Sign in:    $RelayUrl  (GitHub auth — routes you straight to your chat)"
Write-Host "  VM name:    $Name"
Write-Host "  Binding:    ${BindHost}:$Port ($BindLabel)"
Write-Host "  Logs:       Get-Content $LogsDir\spaiglass.err.log -Tail 50 -Wait"
Write-Host "  Update:     re-run this command (idempotent — preserves .env)"
Write-Host "  Uninstall:  iwr $RelayUrl/install.ps1 -useb | iex; -Uninstall"
Write-Host ""
Write-Warn2 "Reminder: VM stays online only while you are signed in to Windows."
Write-Host ""
