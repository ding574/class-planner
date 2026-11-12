@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 参数 lan = 局域网模式（同一 Wi-Fi 的同学可以访问）
if /i "%~1"=="lan" set "HOST=0.0.0.0"

rem 优先用 PATH 里的 node；找不到就用 DSH 自带的 node
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%NODE%" if not "%NODE%"=="node" (
  echo [错误] 找不到 Node.js，请先安装 Node 18 或更高版本：https://nodejs.org
  pause
  exit /b 1
)

rem 检查版本，低于 18 不支持内置 fetch
"%NODE%" -e "process.exit(parseInt(process.versions.node)>=18?0:1)" >nul 2>nul
if errorlevel 1 (
  echo [错误] Node 版本太低，需要 18 或更高版本。
  pause
  exit /b 1
)

if "%DEEPSEEK_API_KEY%"=="" (
  echo.
  echo  [演示模式] 没有检测到 DEEPSEEK_API_KEY，将返回示例方案。
  echo             真实生成：先执行  set DEEPSEEK_API_KEY=你的密钥  再运行本文件。
  echo.
)

if /i "%~1"=="lan" (
  echo  [局域网模式] 启动后会打印局域网地址，同一 Wi-Fi 的同学用那个地址访问。
  echo  首次启动如果弹出 Windows 防火墙提示，请勾选"专用网络"并允许访问。
  echo.
)

rem 2 秒后自动打开浏览器
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787'"

"%NODE%" server.mjs

echo.
echo 服务已停止。
pause
