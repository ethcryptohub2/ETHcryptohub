<#
.SYNOPSIS
    Securely accesses the SmartExit Staging administrator credential on the local machine.
    Never transmits or logs the secret.
.PARAMETER Action
    'clipboard' (default) copies the secret to the Windows clipboard.
    'dialog' opens a local Windows GUI dialog displaying the credential securely.
#>
param(
    [ValidateSet('clipboard', 'dialog')]
    [string]$Action = 'clipboard'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'scripts\auth-e2e.ps1') -Mode verify-store | Out-Null

$target = 'SmartExit/functional-staging/auth-e2e/admin'
try {
    $admin = [SmartExitCredentialStore]::Read($target)
}
catch {
    Write-Error "Credential '$target' not found in Windows Credential Manager."
    exit 1
}

if ($Action -eq 'clipboard') {
    try {
        Set-Clipboard -Value $admin.Secret
    }
    catch {
        # Fallback to Windows native clip utility via pipeline
        $process = Start-Process -FilePath "clip.exe" -NoNewWindow -PassThru -RedirectStandardInput ([System.IO.Path]::GetTempFileName())
        # Or standard input writer:
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "clip.exe"
        $psi.UseShellExecute = $false
        $psi.RedirectStandardInput = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $p.StandardInput.Write($admin.Secret)
        $p.StandardInput.Close()
        $p.WaitForExit()
    }
    Write-Host "Success: The administrator password for $($admin.UserName) has been copied to your Windows clipboard." -ForegroundColor Green
    Write-Host "You can now paste (Ctrl+V) it directly into your browser or password manager."
    exit 0
}

if ($Action -eq 'dialog') {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "SmartExit Staging - Admin Credential"
    $form.Size = New-Object System.Drawing.Size(420, 240)
    $form.StartPosition = "CenterScreen"
    $form.TopMost = $true
    $form.FormBorderStyle = "FixedDialog"
    $form.MaximizeBox = $false

    $lblUser = New-Object System.Windows.Forms.Label
    $lblUser.Location = New-Object System.Drawing.Point(20, 20)
    $lblUser.Size = New-Object System.Drawing.Size(360, 20)
    $lblUser.Text = "Target: $target`nUsername: $($admin.UserName)"
    $form.Controls.Add($lblUser)

    $lblPass = New-Object System.Windows.Forms.Label
    $lblPass.Location = New-Object System.Drawing.Point(20, 65)
    $lblPass.Size = New-Object System.Drawing.Size(360, 20)
    $lblPass.Text = "Password:"
    $form.Controls.Add($lblPass)

    $txtPass = New-Object System.Windows.Forms.TextBox
    $txtPass.Location = New-Object System.Drawing.Point(20, 90)
    $txtPass.Size = New-Object System.Drawing.Size(360, 25)
    $txtPass.ReadOnly = $true
    $txtPass.Text = $admin.Secret
    $txtPass.Font = New-Object System.Drawing.Font("Consolas", 11)
    $form.Controls.Add($txtPass)

    $btnCopy = New-Object System.Windows.Forms.Button
    $btnCopy.Location = New-Object System.Drawing.Point(20, 140)
    $btnCopy.Size = New-Object System.Drawing.Size(170, 35)
    $btnCopy.Text = "Copy to Clipboard"
    $btnCopy.Add_Click({
        try { Set-Clipboard -Value $admin.Secret } catch {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = "clip.exe"; $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true
            $p = [System.Diagnostics.Process]::Start($psi); $p.StandardInput.Write($admin.Secret); $p.StandardInput.Close(); $p.WaitForExit()
        }
        [System.Windows.Forms.MessageBox]::Show("Password copied to clipboard!", "SmartExit", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    })
    $form.Controls.Add($btnCopy)

    $btnClose = New-Object System.Windows.Forms.Button
    $btnClose.Location = New-Object System.Drawing.Point(210, 140)
    $btnClose.Size = New-Object System.Drawing.Size(170, 35)
    $btnClose.Text = "Close"
    $btnClose.Add_Click({ $form.Close() })
    $form.Controls.Add($btnClose)

    [void]$form.ShowDialog()
}
