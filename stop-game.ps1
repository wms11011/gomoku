# 五子棋 · 一键停止（游戏服务器 + 隧道）
$ErrorActionPreference = 'SilentlyContinue'
$stopped = 0

# 停止隧道
Get-Process cloudflared | ForEach-Object { Stop-Process -Id $_.Id -Force; $stopped++ }

# 停止游戏服务器（仅匹配本项目 server\server.js 的 node 进程，避免误杀其他 Node 程序）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'server[/\\]server\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $stopped++ }

if ($stopped -gt 0) {
    Write-Host "已停止 $stopped 个进程（游戏服务器 / 隧道）"
} else {
    Write-Host '没有正在运行的游戏进程'
}
Start-Sleep -Seconds 2
