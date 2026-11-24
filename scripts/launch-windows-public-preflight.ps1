param(
    [string]$NodePath,
    [string]$OutputDirectory,
    [switch]$ExecuteApprovedPublicOnly,
    [switch]$EligibilityConfirmed,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_LOCAL_RUNNER_REQUIRED' }
if (!$VerifyOnly -and (!$ExecuteApprovedPublicOnly -or !$EligibilityConfirmed -or !$OutputDirectory)) {
    throw 'SEPARATE_FINITE_PREFLIGHT_APPROVAL_REQUIRED'
}
if ($VerifyOnly -and ($ExecuteApprovedPublicOnly -or $EligibilityConfirmed -or $OutputDirectory)) {
    throw 'VERIFY_ONLY_CANNOT_EXECUTE_PREFLIGHT'
}
if ($NodePath -notmatch '^[A-Za-z]:[\\/]' -or [IO.Path]::GetFileName($NodePath) -ne 'node.exe') {
    throw 'ABSOLUTE_LOCAL_NODE_PATH_REQUIRED'
}
if ((Get-Item -LiteralPath $NodePath).PSIsContainer) { throw 'NODE_EXECUTABLE_REQUIRED' }
if ($OutputDirectory -match '^(\\\\|//|[a-z][a-z0-9+.-]*://)') {
    throw 'LOCAL_EVIDENCE_DIRECTORY_REQUIRED'
}

function Quote-WindowsArgument([string]$Argument) {
    # ProcessStartInfo.ArgumentList is unavailable in Windows PowerShell 5.1.
    '"' + ($Argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-IsolatedNode([string[]]$Arguments) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = [IO.Path]::GetFullPath($NodePath)
    $start.Arguments = ($Arguments | ForEach-Object { Quote-WindowsArgument $_ }) -join ' '
    $start.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $start.UseShellExecute = $false
    $start.EnvironmentVariables.Clear()
    $windowsPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    if (!$windowsPath) { throw 'WINDOWS_SYSTEM_DIRECTORY_REQUIRED' }
    $start.EnvironmentVariables['SystemRoot'] = $windowsPath
    $start.EnvironmentVariables['WINDIR'] = $windowsPath
    $child = [Diagnostics.Process]::Start($start)
    try {
        $child.WaitForExit()
        $script:isolatedNodeExit = $child.ExitCode
    } finally {
        $child.Dispose()
    }
}

# Validate the child runtime and the exact environment even in offline mode.
$probe = @'
const names = Object.keys(process.env).filter(name => !name.startsWith("=")).map(name => name.toUpperCase()).sort();
if (names.join(",") !== "SYSTEMROOT,WINDIR") throw new Error("UNEXPECTED_ISOLATED_ENVIRONMENT");
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("NODE_24_REQUIRED");
console.log("Verified isolated Node.js " + process.versions.node + " environment");
'@
Invoke-IsolatedNode @('-e', $probe)
if ($isolatedNodeExit -ne 0 -or $VerifyOnly) { exit $isolatedNodeExit }

$outputPath = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
    [IO.Path]::GetFullPath($OutputDirectory)
} else {
    [IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $OutputDirectory))
}

Invoke-IsolatedNode @(
    (Join-Path $PSScriptRoot 'windows-public-preflight.mjs'),
    '--execute-approved-public-only',
    '--eligibility-confirmed',
    '--output',
    $outputPath
)
exit $isolatedNodeExit
