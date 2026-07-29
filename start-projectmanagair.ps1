$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeDir = Join-Path $repoRoot ".runtime\node-v22.23.1-win-x64"
$nodeExe = Join-Path $runtimeDir "node.exe"

if (-not (Test-Path -LiteralPath $nodeExe)) {
  Write-Host "Project ManagAIr portable Node runtime was not found:" -ForegroundColor Red
  Write-Host $nodeExe
  Write-Host "Copy the approved zero-install runtime into .runtime before launching."
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules\tsx"))) {
  Write-Host "Project ManagAIr local Node dependencies are missing." -ForegroundColor Red
  Write-Host "Do not install automatically. Run from a prepared Project ManagAIr workspace with node_modules present."
  exit 1
}

function Get-AvailablePort([int]$preferredPort) {
  for ($port = $preferredPort; $port -le ($preferredPort + 20); $port++) {
    try {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $port)
      $listener.Start()
      $listener.Stop()
      return $port
    } catch {
      continue
    }
  }
  throw "No available loopback port found from $preferredPort to $($preferredPort + 20)."
}

$env:PATH = "$runtimeDir;$env:PATH"
$env:PORT = [string](Get-AvailablePort 4318)
$env:PROJECTMANAGAIR_DEMO = ""

Push-Location $repoRoot
try {
  Write-Host "Creating or migrating Project ManagAIr database..."
  & $nodeExe --import tsx -e "import('./src/db.ts').then(({openProjectManagairDatabase}) => { const ctx = openProjectManagairDatabase(); console.log(JSON.stringify({dbPath: ctx.dbPath, migrationsApplied: ctx.migrationsApplied})); ctx.db.close(); })"
  if ($LASTEXITCODE -ne 0) { throw "Database startup failed." }

  $url = "http://127.0.0.1:$env:PORT/"
  Write-Host "Starting Project ManagAIr at $url"
  Start-Process $url
  & $nodeExe --import tsx .\server.ts --production
} catch {
  Write-Host "Project ManagAIr failed to start:" -ForegroundColor Red
  Write-Host $_
  exit 1
} finally {
  Pop-Location
}
