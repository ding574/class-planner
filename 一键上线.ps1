# 一键上线：启动本地服务 + 开一个临时公网链接
#
# 用法：双击「一键上线.bat」，或在本目录执行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\一键上线.ps1
#
# 说明：
#   - 首次运行会自动下载 cloudflared（约 35MB）
#   - 会提示你粘贴 DeepSeek API Key（只存在这台电脑的内存里）
#   - 生成的链接任何网络都能打开，手机也行；关掉窗口链接就失效
#   - 电脑不能关机/睡眠，否则链接失效

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host ''
Write-Host '  班级事务工作台 · 一键上线' -ForegroundColor Cyan
Write-Host '  --------------------------------' -ForegroundColor DarkGray
Write-Host ''

# 1. 找 node
$node = 'node'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $fallback = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $fallback) { $node = $fallback }
  else {
    Write-Host '  找不到 Node.js，请先安装 Node 18 或更高版本：https://nodejs.org' -ForegroundColor Red
    Read-Host '  按回车退出'
    exit 1
  }
}

# 2. 问 key
if (-not $env:DEEPSEEK_API_KEY) {
  Write-Host '  请粘贴 DeepSeek API Key（sk- 开头），回车确认：' -ForegroundColor Yellow
  $key = Read-Host '  Key'
  if ($key -and $key.Trim()) { $env:DEEPSEEK_API_KEY = $key.Trim() }
  else {
    Write-Host '  没有填 key，将以演示模式运行（返回示例，不是真实生成）。' -ForegroundColor Yellow
  }
}

# 3. 起本地服务（如果已经在跑就复用）
$healthy = $false
try {
  $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' -UseBasicParsing -TimeoutSec 2
  $healthy = $true
} catch { }

$server = $null
if (-not $healthy) {
  $server = Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' -UseBasicParsing -TimeoutSec 2
      $healthy = $true
      break
    } catch { }
  }
}
if (-not $healthy) {
  Write-Host '  本地服务没起来，请先双击「启动.bat」看看报什么错。' -ForegroundColor Red
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Read-Host '  按回车退出'
  exit 1
}
Write-Host '  本地服务已就绪：http://127.0.0.1:8787' -ForegroundColor Green

# 4. 准备 cloudflared
$cf = Join-Path $PSScriptRoot 'cloudflared.exe'
if (-not (Test-Path $cf)) {
  Write-Host '  首次使用，正在下载 cloudflared（约 35MB，需要几十秒）...' -ForegroundColor Yellow
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf -TimeoutSec 300
  } catch {
    Write-Host '  下载失败，请检查网络。也可以自己装：winget install Cloudflare.cloudflared' -ForegroundColor Red
    if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    Read-Host '  按回车退出'
    exit 1
  }
  Write-Host '  下载完成。' -ForegroundColor Green
}

# 5. 开隧道并抓地址
$log = Join-Path $PSScriptRoot 'tunnel.log'
Remove-Item $log -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $cf `
  -ArgumentList 'tunnel','--url','http://127.0.0.1:8787','--no-autoupdate' `
  -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden `
  -RedirectStandardError $log -RedirectStandardOutput "$log.out"

Write-Host '  正在建立公网链接...' -ForegroundColor Yellow
$url = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $text = ''
  foreach ($f in @($log, "$log.out")) {
    if (Test-Path $f) { $text += (Get-Content -Path $f -Raw -ErrorAction SilentlyContinue) }
  }
  if ($text -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
    $url = $Matches[0]
    break
  }
}

if (-not $url) {
  Write-Host '  没拿到公网地址，详见 tunnel.log。' -ForegroundColor Red
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Read-Host '  按回车退出'
  exit 1
}

Write-Host ''
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host '  公网地址（发给老师/同学就能用）：' -ForegroundColor Cyan
Write-Host ''
Write-Host "    $url" -ForegroundColor Green
Write-Host ''
Write-Host '  已复制到剪贴板。手机、任何网络都能打开。' -ForegroundColor Cyan
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host ''
try { Set-Clipboard -Value $url } catch { }

Write-Host '  注意：' -ForegroundColor Yellow
Write-Host '  1. 这个窗口别关，电脑别睡眠，链接才能一直用；' -ForegroundColor Yellow
Write-Host '  2. 关链接：按 Ctrl+C，或直接关窗口；' -ForegroundColor Yellow
Write-Host '  3. 每次运行地址会变，重新发一次即可；' -ForegroundColor Yellow
Write-Host '  4. 长期稳定用请走「部署-公网.md」里的 Render 方案。' -ForegroundColor Yellow
Write-Host ''

try {
  while ($true) { Start-Sleep -Seconds 5 }
} finally {
  if ($tunnel) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}
