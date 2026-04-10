# Spaiglass VM installer for Windows 10/11.
#
# Run in PowerShell after registering the VM on https://spaiglass.xyz:
#
#     iwr https://spaiglass.xyz/install.ps1 -useb | iex
#
# Or with explicit credentials (first install only — re-running picks them up
# from %USERPROFILE%\spaiglass\.env automatically):
#
#     & ([scriptblock]::Create((iwr https://spaiglass.xyz/install.ps1 -useb))) `
#         -Token YOUR_TOKEN -Id YOUR_ID -Name YOUR_VM_NAME
#
# Idempotent — re-running upgrades in place, preserves the .env, restarts the
# scheduled task. Pass -Uninstall to remove.
#
# Requires:  PowerShell 5.1+, node>=20, npm, %USERPROFILE%\.local\bin\claude.exe
# Installs:  %USERPROFILE%\spaiglass\{backend,VERSION,.env}
#            Scheduled Task "Spaiglass VM" (At Logon trigger, runs hidden)
#            Auto-registers %USERPROFILE%\projects\*\agents in .claude.json

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
    # Kill any leftover spaiglass node processes
    Get-Process node -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -like "*spaiglass*" } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    Write-Ok "Removed $InstallDir and the scheduled task"
    Write-Ok "Left $env:USERPROFILE\.local\bin\claude.exe and $env:USERPROFILE\projects untouched"
    exit 0
}

# ----- preflight -----
Write-Step "Pre-flight checks"

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

$NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeBin) { Write-Fail "node not found — install Node.js >= 20 from https://nodejs.org" }
$NodeMajor = [int]((& node -e "process.stdout.write(String(process.versions.node.split('.')[0]))"))
if ($NodeMajor -lt 20) { Write-Fail "Node $NodeMajor is too old; need >= 20" }

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Fail "npm not found" }

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
Write-Ok "Node $(node --version), Claude $ClaudeVer"

# ----- download tarball -----
Write-Step "Fetching latest bundle from $RelayUrl"
$TmpTar = [System.IO.Path]::GetTempFileName() + ".tar.gz"
try {
    Invoke-WebRequest -Uri "$RelayUrl/dist.tar.gz" -OutFile $TmpTar -UseBasicParsing -TimeoutSec 30
} catch {
    Write-Fail "Could not download $RelayUrl/dist.tar.gz : $_"
}
$TarSize = (Get-Item $TmpTar).Length
Write-Ok "Downloaded $([int]($TarSize/1024)) KB"

# ----- extract -----
Write-Step "Installing to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# tar.exe ships with Windows 10 1803+. Strip the top-level "spaiglass/" component.
$tarExe = (Get-Command tar.exe -ErrorAction SilentlyContinue).Source
if (-not $tarExe) { Write-Fail "tar.exe not found — Windows 10 build 17063 or newer required" }
& $tarExe -xzf $TmpTar -C $InstallDir --strip-components=1
if ($LASTEXITCODE -ne 0) { Write-Fail "tar extraction failed" }
Remove-Item $TmpTar -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $InstallDir "VERSION"))) { Write-Fail "Tarball is missing VERSION" }
$Version = (Get-Content (Join-Path $InstallDir "VERSION")).Trim()
Write-Ok "Extracted spaiglass $Version"

# Clean stale static/ from old installs (relay now serves the frontend)
$StaleStatic = Join-Path $InstallDir "backend\dist\static"
if (Test-Path $StaleStatic) {
    Remove-Item -Recurse -Force $StaleStatic
    Write-Ok "Removed legacy backend\dist\static"
}

# ----- install backend deps -----
Write-Step "Installing backend dependencies (npm install --omit=dev)"
Push-Location (Join-Path $InstallDir "backend")
try {
    & npm install --omit=dev --no-audit --no-fund --silent
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed" }
} finally { Pop-Location }
Write-Ok "Backend dependencies installed"

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
$envContent | Set-Content -Path $EnvPath -NoNewline -Encoding UTF8
Write-Ok "Wrote $EnvPath"

# ----- auto-register projects in .claude.json -----
Write-Step "Auto-registering ~\projects\*\agents in .claude.json"
$nodeScript = @'
const fs = require("node:fs");
const path = require("node:path");
const HOME = process.argv[2];
const projectsRoot = path.join(HOME, "projects");
const claudeJsonPath = path.join(HOME, ".claude.json");
const claudeProjectsDir = path.join(HOME, ".claude", "projects");

