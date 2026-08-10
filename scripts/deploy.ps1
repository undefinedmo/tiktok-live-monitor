# deploy.ps1 — push web and/or middleware to the Contabo VPS.
#
# Usage:
#   .\scripts\deploy.ps1                  # both apps
#   .\scripts\deploy.ps1 -App web         # web only (build locally + ship)
#   .\scripts\deploy.ps1 -App middleware  # middleware only (git pull + build on VPS)
#   .\scripts\deploy.ps1 -SkipPush        # skip auto git push (middleware)
#
# Web flow: builds .next/standalone locally (VPS Next 16 build hits a
# workStore framework bug), zips it, ships via SCP, expands with PowerShell's
# Expand-Archive on VPS (Windows-shipped tar drops long paths), recreates two
# junctions for hashed @prisma/client and pg dirs, copies VPS .env into
# standalone, then pm2 restart.
#
# Middleware flow: tsc builds fine on VPS, so just push to GitHub, git pull,
# npm ci, prisma migrate deploy, build, pm2 restart.

[CmdletBinding()]
param(
    [ValidateSet('web', 'middleware', 'all')]
    [string]$App = 'all',
    [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'

$VPS_USER  = 'Administrator'
$VPS_HOST  = '207.244.240.42'
$VPS       = "$VPS_USER@$VPS_HOST"
$SSH_KEY   = Join-Path $env:USERPROFILE '.ssh\id_ed25519_sellerfolio_vps'
$REPO_ROOT = Split-Path -Parent $PSScriptRoot

# Hashed module names from the local Next 16 standalone build. Recomputed
# at deploy time from the local build output to handle hash changes.
$JUNCTION_PRISMA = 'client-2c3a283f134fdcb6'
$JUNCTION_PG     = 'pg-587764f78a6c7a9c'

function Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg)   { Write-Host "OK:  $msg" -ForegroundColor Green }
function Fail([string]$msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }

function Run-Native {
    param([scriptblock]$Block, [string]$Label)
    & $Block
    if ($LASTEXITCODE -ne 0) { Fail "$Label (exit=$LASTEXITCODE)" }
}

function Invoke-VpsScript {
    param([string]$ScriptBody, [string]$Label = 'remote script')
    $name = 'vps-deploy-' + [guid]::NewGuid().ToString('N').Substring(0,8) + '.ps1'
    $local = Join-Path $env:TEMP $name
    $remote = 'C:/Windows/Temp/' + $name
    Set-Content -Path $local -Value $ScriptBody -Encoding UTF8
    try {
        Run-Native { & scp -i $SSH_KEY -q $local "${VPS}:${remote}" } "scp $Label"
        $sshCmd = "powershell -ExecutionPolicy Bypass -File $remote; `$code=`$LASTEXITCODE; Remove-Item $remote -ErrorAction SilentlyContinue; exit `$code"
        Run-Native { & ssh -i $SSH_KEY $VPS $sshCmd } $Label
    } finally {
        Remove-Item $local -ErrorAction SilentlyContinue
    }
}

function Deploy-Web {
    Step 'web: building .next/standalone locally'
    Push-Location (Join-Path $REPO_ROOT 'web')
    try {
        $env:SKIP_ENV_VALIDATION = '1'
        if (Test-Path .next) { Remove-Item -Recurse -Force .next }
        Run-Native { & npm.cmd run build } 'web build'

        # Pick up the actual hashed module names from this build.
        $stdMods = Join-Path (Get-Location) '.next/standalone/.next/node_modules'
        if (Test-Path "$stdMods/@prisma") {
            $found = (Get-ChildItem "$stdMods/@prisma" | Select-Object -First 1).Name
            if ($found -and $found -ne $JUNCTION_PRISMA) {
                Write-Host "    note: @prisma hash changed: $found (was $JUNCTION_PRISMA)" -ForegroundColor Yellow
                $script:JUNCTION_PRISMA = $found
            }
        }
        $foundPg = (Get-ChildItem $stdMods -Filter 'pg-*' -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($foundPg -and $foundPg.Name -ne $JUNCTION_PG) {
            Write-Host "    note: pg hash changed: $($foundPg.Name) (was $JUNCTION_PG)" -ForegroundColor Yellow
            $script:JUNCTION_PG = $foundPg.Name
        }

        Step 'web: staging public + static into standalone'
        Copy-Item -Recurse -Force public .next/standalone/public
        Copy-Item -Recurse -Force .next/static .next/standalone/.next/static

        Step 'web: zipping standalone'
        $zipPath = Join-Path $env:TEMP 'web-standalone.zip'
        if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
        Push-Location .next
        try { Compress-Archive -Path standalone -DestinationPath $zipPath -CompressionLevel Optimal -Force }
        finally { Pop-Location }

        $sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
        Step "web: uploading zip ($sizeMb MB)"
        Run-Native { & scp -i $SSH_KEY -q $zipPath "${VPS}:C:/Windows/Temp/web-standalone.zip" } 'scp web zip'
    } finally { Pop-Location }

    Step 'web: extracting + recreating junctions + restart'
    # Single-quoted here-string keeps PowerShell variables literal; the two
    # placeholders are then substituted with the captured hash names.
    $remoteScript = @'
$ErrorActionPreference = 'Stop'
Set-Location C:\apps\luxesense-web
if (Test-Path .next\standalone) { Remove-Item -Recurse -Force .next\standalone }
if (-not (Test-Path .next)) { New-Item -ItemType Directory -Path .next | Out-Null }
Expand-Archive -Path C:\Windows\Temp\web-standalone.zip -DestinationPath .next -Force
Remove-Item C:\Windows\Temp\web-standalone.zip
$prismaJunction = '.next\standalone\.next\node_modules\@prisma\__PRISMA_HASH__'
$pgJunction     = '.next\standalone\.next\node_modules\__PG_HASH__'
New-Item -ItemType Junction -Path $prismaJunction -Value 'C:\apps\luxesense-web\node_modules\@prisma\client' -Force | Out-Null
New-Item -ItemType Junction -Path $pgJunction     -Value 'C:\apps\luxesense-web\node_modules\pg'             -Force | Out-Null
Copy-Item .env .next\standalone\.env -Force
pm2 restart luxesense-web --update-env
pm2 save | Out-Null
Write-Host "web restarted"
'@
    $remoteScript = $remoteScript.Replace('__PRISMA_HASH__', $JUNCTION_PRISMA).Replace('__PG_HASH__', $JUNCTION_PG)
    Invoke-VpsScript -ScriptBody $remoteScript -Label 'web extract+restart'
    Ok 'web deployed'
}

function Deploy-Middleware {
    if (-not $SkipPush) {
        Step 'middleware: git push (use -SkipPush to skip)'
        Push-Location (Join-Path $REPO_ROOT 'middleware')
        try {
            $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
            Run-Native { & git push origin $branch } "git push origin $branch"
            if ($branch -ne 'master') {
                Write-Host "    note: pushed '$branch'; VPS pulls 'master'. Ensure '$branch' is merged into master." -ForegroundColor Yellow
            }
        } finally { Pop-Location }
    }

    Step 'middleware: pull + build + restart on VPS'
    $remoteScript = @'
$ErrorActionPreference = 'Stop'
Set-Location C:\apps\luxesense-middleware
git pull origin master
npm ci --no-audit --no-fund --loglevel=error
npx --yes prisma generate
npx --yes prisma migrate deploy
npm run build
pm2 restart luxesense-middleware --update-env
pm2 save | Out-Null
Write-Host "middleware restarted"
'@
    Invoke-VpsScript -ScriptBody $remoteScript -Label 'middleware deploy'
    Ok 'middleware deployed'
}

function Health-Check {
    Step 'health check (external)'
    try {
        $r = Invoke-WebRequest -Uri "http://${VPS_HOST}:3000/" -MaximumRedirection 0 -ErrorAction Stop -TimeoutSec 10 -UseBasicParsing
        Write-Host "    web        HTTP $($r.StatusCode)" -ForegroundColor Green
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'no response' }
        $color = if ($code -is [int] -and $code -ge 200 -and $code -lt 400) { 'Green' } else { 'Red' }
        Write-Host "    web        HTTP $code" -ForegroundColor $color
    }
    try {
        $r = Invoke-WebRequest -Uri "http://${VPS_HOST}:3001/api/status" -ErrorAction Stop -TimeoutSec 10 -UseBasicParsing
        $j = $r.Content | ConvertFrom-Json
        Write-Host "    middleware HTTP $($r.StatusCode) - uptime $([int]$j.service.uptime)s, scheduler $($j.scheduler.running)" -ForegroundColor Green
    } catch {
        Write-Host "    middleware ERR: $($_.Exception.Message)" -ForegroundColor Red
    }
}

if ($App -in @('web', 'all'))        { Deploy-Web }
if ($App -in @('middleware', 'all')) { Deploy-Middleware }
Health-Check
