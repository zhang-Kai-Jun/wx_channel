@echo off
REM ============================================================
REM  video_channel build script - can be double-clicked
REM
REM  Single source of truth for version: internal\version\version.go
REM     var Current = "1.2.0"
REM  This script auto-syncs it to:
REM     1. winres\winres.json   (Windows resource / right-click Properties - Details)
REM     2. Go ldflags           (runtime: video_channel.exe version)
REM  You only need to change the `var Current` line in version.go.
REM
REM  Usage:
REM    build.bat                          Default build (uses version.go Current)
REM    build.bat -v 1.3.0                 Override version (does NOT write back to version.go)
REM    build.bat --no-winres              Skip resource embedding (not recommended)
REM    build.bat --keep-open              Keep window open after build
REM ============================================================

setlocal EnableDelayedExpansion
chcp 65001 >nul

REM ---------- Default arguments ----------
set "VERSION="
set "SKIP_WINRES=0"
set "KEEP_OPEN=0"

REM ---------- Parse command line ----------
:parse_args
if "%~1"=="" goto parse_done
if /i "%~1"=="-v"          ( set "VERSION=%~2" & shift & shift & goto parse_args )
if /i "%~1"=="--version"   ( set "VERSION=%~2" & shift & shift & goto parse_args )
if /i "%~1"=="--no-winres" ( set "SKIP_WINRES=1" & shift & goto parse_args )
if /i "%~1"=="--keep-open" ( set "KEEP_OPEN=1" & shift & goto parse_args )
shift
goto parse_args

:parse_done

REM ---------- Change to script directory ----------
cd /d "%~dp0"

REM ---------- Version source of truth: internal\version\version.go `var Current` ----------
REM Priority: -v  >  version.go var Current  >  fallback 0.0.0
REM No longer reads from winres.json, avoiding duplication.

if "%VERSION%"=="" (
    if exist "internal\version\version.go" (
        REM Match the actual `var Current = "X.Y.Z"` declaration line (not comments).
        REM Token 4 is the quoted value e.g. `"1.2.0"`.
        for /f "tokens=4" %%A in ('findstr /R /C:"^var Current = " "internal\version\version.go"') do (
            if not defined VERSION set "VERSION=%%A"
        )
    )
)
if "%VERSION%"=="" set "VERSION=0.0.0"
REM Strip possible double quotes (e.g. var Current = "1.2.0")
set "VERSION=%VERSION:"=%"

cls
echo ========================================
echo   video_channel build script
echo ========================================
echo   Version: %VERSION%   (source: internal\version\version.go)
echo.
echo   [Sync targets]
echo     - winres\winres.json  (Windows resource: FileVersion / ProductVersion)
echo     - Go ldflags          (runtime: video_channel.exe version)
echo.

REM ---------- 1. Clean ----------
echo [1/6] Cleaning previous artifacts...
if exist wx_channel.exe          del /f /q wx_channel.exe
if exist video_channel.exe        del /f /q video_channel.exe
if exist rsrc_windows_amd64.syso del /f /q rsrc_windows_amd64.syso
if exist rsrc_windows_arm64.syso del /f /q rsrc_windows_arm64.syso
echo       OK
echo.

REM ---------- 2. Check go / go-winres ----------
echo [2/6] Checking Go toolchain...
where go >nul 2>nul
if errorlevel 1 (
    echo [ERROR] go not found in PATH. Please install Go and add it to PATH.
    goto fail
)

set "WINRES_PATH="
where go-winres >nul 2>nul
if not errorlevel 1 (
    set "WINRES_PATH=go-winres"
) else (
    if exist "%USERPROFILE%\go\bin\go-winres.exe" set "WINRES_PATH=%USERPROFILE%\go\bin\go-winres.exe"
)

if "%SKIP_WINRES%"=="1" goto after_winres_install
if defined WINRES_PATH goto have_winres

echo       go-winres not found, installing...
go install github.com/tc-hib/go-winres@latest
if errorlevel 1 (
    echo [ERROR] go-winres install failed. Check Go environment and network.
    goto fail
)
if exist "%USERPROFILE%\go\bin\go-winres.exe" set "WINRES_PATH=%USERPROFILE%\go\bin\go-winres.exe"
if not defined WINRES_PATH set "WINRES_PATH=go-winres"
echo       Installed.
goto after_winres_install