if (!fs.existsSync(projectsRoot)) {
  console.log("  (no ~/projects directory yet — skipping)");
  process.exit(0);
}
function encodePath(p) { return p.replace(/[/\\:._]/g, "-"); }

let claudeJson = { projects: {} };
if (fs.existsSync(claudeJsonPath)) {
  try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8")); }
  catch { claudeJson = { projects: {} }; }
}
claudeJson.projects = claudeJson.projects || {};

let registered = 0, createdDirs = 0;
for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const projDir = path.join(projectsRoot, entry.name);
  if (!fs.existsSync(path.join(projDir, "agents"))) continue;
  if (!claudeJson.projects[projDir]) {
    claudeJson.projects[projDir] = {
      allowedTools: [], history: [], mcpContextUris: [], mcpServers: {},
      enabledMcpjsonServers: [], disabledMcpjsonServers: [],
      hasTrustDialogAccepted: false, projectOnboardingSeenCount: 0,
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
    };
    registered++;
  }
  const targetDir = path.join(claudeProjectsDir, encodePath(projDir));
  if (!fs.existsSync(targetDir)) { fs.mkdirSync(targetDir, { recursive: true }); createdDirs++; }
}
fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
console.log(`  ${registered} project(s) registered, ${createdDirs} project dir(s) created`);
'@
& $NodeBin -e $nodeScript $env:USERPROFILE
Write-Ok "Project auto-registration done"

# ----- scheduled task -----
Write-Step "Installing Scheduled Task '$TaskName' (runs at logon, hidden)"

# Wrapper script that loads .env, starts backend + connector, traps exits
$LogsDir = Join-Path $InstallDir "logs"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
$RunnerPath = Join-Path $InstallDir "run.ps1"

$RunnerContent = @"
# Auto-generated by install.ps1 — do not edit by hand.
`$ErrorActionPreference = 'Stop'
Set-Location '$InstallDir'

# Load .env
Get-Content '$EnvPath' | ForEach-Object {
    if (`$_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
        [Environment]::SetEnvironmentVariable(`$matches[1], `$matches[2].Trim('"'), 'Process')
    }
}

`$backend = Start-Process -FilePath '$NodeBin' ``
    -ArgumentList '$InstallDir\backend\dist\cli\node.js','--host',`$env:HOST,'--port',`$env:PORT,'--claude-path','$ClaudeBin' ``
    -WorkingDirectory '$InstallDir' ``
    -RedirectStandardOutput '$LogsDir\backend.out.log' ``
    -RedirectStandardError  '$LogsDir\backend.err.log' ``
    -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 1
`$connector = Start-Process -FilePath '$NodeBin' ``
    -ArgumentList '$InstallDir\backend\dist\connector.js' ``
    -WorkingDirectory '$InstallDir' ``
    -RedirectStandardOutput '$LogsDir\connector.out.log' ``
    -RedirectStandardError  '$LogsDir\connector.err.log' ``
    -WindowStyle Hidden -PassThru

# Wait for either process to exit, then kill the other so the task ends cleanly
while (-not `$backend.HasExited -and -not `$connector.HasExited) {
    Start-Sleep -Seconds 2
}
if (-not `$backend.HasExited)   { try { `$backend.Kill()   } catch {} }
if (-not `$connector.HasExited) { try { `$connector.Kill() } catch {} }
"@
$RunnerContent | Set-Content -Path $RunnerPath -Encoding UTF8

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
    -Description "Spaiglass VM (backend + relay connector)" | Out-Null

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
else { Write-Warn2 "Local backend didn't respond yet. Check: Get-Content $LogsDir\backend.err.log -Tail 50" }

Write-Host ""
Write-Host "Spaiglass $Version installed." -ForegroundColor Green
Write-Host "  Fleet:      $RelayUrl/fleetrelay"
Write-Host "  This VM:    $RelayUrl/vm/<your-login>.$Name/"
Write-Host "  Binding:    ${BindHost}:$Port ($BindLabel)"
Write-Host "  Logs:       Get-Content $LogsDir\backend.err.log -Tail 50 -Wait"
Write-Host "  Update:     re-run this command"
Write-Host "  Uninstall:  iwr $RelayUrl/install.ps1 -useb | iex; -Uninstall"
Write-Host ""
