<#
Starts the camera bridge on Windows, connects it to the private VPN, and
restarts it automatically at sign-in. Run once from an elevated PowerShell:

  Set-ExecutionPolicy -Scope Process Bypass
  .\Start-CameraBridge.ps1 -Install

The first run asks for the dedicated VPN password and stores it encrypted for
the current Windows account. Nothing is exposed to the public Internet.
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Run,
    [string]$ProjectDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$VpnServer = 'https://proxyserver.s1m4.me:8443'
$VpnUser = 'camera-bridge'
$VpnPin = 'pin-sha256:NKATXML+h5hQ61lEyvfUsJHWtIMaDPLmRhj2Ble0CMQ='
$VpnNetwork = '10.12.0.0/24'
$VpnServerIp = '10.12.0.1'
$TaskName = 'Camera Bridge (private VPN)'
$SecretFile = Join-Path $ProjectDir 'camera-bridge-vpn-password.xml'

function Require-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Open PowerShell as Administrator and run this command again.'
    }
}

function Find-OpenConnect {
    $command = Get-Command 'openconnect.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        "$env:ProgramFiles\OpenConnect\openconnect.exe",
        "${env:ProgramFiles(x86)}\OpenConnect\openconnect.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'OpenConnect for Windows is not installed. Install it first, then run this script again.'
}

function Wait-Docker {
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if ((-not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) -and (Test-Path $desktop)) {
        Start-Process $desktop
    }
    for ($i = 0; $i -lt 36; $i++) {
        docker info *> $null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 5
    }
    throw 'Docker Desktop did not become ready within three minutes.'
}

function Get-PlaintextSecret {
    if (-not (Test-Path $SecretFile)) {
        if (-not $Install) { throw 'The encrypted VPN password is missing. Run with -Install once.' }
        $secure = Read-Host "VPN password for $VpnUser" -AsSecureString
        $secure | Export-Clixml -Path $SecretFile
    }
    $secure = Import-Clixml -Path $SecretFile
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Connect-PrivateVpn([string]$OpenConnect) {
    $existing = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like '10.12.0.*' } | Select-Object -First 1
    if (-not $existing) {
        Get-Process 'openconnect' -ErrorAction SilentlyContinue | Stop-Process -Force
        $password = Get-PlaintextSecret
        $passwordFile = Join-Path $env:TEMP 'camera-bridge-openconnect-password.txt'
        $outLog = Join-Path $ProjectDir 'openconnect.log'
        $errorLog = Join-Path $ProjectDir 'openconnect-error.log'
        try {
            # OpenConnect for Windows has no --background flag. Start it in a
            # hidden process and remove the short-lived password file at once.
            [IO.File]::WriteAllText($passwordFile, "$password`r`n", [Text.UTF8Encoding]::new($false))
            $vpn = Start-Process -FilePath $OpenConnect -ArgumentList @(
                '--protocol=anyconnect', "--user=$VpnUser", '--passwd-on-stdin',
                "--servercert=$VpnPin", $VpnServer
            ) -WindowStyle Hidden -RedirectStandardInput $passwordFile -RedirectStandardOutput $outLog -RedirectStandardError $errorLog -PassThru
            Start-Sleep -Seconds 2
            if ($vpn.HasExited) { throw "OpenConnect exited immediately. See $outLog and $errorLog" }
        }
        finally {
            if (Test-Path $passwordFile) { Remove-Item $passwordFile -Force }
        }
    }
    for ($i = 0; $i -lt 30; $i++) {
        $address = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -like '10.12.0.*' } | Select-Object -First 1
        if ($address) { return $address.IPAddress }
        Start-Sleep -Seconds 2
    }
    throw 'The VPN connected but did not receive a 10.12.0.x address.'
}

function Set-CameraFirewall {
    Get-NetFirewallRule -DisplayName 'Camera Bridge - *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    # Other VPN clients are explicitly blocked. The VPS itself remains allowed.
    New-NetFirewallRule -DisplayName 'Camera Bridge - block VPN peers TCP' -Direction Inbound -Action Block -Protocol TCP -LocalPort '1984,8554,8555' -RemoteAddress '10.12.0.2-10.12.0.254' | Out-Null
    New-NetFirewallRule -DisplayName 'Camera Bridge - block VPN peers UDP' -Direction Inbound -Action Block -Protocol UDP -LocalPort '8555' -RemoteAddress '10.12.0.2-10.12.0.254' | Out-Null
    New-NetFirewallRule -DisplayName 'Camera Bridge - allow VPS TCP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort '1984,8554,8555' -RemoteAddress $VpnServerIp | Out-Null
    New-NetFirewallRule -DisplayName 'Camera Bridge - allow VPS UDP' -Direction Inbound -Action Allow -Protocol UDP -LocalPort '8555' -RemoteAddress $VpnServerIp | Out-Null
}

function Write-Go2RtcConfig([string]$VpnIp) {
    @"
streams:
  lsc_ptz:
    - rtsp://host.docker.internal:8554/LSC_PTZ_Camera/hd

api:
  listen: ":1984"

webrtc:
  listen: ":8555"
  candidates:
    - $VpnIp`:8555
"@ | Set-Content -Path (Join-Path $ProjectDir 'go2rtc.yaml') -Encoding utf8
}

function Ensure-BridgeFiles {
    $baseCompose = Join-Path $ProjectDir 'docker-compose.ports.yml'
    if (-not (Test-Path $baseCompose)) {
        throw "This folder is not tuya-rtsp-bridge. Missing: $baseCompose"
    }
    $go2rtcCompose = Join-Path $ProjectDir 'docker-compose.go2rtc.yml'
    if (-not (Test-Path $go2rtcCompose)) {
        @"
services:
  go2rtc:
    image: alexxit/go2rtc:latest
    container_name: go2rtc
    restart: unless-stopped
    ports:
      - "1984:1984"
      - "8555:8555/tcp"
      - "8555:8555/udp"
    volumes:
      - ./go2rtc.yaml:/config/go2rtc.yaml:ro
"@ | Set-Content -Path $go2rtcCompose -Encoding utf8
    }
}

function Start-Bridge([string]$VpnIp) {
    Write-Go2RtcConfig $VpnIp
    Push-Location $ProjectDir
    try {
        docker compose -f docker-compose.ports.yml -f docker-compose.go2rtc.yml up -d --build
        if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed to start the camera bridge.' }
    }
    finally { Pop-Location }
}

function Install-Autostart {
    $powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $script = $PSCommandPath
    $action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Run"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
}

if ($Install) { Require-Administrator }
Ensure-BridgeFiles
$openConnect = Find-OpenConnect
Wait-Docker
$vpnIp = Connect-PrivateVpn $openConnect
if ($Install) { Set-CameraFirewall }
Start-Bridge $vpnIp
if ($Install) { Install-Autostart }
Write-Host "Camera bridge is running privately through $vpnIp."
