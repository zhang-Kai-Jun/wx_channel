param(
    [ValidateSet('Prepare', 'Verify')]
    [string]$Mode = 'Prepare',
    [string]$VersionFile = (Join-Path $PSScriptRoot '..\internal\version\version.go'),
    [string]$OutputPath = (Join-Path $PSScriptRoot 'winres.build.json'),
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '..\video_channel.exe')
)

$ErrorActionPreference = 'Stop'
try {
    $source = Get-Content -LiteralPath $VersionFile -Raw -Encoding UTF8
    $matches = [regex]::Matches($source, '(?m)^\s*var\s+Current\s*=\s*"([^"]+)"')
    if ($matches.Count -ne 1) {
        throw 'Expected exactly one var Current declaration in version.go.'
    }
    $version = $matches[0].Groups[1].Value
    if ($version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
        throw 'Current must contain three or four numeric version components.'
    }
    $parts = @($version.Split('.') | ForEach-Object {
        if ([int]$_ -gt 65535) { throw 'Windows version components must not exceed 65535.' }
        [int]$_
    })
    if ($parts.Count -eq 3) { $parts += 0 }
    $fixedVersion = $parts -join '.'

    $resource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'winres.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $info = $resource.RT_VERSION.'#1'.'0000'.info.'0409'
    if (-not $info.FileDescription -or -not $info.ProductName) {
        throw 'FileDescription and ProductName are required in winres.json.'
    }

    if ($Mode -eq 'Prepare') {
        $resource.RT_MANIFEST.'#1'.'0409'.identity.version = $fixedVersion
        $resource.RT_VERSION.'#1'.'0000'.fixed.file_version = $fixedVersion
        $resource.RT_VERSION.'#1'.'0000'.fixed.product_version = $fixedVersion
        $info.FileVersion = $version
        $info.ProductVersion = $version
        $json = $resource | ConvertTo-Json -Depth 16
        [System.IO.File]::WriteAllText($OutputPath, $json, [System.Text.UTF8Encoding]::new($false))
        Write-Output $version
    } else {
        $actual = (Get-Item -LiteralPath $ExecutablePath).VersionInfo
        $expected = [ordered]@{
            FileDescription = $info.FileDescription
            FileVersion = $version
            ProductName = $info.ProductName
            ProductVersion = $version
        }
        foreach ($name in $expected.Keys) {
            if ($actual.$name -cne $expected[$name]) {
                throw "$name mismatch: expected '$($expected[$name])', got '$($actual.$name)'."
            }
            Write-Output ('{0}: {1}' -f $name, $actual.$name)
        }
        $actualFile = @($actual.FileMajorPart, $actual.FileMinorPart, $actual.FileBuildPart, $actual.FilePrivatePart) -join '.'
        $actualProduct = @($actual.ProductMajorPart, $actual.ProductMinorPart, $actual.ProductBuildPart, $actual.ProductPrivatePart) -join '.'
        if ($actualFile -ne $fixedVersion -or $actualProduct -ne $fixedVersion) {
            throw 'Fixed Windows version fields do not match version.go.'
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
