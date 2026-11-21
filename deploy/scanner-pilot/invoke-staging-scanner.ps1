[CmdletBinding(DefaultParameterSetName = 'Verify')]
param(
    [Parameter(Mandatory = $true)]
    [string] $PreviewHost,
    [Parameter(Mandatory = $true)]
    [string] $ExpectedCommit,
    [Parameter(Mandatory = $true)]
    [string] $StartUtc,
    [Parameter(Mandatory = $true)]
    [string] $StopUtc,
    [Parameter(ParameterSetName = 'Verify', Mandatory = $true)]
    [switch] $VerifyOnly,
    [Parameter(ParameterSetName = 'Execute', Mandatory = $true)]
    [switch] $ExecuteApproved
)

$ErrorActionPreference = 'Stop'
if (($PSCmdlet.ParameterSetName -eq 'Verify' -and !$VerifyOnly) -or
    ($PSCmdlet.ParameterSetName -eq 'Execute' -and !$ExecuteApproved)) {
    throw 'The selected execution flag must be set.'
}
if ($PreviewHost -cnotmatch '\Acryptohub-[a-z0-9]+-eth-cryptohub\.vercel\.app\z') {
    throw 'Use the exact immutable cryptohub Staging Preview hostname.'
}
if ($ExpectedCommit -cnotmatch '\A[a-f0-9]{40}\z') {
    throw 'Use the full reviewed Git commit SHA.'
}

$format = "yyyy-MM-dd'T'HH:mm:ss'Z'"
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$style = [System.Globalization.DateTimeStyles]::AssumeUniversal
$start = [DateTimeOffset]::ParseExact($StartUtc, $format, $culture, $style).ToUniversalTime()
$stop = [DateTimeOffset]::ParseExact($StopUtc, $format, $culture, $style).ToUniversalTime()
if ($stop -le $start -or ($stop - $start).TotalMinutes -gt 60 -or
    $start.Minute % 15 -ne 0 -or $stop.Minute % 15 -ne 0 -or $start.Second -ne 0 -or $stop.Second -ne 0) {
    throw 'Use quarter-hour UTC boundaries and a positive pilot window of at most 60 minutes.'
}
if ($VerifyOnly) {
    [pscustomobject]@{ Host = $PreviewHost; Commit = $ExpectedCommit; StartUtc = $StartUtc; StopUtc = $StopUtc; Sent = $false }
    return
}

$now = [DateTimeOffset]::UtcNow
$slotMinute = $now.Minute % 15
if ($now -lt $start -or $now -ge $stop -or $slotMinute -lt 2 -or $slotMinute -gt 4) {
    throw 'Outside the approved pilot window or slot admission interval.'
}
$token = $env:SMARTEXIT_SCANNER_PILOT_TOKEN
if ($token -cnotmatch '\A[A-Za-z0-9_-]{32,128}\z') {
    throw 'A dedicated scanner pilot token is required in this process environment.'
}

Add-Type -AssemblyName System.Net.Http
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $false
$handler.UseCookies = $false
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(40)
$request = [System.Net.Http.HttpRequestMessage]::new(
    [System.Net.Http.HttpMethod]::Post, "https://$PreviewHost/api/jobs/staging-scanner"
)
$request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)
$request.Headers.Add('X-SmartExit-Expected-Commit', $ExpectedCommit)
try {
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    try {
        $status = [int] $response.StatusCode
        if (!$response.IsSuccessStatusCode) {
            throw "Scanner pilot returned HTTP $status. Review Staging run history before the next slot."
        }
        [pscustomobject]@{ Host = $PreviewHost; Commit = $ExpectedCommit; Sent = $true; Status = $status; CheckedAtUtc = [DateTimeOffset]::UtcNow }
    } finally {
        $response.Dispose()
    }
} finally {
    $request.Dispose()
    $client.Dispose()
}
