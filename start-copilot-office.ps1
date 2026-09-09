[CmdletBinding()]
param(
    [int]$Port = 56276,
    [switch]$NoBrowser,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CliArgs
)

$ErrorActionPreference = 'Stop'
$bundle = Join-Path $PSScriptRoot 'dist\cli.js'
for ($i = 0; $i -lt $CliArgs.Count; $i++) {
    switch ($CliArgs[$i]) {
        '--port' {
            $i++
            if ($i -ge $CliArgs.Count) { throw 'Missing --port value.' }
            $Port = [int]$CliArgs[$i]
        }
        '--terminal-controls' {}
        '--watch-all-sessions' {}
        '--no-browser' { $NoBrowser = $true }
        default { throw "Unsupported launcher option: $($CliArgs[$i])" }
    }
}
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) {
    throw "The office has not been built. Run npm run build in $PSScriptRoot."
}
$null = Get-Command node -ErrorAction Stop

function Find-RunningOffice {
    $registry = Join-Path $env:USERPROFILE '.pixel-agents\servers'
    if (-not (Test-Path -LiteralPath $registry -PathType Container)) { return $null }
    foreach ($file in Get-ChildItem -LiteralPath $registry -Filter '*.json' -File) {
        try {
            $entry = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        } catch {
            Write-Warning "Cannot read office registry entry: $($file.FullName)"
            continue
        }
        if ($entry.servesSpa -ne $true -or $entry.port -ne $Port -or
            $entry.pid -isnot [int] -or $entry.pid -le 0 -or
            $entry.token -notmatch '^[a-fA-F0-9-]{36}$') { continue }
        $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.pid)"
        if (-not $serverProcess -or
            $serverProcess.CommandLine -notmatch [regex]::Escape($bundle) -or
            $serverProcess.CommandLine -notmatch '(?:^|\s)--copilot(?:\s|$)' -or
            $serverProcess.CommandLine -notmatch '(?:^|\s)--terminal-controls(?:\s|$)') { continue }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
        } catch [System.Net.WebException] {
            Write-Warning "The registered office on port $Port did not respond."
            continue
        } catch [System.Net.Http.HttpRequestException] {
            Write-Warning "The registered office on port $Port did not respond."
            continue
        }
        if ($health.status -eq 'ok' -and $health.pid -eq $entry.pid) {
            return "http://127.0.0.1:$Port/?token=$($entry.token)"
        }
    }
    return $null
}

function Open-Office([string]$Url) {
    Write-Host ''
    Write-Host "Pixel Office: $Url"
    Write-Host 'This URL grants local terminal controls. Do not share it.'
    if (-not $NoBrowser) { Start-Process -FilePath $Url }
}

$url = Find-RunningOffice
if ($url) {
    Write-Host 'Reusing the running Copilot office.'
    Open-Office $url
    exit 0
}

$mutex = New-Object System.Threading.Mutex($false, "Local\PixelCopilotOffice-$Port")
$locked = $false
try {
    try {
        $locked = $mutex.WaitOne(15000)
    } catch [System.Threading.AbandonedMutexException] {
        $locked = $true
    }
    $url = Find-RunningOffice
    if ($url) {
        Write-Host 'Reusing the running Copilot office.'
        Open-Office $url
        exit 0
    }
    if (-not $locked) { throw 'Another office launcher is starting. Wait a moment and try again.' }

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
    try {
        $listener.Start()
    } catch [System.Net.Sockets.SocketException] {
        throw "Port $Port is already occupied by another process or an incompatible office. No process was stopped."
    } finally {
        $listener.Stop()
    }

    Write-Host 'Starting Copilot office. Keep this window open; Ctrl+C stops only the office.'
    $opened = $false
    & node $bundle --copilot --watch-all-sessions --terminal-controls --no-reuse --port $Port --host 127.0.0.1 |
        ForEach-Object {
            Write-Host $_
            if (-not $opened -and $_ -match 'Pixel Agents server running at (http://127\.0\.0\.1:\d+/\?token=[a-fA-F0-9-]{36})') {
                $actual = [uri]$Matches[1]
                if ($actual.Port -ne $Port) {
                    throw 'The runtime reused an office on a different port. Close that office before changing ports.'
                }
                $url = Find-RunningOffice
                if (-not $url) { throw 'The new office did not pass its local identity and health check.' }
                $opened = $true
                Open-Office $url
            }
        }
    if ($LASTEXITCODE -ne 0) { throw "Copilot office exited with code $LASTEXITCODE." }
    if (-not $opened) { throw 'The office exited before becoming ready.' }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
