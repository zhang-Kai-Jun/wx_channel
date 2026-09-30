@echo off
REM ============================================================
REM  video_channel build script - can be double-clicked
REM
REM  Single source of truth for version: internal\version\version.go
REM  This script auto-syncs it to:
REM     1. Windows resources   (right-click Properties - Details)
REM     2. Go ldflags           (runtime: video_channel.exe version)
REM  You only need to change the `var Current` line in version.go.
REM
REM  Usage:
REM    build.bat                          Plain build & upload to remote bucket
REM    build.bat --no-upload              Build only without uploading
REM    build.bat --obfuscate              Obfuscated build (uses Garble)
REM    build.bat --plain                  Plain build
REM    build.bat --upload                 Build and upload zip to remote bucket
REM ============================================================

setlocal EnableDelayedExpansion
chcp 65001 >nul

REM ---------- Default arguments ----------
set "VERSION="
set "DO_UPLOAD=1"
set "OBFUSCATE=0"
set "GARBLE_VERSION=v0.14.2"
set "GARBLE_EXE="
set "RESOURCE_JSON=%~dp0winres\winres.build.json"

REM ---------- Remote upload config ----------
set "UPLOAD_BUCKET=tos://crmspark/plus/video_channel.zip"

REM ---------- Parse command line ----------
:parse_args
if "%~1"=="" goto parse_done
if /i "%~1"=="--upload"    ( set "DO_UPLOAD=1"  & shift & goto parse_args )
if /i "%~1"=="--no-upload" ( set "DO_UPLOAD=0"  & shift & goto parse_args )
if /i "%~1"=="--obfuscate" ( set "OBFUSCATE=1"  & shift & goto parse_args )
if /i "%~1"=="--garble"    ( set "OBFUSCATE=1"  & shift & goto parse_args )
if /i "%~1"=="--plain"     ( set "OBFUSCATE=0"  & shift & goto parse_args )
echo [ERROR] Unsupported argument. Set the version in internal\version\version.go.
goto fail

:parse_done

REM ---------- Change to script directory ----------
cd /d "%~dp0"

REM Validate version and prepare UTF-8 resources before deleting old artifacts.
for /f "delims=" %%V in ('powershell -NoProfile -ExecutionPolicy Bypass -File "winres\build-resources.ps1" -Mode Prepare') do set "VERSION=%%V"
if not defined VERSION (
    echo [ERROR] Could not prepare Windows version resources.
    goto fail
)

cls
echo ========================================
echo   video_channel build script
echo ========================================
echo   Version: %VERSION%   (source: internal\version\version.go)
if "%OBFUSCATE%"=="1" (
    echo   Protection: Garble %GARBLE_VERSION%, project packages and literals
) else (
    echo   Protection: OFF ^(plain build^)
)
echo.
echo   [Sync targets]
echo     - Windows resource    (description, product name, file/product version)
echo     - Go ldflags          (runtime: video_channel.exe version)
if "%DO_UPLOAD%"=="1" (
echo     - Upload to bucket    (!UPLOAD_BUCKET!)
)
echo.

REM ---------- 1. Check build tools before removing existing artifacts ----------
echo [1/6] Checking Go toolchain...
where go >nul 2>nul
if errorlevel 1 (
    echo [ERROR] go not found in PATH. Please install Go and add it to PATH.
    goto fail
)
REM Use the project's toolchain even when the machine sets GOTOOLCHAIN=local.
set "GOTOOLCHAIN="
for /f "tokens=2" %%G in ('findstr /B /C:"toolchain " go.mod') do set "GOTOOLCHAIN=%%G"
if not defined GOTOOLCHAIN (
    echo [ERROR] go.mod must declare the project toolchain.
    goto fail
)
go version
if errorlevel 1 goto fail
set "CGO_ENABLED=1"
set "TARGET_OS="
set "TARGET_ARCH="
for /f "delims=" %%A in ('go env GOOS') do set "TARGET_OS=%%A"
for /f "delims=" %%A in ('go env GOARCH') do set "TARGET_ARCH=%%A"
if not "%TARGET_OS%"=="windows" (
    echo [ERROR] This script requires GOOS=windows.
    goto fail
)
if not defined TARGET_ARCH (
    echo [ERROR] Could not detect the Go target architecture.
    goto fail
)
set "RESOURCE_OBJECT=rsrc_windows_%TARGET_ARCH%.syso"

