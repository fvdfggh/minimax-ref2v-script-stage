@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ------------------------------------------------------------------
rem 双击这个文件 = 前后台一起起。
rem
rem 它会先按需构建前端（dist 比源码旧才构建），再用同一个端口把
rem 页面和接口一起发出去：浏览器打开 http://127.0.0.1:8787 就是剧本台。
rem
rem 想换端口 / 让局域网能访问：
rem   启动剧本台.bat --port 9000
rem   启动剧本台.bat --host 0.0.0.0
rem （局域网访问前，先把初始密码改掉）
rem ------------------------------------------------------------------

where npm >nul 2>nul
if errorlevel 1 (
    echo.
    echo 没找到 Node.js。请先安装 Node.js 18 或更高版本：
    echo   https://nodejs.org/
    echo.
    pause
    exit /b 1
)

call npm start -- %*

echo.
echo 服务已退出。
pause
