$ErrorActionPreference = 'Stop'

$secureApiKey = Read-Host 'Resend API key (input is hidden)' -AsSecureString
$apiKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureApiKey)
$apiKey = $null

try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($apiKeyPointer)
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        throw 'A Resend API key is required.'
    }

    $senderAddress = (Read-Host 'Verified Resend sender email address').Trim()
    try {
        $senderParsed = New-Object System.Net.Mail.MailAddress -ArgumentList $senderAddress
    } catch {
        throw 'Enter a valid sender email address verified in Resend.'
    }
    if ($senderParsed.Address -ne $senderAddress) {
        throw 'Enter a valid sender email address verified in Resend.'
    }

    [Environment]::SetEnvironmentVariable('RESEND_API_KEY', $apiKey, 'User')
    [Environment]::SetEnvironmentVariable('MAIL_FROM', $senderAddress, 'User')
    $env:RESEND_API_KEY = $apiKey
    $env:MAIL_FROM = $senderAddress

    Write-Output 'Saved Resend settings for the current Windows user. The API key was not displayed.'
    Write-Output 'Dot-source this script so the current PowerShell process receives the settings:'
    Write-Output '. .\configure-email.ps1'
    Write-Output 'Then start/restart PHP from this PowerShell window and run:'
    Write-Output '.\email-delivery-check.php YOUR_INBOX@example.com'
    Write-Output 'Use the PHP executable with cURL/OpenSSL enabled as documented in MAIL_SETUP.md.'
}
finally {
    if ($apiKeyPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($apiKeyPointer)
    }
    if ($null -ne $apiKey) {
        $apiKey = $null
    }
    $secureApiKey.Dispose()
}