if "%OBFUSCATE%"=="0" goto after_garble_install
REM Garble v0.14.2 supports Go 1.24; review this pair when upgrading go.mod.
if not "%GOTOOLCHAIN:~0,7%"=="go1.24." (
    echo [ERROR] Revalidate the pinned Garble version before changing the Go toolchain.
    goto fail
)
where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Garble requires Git to patch the Go linker.
    goto fail
)
set "GARBLE_TOOL_DIR=%LOCALAPPDATA%\wx_channel\build-tools\garble-%GARBLE_VERSION%-%GOTOOLCHAIN%"
set "GARBLE_EXE=%GARBLE_TOOL_DIR%\garble.exe"
if exist "%GARBLE_EXE%" goto verify_garble
echo       Installing Garble %GARBLE_VERSION% with %GOTOOLCHAIN%...
set "PREVIOUS_GOBIN=%GOBIN%"
set "GOBIN=%GARBLE_TOOL_DIR%"
go install mvdan.cc/garble@%GARBLE_VERSION%
set "INSTALL_RESULT=%ERRORLEVEL%"
set "GOBIN=%PREVIOUS_GOBIN%"
if not "%INSTALL_RESULT%"=="0" (
    echo [ERROR] Garble installation failed. No plain build will be substituted.
    goto fail
)
:verify_garble
"%GARBLE_EXE%" version
if errorlevel 1 goto fail
REM Prefix matching includes wx_channel and all its subpackages, not dependencies.
set "GOGARBLE=wx_channel"
REM Prevent inherited experimental control-flow settings from changing this profile.
set "GARBLE_EXPERIMENTAL_CONTROLFLOW="
:after_garble_install

set "WINRES_PATH="
where go-winres >nul 2>nul
if not errorlevel 1 (
    set "WINRES_PATH=go-winres"
) else (
    if exist "%USERPROFILE%\go\bin\go-winres.exe" set "WINRES_PATH=%USERPROFILE%\go\bin\go-winres.exe"
)

if defined WINRES_PATH goto after_winres_install

echo       go-winres not found, installing...
go install github.com/tc-hib/go-winres@v0.3.3
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

REM ---------- 2. Clean ----------
echo [2/6] Cleaning previous artifacts...
if exist wx_channel.exe          del /f /q wx_channel.exe
if exist video_channel.exe        del /f /q video_channel.exe
if exist rsrc_windows_amd64.syso del /f /q rsrc_windows_amd64.syso
if exist rsrc_windows_arm64.syso del /f /q rsrc_windows_arm64.syso
if exist rsrc_windows_386.syso del /f /q rsrc_windows_386.syso
if exist video_channel.zip        del /f /q video_channel.zip
echo       OK
echo.

