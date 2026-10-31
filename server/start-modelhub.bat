@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ------------------------------------------------------------------
rem 启动单卡模型前置服务（生图 / 图片编辑 / 语音设计 / 语音合成 / 文本生成）
rem
rem   start-modelhub.bat                  默认：GPU 2，端口 8790
rem   start-modelhub.bat --gpu 3          换一张卡（整份服务只用这一张）
rem   start-modelhub.bat --port 8791      换端口
rem
rem 和 start-backend.bat 一样，不能直接写 python：Windows 上 PATH 里的
rem python 可能是 Microsoft Store 的存根，一运行就弹商店。
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
"%PY%" -m modelhub serve %*

echo.
echo 服务已退出（本服务拉起的模型都已卸载）。
pause
