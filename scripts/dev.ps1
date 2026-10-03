# Start the API and Vite development server on Windows.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $projectDir 'backend'
$frontendDir = Join-Path $projectDir 'frontend'
$python = Join-Path $backendDir '.venv\Scripts\python.exe'
$vite = Join-Path $frontendDir 'node_modules\vite\bin\vite.js'
$apiProcess = $null

function Get-Port([string] $name, [int] $default) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $default }
    $port = 0
    if (-not [int]::TryParse($value, [ref] $port) -or $port -lt 1 -or $port -gt 65535) {
        throw "$name must be a port between 1 and 65535."
    }
    return $port
}

try {
    $apiPort = Get-Port 'API_PORT' 8016
    $frontendPort = Get-Port 'FRONTEND_PORT' 5186
    if ($apiPort -eq $frontendPort) { throw 'API_PORT and FRONTEND_PORT must differ.' }

    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        throw 'uv is required. Install it from https://docs.astral.sh/uv/.'
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js 22.13 or newer is required.'
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'npm is required. Install Node.js 22.13 or newer.'
    }
    $nodeVersion = (& node -p 'process.versions.node').Trim()
    if ($LASTEXITCODE -ne 0 -or [version] $nodeVersion -lt [version] '22.13.0') {
        throw "Node.js 22.13 or newer is required (found $nodeVersion)."
    }

    Write-Host 'Checking backend dependencies...'
    Push-Location $backendDir
    try {
        & uv sync --frozen --extra dev --python 3.12
        if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed.' }
    } finally { Pop-Location }
    $lockHash = (Get-FileHash (Join-Path $frontendDir 'package-lock.json') -Algorithm SHA256).Hash
    $lockMarker = Join-Path $frontendDir 'node_modules\.nahriva-lock-hash'
    $installedHash = if (Test-Path $lockMarker) { (Get-Content $lockMarker -Raw).Trim() } else { '' }
    if (-not (Test-Path $vite -PathType Leaf) -or $installedHash -ne $lockHash) {
        Write-Host 'Installing frontend dependencies...'
        Push-Location $frontendDir
        try {
            & npm.cmd ci
            if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
            Set-Content -Path $lockMarker -Value $lockHash -Encoding ASCII
        } finally { Pop-Location }
    }

    Write-Host "Starting API at http://127.0.0.1:$apiPort"
    $apiProcess = Start-Process -FilePath $python -ArgumentList @(
        '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', "$apiPort"
    ) -WorkingDirectory $backendDir -NoNewWindow -PassThru

    $env:VITE_API_PROXY_TARGET = "http://127.0.0.1:$apiPort"
    Write-Host "Starting dashboard at http://127.0.0.1:$frontendPort"
    Write-Host 'Press Ctrl+C to stop both servers.'
    Push-Location $frontendDir
    try {
        & node $vite --host 127.0.0.1 --port $frontendPort --strictPort
        if ($LASTEXITCODE -ne 0) { throw "Vite exited with code $LASTEXITCODE." }
    } finally { Pop-Location }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $apiProcess -and -not $apiProcess.HasExited) {
        Stop-Process -Id $apiProcess.Id -Force -ErrorAction SilentlyContinue
        $apiProcess.WaitForExit()
    }
}