REM ---------- 3. Generate resources for the same architecture as go build ----------
echo [3/6] Generating Windows resources ^(%RESOURCE_OBJECT%^)...
"%WINRES_PATH%" make --in "%RESOURCE_JSON%" --arch "%TARGET_ARCH%" --out rsrc
if errorlevel 1 (
    echo [ERROR] Resource generation failed.
    goto fail
)
if not exist "%RESOURCE_OBJECT%" (
    echo [ERROR] The expected Windows resource object is missing.
    goto fail
)
set "RESOURCE_INCLUDED="
for /f "delims=" %%R in ('go list -f "{{.SysoFiles}}" .') do set "RESOURCE_INCLUDED=%%R"
echo !RESOURCE_INCLUDED! | findstr /L /C:"%RESOURCE_OBJECT%" >nul
if errorlevel 1 (
    echo [ERROR] Go did not include the generated Windows resource object.
    goto fail
)
echo       OK
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
set "BUILD_LDFLAGS=-s -w -extldflags=-Wl,--allow-multiple-definition -X wx_channel/internal/version.Current=%VERSION% -X wx_channel/internal/version.BuildDate=%BUILD_DATE% -X wx_channel/internal/version.BuildCommit=%GIT_COMMIT%"
if "%OBFUSCATE%"=="1" (
    "%GARBLE_EXE%" -literals build -trimpath -ldflags "%BUILD_LDFLAGS%" -o video_channel.exe .
) else (
    go build -trimpath -ldflags "%BUILD_LDFLAGS%" -o video_channel.exe .
)
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
for /f "delims=" %%V in ('powershell -NoProfile -Command "Start-Process -FilePath 'video_channel.exe' -ArgumentList 'version' -Wait -NoNewWindow -RedirectStandardOutput '%TEMP%\vc_version_out.txt' -ErrorAction SilentlyContinue; Get-Content '%TEMP%\vc_version_out.txt' -ErrorAction SilentlyContinue"') do echo %%V
echo.
echo.

REM Verify Windows resource is embedded
echo       Windows resource info ^(Properties ^> Details^):
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "winres\build-resources.ps1" -Mode Verify
if errorlevel 1 (
    echo [ERROR] Windows executable metadata verification failed.
    goto fail
)

echo.

REM ---------- 7. Upload ----------
if "%DO_UPLOAD%"=="1" (
    echo [7/7] Packaging and uploading to bucket...

    REM Retry zip creation up to 5 times with wait between attempts.
    set "ZIP_RETRY=0"
    :zip_retry
    powershell -NoProfile -Command "try { Compress-Archive -Force -Path 'video_channel.exe' -DestinationPath 'video_channel.zip' -ErrorAction Stop; exit 0 } catch { Write-Host '[retry]'; exit 1 }"
    if errorlevel 1 (
        set /a ZIP_RETRY+=1
        if !ZIP_RETRY! lss 5 (
            echo       Zip attempt !ZIP_RETRY! failed ^(file in use^), waiting...
            powershell -NoProfile -Command "Start-Sleep -Seconds 3"
            goto zip_retry
        )
        echo [ERROR] Failed to create zip after 5 attempts.
        goto fail
    )
    if not exist video_channel.zip (
        set /a ZIP_RETRY+=1
        if !ZIP_RETRY! lss 5 (
            echo       Zip attempt !ZIP_RETRY! failed ^(not found^), waiting...
            powershell -NoProfile -Command "Start-Sleep -Seconds 3"
            goto zip_retry
        )
        echo [ERROR] Zip file not found after 5 attempts.
        goto fail
    )
    echo       Zip created: video_channel.zip
    for %%I in (video_channel.zip) do echo       Size: %%~zI bytes
    echo.

    if exist video_channel.zip (
        echo       Uploading to !UPLOAD_BUCKET!...
        tosutil cp video_channel.zip "!UPLOAD_BUCKET!"
        if errorlevel 1 (
            echo [ERROR] Upload failed.
            goto fail
        )
        echo       Uploaded: !UPLOAD_BUCKET!
    ) else (
        echo [ERROR] video_channel.zip not found, skipping upload.
    )
    echo       OK
    echo.
)

echo ========================================
echo   Build complete: video_channel.exe
echo ========================================

if exist "%RESOURCE_JSON%" del /f /q "%RESOURCE_JSON%"
endlocal & exit /b 0

:fail
if exist "%RESOURCE_JSON%" del /f /q "%RESOURCE_JSON%"
echo.
echo ========================================
echo   Build failed
echo ========================================
pause
endlocal & exit /b 1
