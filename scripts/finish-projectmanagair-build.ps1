# Project ManagAIr build finaliser — Windows launcher.
#
# WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT
# -----------------------------------------------------
# It finds a Node runtime, checks the workspace is prepared, runs the finaliser
# and renders the outcome. It contains no Git, GitHub or Google Drive logic at
# all. That logic lives in `src/buildFinalizer.ts`, which the Cockpit's Finalise
# button also calls, so there is exactly one implementation of every rule about
# verifying a SHA, refusing a conflicting head or not creating a second pull
# request — and it is covered by the automated test suite.
#
# Splitting it this way is deliberate. A second copy of those rules written in
# PowerShell could not be tested by `npm test`, and two copies of a safety rule
# is one copy too many.

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir

function Resolve-NodeExecutable {
    # The portable runtime the rest of Project ManagAIr uses, then whatever is on
    # PATH. Nothing is installed and nothing is downloaded.
    $portable = Join-Path $repoRoot '.runtime\node-v22.23.1-win-x64\node.exe'
    if (Test-Path -LiteralPath $portable) { return $portable }
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
}

$nodeExe = Resolve-NodeExecutable
if (-not $nodeExe) {
    Write-Host 'Project ManagAIr could not find a Node runtime.' -ForegroundColor Red
    Write-Host 'Expected the portable runtime under .runtime, or node.exe on PATH.'
    exit 3
}

$tsx = Join-Path $repoRoot 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path -LiteralPath $tsx)) {
    Write-Host 'Project ManagAIr local Node dependencies are missing.' -ForegroundColor Red
    Write-Host 'Run this from a prepared Project ManagAIr workspace with node_modules present. Nothing is installed automatically.'
    exit 3
}

$gitOnPath = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitOnPath) {
    Write-Host 'git was not found on PATH. The finaliser needs it to verify, fetch and push.' -ForegroundColor Red
    exit 3
}

Write-Host ''
Write-Host 'Project ManagAIr — finishing the build' -ForegroundColor Cyan
Write-Host ''

$entry = Join-Path $repoRoot 'scripts\finalize-build.ts'
& $nodeExe $tsx $entry @args
$code = $LASTEXITCODE

Write-Host ''
switch ($code) {
    0 { Write-Host 'COMPLETED — branch pushed, remote SHA verified, pull request in place, deliverables mirrored.' -ForegroundColor Green }
    1 { Write-Host 'PARTIAL — the Git side is safely finished. Something after it is outstanding; read the report above and run this again to retry only that.' -ForegroundColor Yellow }
    2 { Write-Host 'FAILED — nothing was changed. Read the reason above.' -ForegroundColor Red }
    3 { Write-Host 'The workspace is not ready. Nothing was attempted.' -ForegroundColor Red }
    default { Write-Host "The finaliser exited with code $code." -ForegroundColor Red }
}
Write-Host ''

exit $code
