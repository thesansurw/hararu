@echo off
setlocal
set "VER=18.20.4"
set "ZIP=%TEMP%\node-%VER%.zip"
set "DIR=%TEMP%\node-%VER%"
set "URL=https://nodejs.org/dist/v%VER%/node-v%VER%-win-x64.zip"
set "APP=%~dp0"

if exist "%APP%node.exe" (
  echo 已存在 node.exe，先删除旧文件重新下载。
  del /q "%APP%node.exe" >nul 2>&1
)

echo 正在下载 Node.js v%VER% 便携版 ...
curl.exe -L -o "%ZIP%" "%URL%"
if errorlevel 1 goto :fail

echo 正在解压 ...
tar -xf "%ZIP%" -C "%TEMP%"
if errorlevel 1 goto :fail

echo 正在复制 node.exe 到程序目录 ...
copy /y "%DIR%\node.exe" "%APP%node.exe" >nul
if errorlevel 1 goto :fail

echo.
echo 验证版本：
"%APP%node.exe" -v
if errorlevel 1 goto :fail

echo.
echo ============================================
echo 完成！node.exe 已放入程序目录。
echo 现在整个文件夹是自包含的，可直接整体拷贝到其它电脑使用。
echo ============================================
goto :end

:fail
echo.
echo [错误] 下载或解压失败，请检查网络后重新运行本脚本。
echo （目标电脑需能访问 nodejs.org）

:end
del "%ZIP%" >nul 2>&1
endlocal
pause