:have_winres
echo       Found go-winres ^(%WINRES_PATH%^).

:after_winres_install
echo.

REM ---------- 3. Sync winres.json version + generate resource ----------
REM   Temporarily rewrite the 4 version fields in winres.json to %VERSION%,
REM   then run go-winres make, then restore. Keeps git working tree clean.
if "%SKIP_WINRES%"=="1" (
    echo [3/6] Skipped ^(--no-winres^)
) else (
    echo [3/6] Syncing winres.json version to %VERSION% ...
    set "WINRES_BACKUP="
    set "WINRES_RESTORE=0"
    if exist "winres\winres.json" (
        REM Back up to a temp file; use a random suffix to avoid conflicts
        set "WINRES_BACKUP=winres\winres.json.buildbak.%RANDOM%"
        copy /y "winres\winres.json" "!WINRES_BACKUP!" >nul
        if errorlevel 1 (
            echo [ERROR] Failed to back up winres.json.
            goto fail
        )
        set "WINRES_RESTORE=1"
    )

    if "!WINRES_RESTORE!"=="1" (
        REM Use PowerShell to rewrite the 4 version fields in-place, other content unchanged.
        REM CRITICAL 1: Get-Content MUST use -Encoding UTF8. On Windows with non-ASCII
        REM system codepage (e.g. GBK), the default encoding decodes UTF-8 bytes like
        REM C2 A9 (the (c) symbol) as the wrong character (U+6F0F = "漏"), which then
        REM ends up in the EXE's PE resources.
        REM CRITICAL 2: must write JSON WITHOUT BOM - go-winres uses Go's strict json
        REM parser which rejects UTF-8 BOM. Set-Content -Encoding utf8 always writes BOM,
        REM so we use [System.IO.File]::WriteAllText with UTF8Encoding($false).
        powershell -NoProfile -Command ^
            "$v = '%VERSION%'; $p = 'winres\winres.json'; $e = New-Object System.Text.UTF8Encoding($false); $j = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json; $j.RT_MANIFEST.'#1'.'0409'.identity.version = $v; $j.RT_VERSION.'#1'.'0000'.fixed.file_version = $v; $j.RT_VERSION.'#1'.'0000'.fixed.product_version = $v; $j.RT_VERSION.'#1'.'0000'.info.'0409'.FileVersion = $v; $j.RT_VERSION.'#1'.'0000'.info.'0409'.ProductVersion = $v; [System.IO.File]::WriteAllText($p, ($j | ConvertTo-Json -Depth 12), $e)" >nul 2>&1
        if errorlevel 1 (
            echo [ERROR] Failed to sync winres.json.
            if "!WINRES_RESTORE!"=="1" copy /y "!WINRES_BACKUP!" "winres\winres.json" >nul
            goto fail
        )
        echo       OK ^(temporarily modified, will be restored after build^)
    ) else (
        echo       [WARN] winres.json not found, skipping version sync.
    )

    echo [3/6] Generating Windows resource file ^(rsrc_windows_amd64.syso^)...
    "%WINRES_PATH%" make
    if errorlevel 1 (
        echo [ERROR] Resource generation failed.
        if "!WINRES_RESTORE!"=="1" copy /y "!WINRES_BACKUP!" "winres\winres.json" >nul
        goto fail
    )
    echo       OK

    REM Restore winres.json, keep git working tree clean
    if "!WINRES_RESTORE!"=="1" (
        copy /y "!WINRES_BACKUP!" "winres\winres.json" >nul
        del /f /q "!WINRES_BACKUP!" >nul 2>&1
        echo       winres.json restored ^(git working tree clean^)
    )
)
echo.

REM ---------- 4. Compute date / commit ----------
echo [4/6] Computing build date and git commit ...

set "BUILD_DATE="
for /f "tokens=*" %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd" 2^>nul') do (
    if not defined BUILD_DATE set "BUILD_DATE=%%D"
)
if "%BUILD_DATE%"=="" set "BUILD_DATE=unknown"

