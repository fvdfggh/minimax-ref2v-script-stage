@echo off
chcp 65001 >nul
cd /d "%~dp0\.."

rem ------------------------------------------------------------------
rem 启动剧本台后端。
rem
rem 不能直接写 `python`：Windows 上 PATH 里的 python 往往是 Microsoft Store
rem 的存根，一运行就弹商店而不是真的执行。所以这里按常见安装位置挨个找。
rem 都不在的话，把下面 set PY= 那行改成你的 python.exe 路径即可。
rem ------------------------------------------------------------------

set "PY="

for %%P in (
    "%USERPROFILE%\miniconda3\python.exe"
    "%USERPROFILE%\anaconda3\python.exe"
    "%USERPROFILE%\AppData\Local\miniconda3\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "C:\ProgramData\miniconda3\python.exe"
    "C:\ProgramData\anaconda3\python.exe"
) do (
    if exist %%P set "PY=%%~P"
)

if not defined PY (
    where py >nul 2>nul
    if not errorlevel 1 set "PY=py"
)

if not defined PY (
    echo 没找到 Python。
    echo 请安装 Miniconda（https://docs.conda.io/en/latest/miniconda.html）
    echo 或者把本文件里的  set "PY=..."  改成你的 python.exe 完整路径。
    echo.
    pause
    exit /b 1
)

echo 使用解释器: %PY%
echo.
"%PY%" server\app.py --port 8787

echo.
echo 后端已退出。
pause
