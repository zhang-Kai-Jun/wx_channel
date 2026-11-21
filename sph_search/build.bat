@echo off
setlocal EnableDelayedExpansion

cd /d "%~dp0"

set "DO_UPLOAD=0"
set "CSC_EXE=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
set "WPF_DIR=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF"

:parse_args
if "%~1"=="" goto parse_done
if /i "%~1"=="--upload" (
    set "DO_UPLOAD=1"
    shift
    goto parse_args
)
if /i "%~1"=="-u" (
    set "DO_UPLOAD=1"
    shift
    goto parse_args
)
shift
goto parse_args

:parse_done
set "VERSION=1.0.0"
if exist "version.txt" (
    for /f "usebackq delims=" %%v in ("version.txt") do set "VERSION=%%v"
)

echo ========================================
echo   sph_search build script
echo ========================================
echo   Version: %VERSION%
if "%DO_UPLOAD%"=="1" (
    echo   Action:  Compile + Upload to TOS
) else (
    echo   Action:  Local Compile only
)
echo.

if not exist "%CSC_EXE%" (
    echo [ERROR] CSC compiler not found: %CSC_EXE%
    goto fail
)

echo [1/3] Compiling SphSearch.cs ...
"%CSC_EXE%" /nologo /optimize+ /platform:x64 /target:exe /r:"%WPF_DIR%\UIAutomationClient.dll" /r:"%WPF_DIR%\UIAutomationTypes.dll" /r:"%WPF_DIR%\WindowsBase.dll" /r:"Accessibility.dll" /out:"%~dp0sph_search.exe" "%~dp0SphSearch.cs"
if errorlevel 1 (
    echo [ERROR] Compilation failed.
    goto fail
)

echo [2/3] Verifying artifact...
if not exist "%~dp0sph_search.exe" (
    echo [ERROR] sph_search.exe not found.
    goto fail
)

for %%F in ("%~dp0sph_search.exe") do (
    echo       Size: %%~zF bytes
)
echo       Artifact verified.
echo.

if "%DO_UPLOAD%"=="1" (
    echo [3/3] Uploading to TOS bucket...
    where.exe tosutil >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] tosutil.exe not found in PATH.
        goto fail
    )
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" -ExecutablePath "%~dp0sph_search.exe" -Version "%VERSION%"
    if errorlevel 1 (
        echo [ERROR] Upload failed.
        goto fail
    )
) else (
    echo [NOTE] Local build completed. To upload to TOS, run: build.bat --upload
)

echo.
echo ========================================
echo   Build Successful!
echo ========================================
endlocal & exit /b 0

:fail
echo.
echo ========================================
echo   Build FAILED!
echo ========================================
endlocal & exit /b 1