set "GIT_COMMIT="
for /f "tokens=*" %%I in ('git rev-parse --short HEAD 2^>nul') do (
    if not defined GIT_COMMIT set "GIT_COMMIT=%%I"
)
if "%GIT_COMMIT%"=="" set "GIT_COMMIT=unknown"

echo       VERSION=%VERSION%  DATE=%BUILD_DATE%  COMMIT=%GIT_COMMIT%
echo.

REM ---------- 5. Compile ----------
echo [5/6] Compiling video_channel.exe ...
REM Project depends on SunnyNet (C library), CGO is required.
REM ldflags combined into a single line to avoid host (MSYS/PowerShell) ^ line-continuation quirks.
set CGO_ENABLED=1
go build -trimpath -ldflags "-s -w -H windowsgui -extldflags=-Wl,--allow-multiple-definition -X wx_channel/internal/version.Current=%VERSION% -X wx_channel/internal/version.BuildDate=%BUILD_DATE% -X wx_channel/internal/version.BuildCommit=%GIT_COMMIT%" -o video_channel.exe
if errorlevel 1 (
    echo [ERROR] Compilation failed.
    goto fail
)
echo       OK
echo.

REM ---------- 6. Verify ----------
echo [6/6] Verifying artifact...
if not exist video_channel.exe (
    echo [ERROR] video_channel.exe not generated.
    goto fail
)
for %%I in (video_channel.exe) do echo       File size: %%~zI bytes
echo.
echo       CLI version info:
echo.
.\video_channel.exe version
echo.

REM Verify Windows resource is embedded
if "%SKIP_WINRES%"=="1" goto skip_res_check

echo       Windows resource info ^(Properties ^> Details^):
echo.
for /f "tokens=*" %%V in ('powershell -NoProfile -Command "(Get-Item 'video_channel.exe').VersionInfo.FileVersion"     2^>nul') do set "FV=%%V"
for /f "tokens=*" %%V in ('powershell -NoProfile -Command "(Get-Item 'video_channel.exe').VersionInfo.ProductVersion" 2^>nul') do set "PV=%%V"
for /f "tokens=*" %%V in ('powershell -NoProfile -Command "(Get-Item 'video_channel.exe').VersionInfo.FileDescription" 2^>nul') do set "FD=%%V"
for /f "tokens=*" %%V in ('powershell -NoProfile -Command "(Get-Item 'video_channel.exe').VersionInfo.CompanyName"     2^>nul') do set "CN=%%V"
for /f "tokens=*" %%V in ('powershell -NoProfile -Command "(Get-Item 'video_channel.exe').VersionInfo.InternalName"   2^>nul') do set "IN=%%V"
for /f "tokens=*" %%V in ('powershell -NoProfile -Command "(Get-Item 'video_channel.exe').VersionInfo.OriginalFilename" 2^>nul') do set "OF=%%V"

echo       FileVersion     : !FV!
echo       ProductVersion  : !PV!
echo       FileDescription : !FD!
echo       CompanyName     : !CN!
echo       InternalName    : !IN!
echo       OriginalFilename: !OF!
echo.

REM Consistency self-check: ldflags-injected VERSION should equal FileVersion
if /i not "!FV!"=="%VERSION%" (
    echo       [WARN] FileVersion ^(=!FV!^) does not match version.go Current ^(=%VERSION%^).
    echo       Check winres.json sync logic.
) else (
    echo       [OK] Windows resource version matches version.go.
)

:skip_res_check
echo.
echo ========================================
echo   Build complete: video_channel.exe
echo ========================================

if "%KEEP_OPEN%"=="1" (
    echo.
    echo ^(Window will stay open, press any key to close...^)
    pause ^>nul
)

endlocal & exit /b 0

:fail
REM On failure, also try to restore winres.json to avoid polluting git tree
if defined WINRES_BACKUP (
    if exist "!WINRES_BACKUP!" (
        copy /y "!WINRES_BACKUP!" "winres\winres.json" >nul
        del /f /q "!WINRES_BACKUP!" >nul 2>&1
        echo ^(winres.json restored^)
    )
)
echo.
echo ========================================
echo   Build failed
echo ========================================
pause
endlocal & exit /b 1
