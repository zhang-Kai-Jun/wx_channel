param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../video_channel.exe'),
    [string]$Version,
    [string]$Uploader = 'tosutil'
)

$ErrorActionPreference = 'Stop'
$bucket = 'tos://crmspark/plus/video-channel'
$publicBase = 'https://crmspark.tos-cn-shanghai.volces.com/plus/video-channel'
if (-not $Version) {
    $versionSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../internal/version/version.go') -Raw -Encoding UTF8
    if ($versionSource -notmatch '(?m)^var Current = "([^"]+)"') { throw 'Missing project version' }
    $Version = $Matches[1]
}
if ($Version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Invalid release version' }
foreach ($part in $Version.Split('.')) {
    if ([int]$part -gt 65535) { throw 'Windows version components must not exceed 65535' }
}
$ExecutablePath = (Resolve-Path -LiteralPath $ExecutablePath).Path
$manifestPath = Join-Path ([IO.Path]::GetTempPath()) ('video-channel-' + [Guid]::NewGuid().ToString('N') + '.json')
$stream = $null
try {
    # Keep a read-only handle open so the artifact cannot change during publication.
    $stream = [IO.File]::Open($ExecutablePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($stream.Length -lt 64 -or $stream.Length -gt 128MB) { throw "Invalid executable size: $($stream.Length)" }
    $reader = [IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Not a Windows executable' }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadUInt32()
    if ([long]$peOffset + 26 -gt $stream.Length) { throw 'Invalid PE header offset' }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Expected Windows x64 executable' }
    $stream.Position = $peOffset + 22
    if (($reader.ReadUInt16() -band 2) -eq 0 -or $reader.ReadUInt16() -ne 0x020b) { throw 'Invalid x64 executable header' }
    $stream.Position = 0
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
    $manifest = [ordered]@{
        version = $Version
        platform = 'win-x64'
        url = "$publicBase/$hash/video_channel.exe"
        sha256 = $hash
        bytes = $stream.Length
    }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    & $Uploader cp $ExecutablePath "$bucket/$hash/video_channel.exe" -vchecksum
    if ($LASTEXITCODE -ne 0) { throw 'Executable upload failed; latest manifest was not changed' }
    # Publish the manifest last; build.bat retains ZIP publication for older hosts.
    & $Uploader cp $manifestPath "$bucket/latest.json" -vchecksum -contentType=application/json '-cacheControl=no-cache,no-store,must-revalidate'
    if ($LASTEXITCODE -ne 0) { throw 'Latest manifest upload failed' }
    Write-Host "Published video_channel $Version ($hash)"
} finally {
    if ($stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force }
}
