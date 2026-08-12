# 五子棋 · 一键启动（游戏服务器 + Cloudflare 公网隧道）
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

Write-Host ''
Write-Host '============================================'
Write-Host '   五子棋 · 一键启动（服务器 + 公网隧道）'
Write-Host '============================================'
Write-Host ''

# ---- 0. 环境检查 ----
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '未找到 Node.js，请先安装: https://nodejs.org/'
    Read-Host '按回车退出'
    exit 1
}
if (-not (Test-Path 'tools\cloudflared.exe')) {
    Write-Host '未找到 tools\cloudflared.exe（隧道工具），请联系部署者重新下载'
    Read-Host '按回车退出'
    exit 1
}

# ---- 1. 依赖 ----
if (-not (Test-Path 'node_modules\ws\package.json')) {
    Write-Host '[1/4] 首次运行，正在安装依赖…'
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Write-Host '依赖安装失败，请检查网络'; Read-Host '按回车退出'; exit 1 }
} else {
    Write-Host '[1/4] 依赖已就绪'
}

# ---- 2. 游戏服务器 ----
function Test-GameServer {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/' -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

if (Test-GameServer) {
    Write-Host '[2/4] 游戏服务器已在运行，跳过'
} else {
    Write-Host '[2/4] 正在启动游戏服务器…'
    Start-Process -FilePath 'node' -ArgumentList 'server\server.js' -WorkingDirectory $PSScriptRoot -WindowStyle Minimized
    $ready = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        if (Test-GameServer) { $ready = $true; break }
    }
    if (-not $ready) { Write-Host '服务器启动失败（3000 端口可能被占用）'; Read-Host '按回车退出'; exit 1 }
    Write-Host '      服务器已启动: http://localhost:3000'
}

# ---- 3. 公网隧道 ----
$log = Join-Path $PSScriptRoot 'tunnel.log'
$pattern = 'https://[a-z0-9-]+\.trycloudflare\.com'
function Get-TunnelUrl {
    if (-not (Test-Path $log)) { return $null }
    $m = Select-String -Path $log -Pattern $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { return $m.Matches[0].Value }
    return $null
}

$cf = Get-Process cloudflared -ErrorAction SilentlyContinue
$url = $null
if ($cf) { $url = Get-TunnelUrl }
if ($cf -and $url) {
    Write-Host "[3/4] 隧道已在运行: $url"
} else {
    if ($cf) {
        Write-Host '[3/4] 正在重启隧道以获取地址…'
        $cf | Stop-Process -Force
        Start-Sleep -Seconds 1
    } else {
        Write-Host '[3/4] 正在启动 Cloudflare 隧道…'
    }
    Remove-Item $log -ErrorAction SilentlyContinue
    Start-Process -FilePath 'tools\cloudflared.exe' `
        -ArgumentList 'tunnel','--url','http://localhost:3000','--no-autoupdate' `
        -WorkingDirectory $PSScriptRoot -WindowStyle Minimized `
        -RedirectStandardError $log
    for ($i = 0; $i -lt 60 -and -not $url; $i++) {
        Start-Sleep -Seconds 1
        $url = Get-TunnelUrl
    }
    if (-not $url) { Write-Host '获取公网地址失败，请查看 tunnel.log 排查网络'; Read-Host '按回车退出'; exit 1 }
}

# ---- 4. 完成 ----
try { Set-Clipboard $url } catch {}
Write-Host ''
Write-Host '============================================'
Write-Host '  启动完成！'
Write-Host '  本机地址:  http://localhost:3000'
Write-Host "  公网地址:  $url"
Write-Host '  （公网地址已复制到剪贴板，直接发给好友）'
Write-Host '============================================'
Write-Host ''
Write-Host '说明：服务器和隧道在后台最小化窗口中运行；'
Write-Host '      双击「停止游戏.bat」可全部停止。'
Start-Process 'http://localhost:3000'
Read-Host '按回车关闭本窗口'
