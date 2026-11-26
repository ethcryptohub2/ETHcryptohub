param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('setup', 'run', 'verify-store')]
  [string]$Mode,

  [ValidateSet('auth', 'admin', 'user')]
  [string]$Suite = 'auth'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repositoryRoot

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public sealed class SmartExitCredentialRecord
{
    public string UserName;
    public string Secret;

    public SmartExitCredentialRecord(string userName, string secret)
    {
        UserName = userName;
        Secret = secret;
    }
}

public static class SmartExitCredentialStore
{
    private const uint GenericCredential = 1;
    private const uint LocalMachinePersistence = 2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref NativeCredential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = false)]
    private static extern void CredFree(IntPtr credential);

    public static void Write(string target, string userName, IntPtr secret, uint secretSize)
    {
        if (secretSize > 2560)
            throw new ArgumentOutOfRangeException("secretSize", "The Credential Manager secret is too long.");

        IntPtr targetPointer = IntPtr.Zero;
        IntPtr userPointer = IntPtr.Zero;
        try
        {
            targetPointer = Marshal.StringToCoTaskMemUni(target);
            userPointer = Marshal.StringToCoTaskMemUni(userName);
            NativeCredential credential = new NativeCredential();
            credential.Type = GenericCredential;
            credential.TargetName = targetPointer;
            credential.UserName = userPointer;
            credential.CredentialBlob = secret;
            credential.CredentialBlobSize = secretSize;
            credential.Persist = LocalMachinePersistence;

            if (!CredWrite(ref credential, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            if (targetPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(targetPointer);
            if (userPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(userPointer);
        }
    }

    public static SmartExitCredentialRecord Read(string target)
    {
        IntPtr pointer;
        if (!CredRead(target, GenericCredential, 0, out pointer))
            throw new Win32Exception(Marshal.GetLastWin32Error());

        try
        {
            NativeCredential credential = (NativeCredential)Marshal.PtrToStructure(
                pointer,
                typeof(NativeCredential)
            );
            string userName = Marshal.PtrToStringUni(credential.UserName);
            if (credential.CredentialBlobSize % 2 != 0)
                throw new InvalidOperationException("The stored Credential Manager secret is invalid.");

            string secret = Marshal.PtrToStringUni(
                credential.CredentialBlob,
                checked((int)(credential.CredentialBlobSize / 2))
            );
            return new SmartExitCredentialRecord(userName, secret);
        }
        finally
        {
            CredFree(pointer);
        }
    }

    public static void Delete(string target)
    {
        if (!CredDelete(target, GenericCredential, 0))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@

$credentialPrefix = 'SmartExit/functional-staging/auth-e2e'
$adminTarget = "$credentialPrefix/admin"
$userTarget = "$credentialPrefix/user"
$previewTarget = "$credentialPrefix/preview-access"

function Save-Credential {
  param(
    [string]$Target,
    [string]$UserName,
    [securestring]$Secret
  )

  $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Secret)
  try {
    [SmartExitCredentialStore]::Write(
      $Target,
      $UserName,
      $secretPointer,
      [uint32]($Secret.Length * 2)
    )
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($secretPointer)
    $Secret.Dispose()
  }
}

if ($Mode -eq 'verify-store') {
  $target = "$credentialPrefix/self-test-$([guid]::NewGuid().ToString('N'))"
  $testValue = [guid]::NewGuid().ToString('N')
  $secret = ConvertTo-SecureString $testValue -AsPlainText -Force
  try {
    Save-Credential -Target $target -UserName 'self-test' -Secret $secret
    $stored = [SmartExitCredentialStore]::Read($target)
    if ($stored.UserName -ne 'self-test' -or $stored.Secret -ne $testValue) {
      throw 'Windows Credential Manager self-test did not return the stored test value.'
    }
    [SmartExitCredentialStore]::Delete($target)
    Write-Host 'Windows Credential Manager read/write self-test passed.'
  }
  catch {
    try { [SmartExitCredentialStore]::Delete($target) } catch { }
    throw
  }
  exit 0
}

if ($Mode -eq 'setup') {
  Write-Host 'Enter the dedicated Staging test accounts. Password entry is hidden and stored in Windows Credential Manager.'
  $adminEmail = Read-Host -Prompt 'ADMIN_TEST_EMAIL'
  $adminPassword = Read-Host -Prompt 'ADMIN_TEST_PASSWORD' -AsSecureString
  $userEmail = Read-Host -Prompt 'USER_TEST_EMAIL'
  $userPassword = Read-Host -Prompt 'USER_TEST_PASSWORD' -AsSecureString
  $previewAccess = Read-Host -Prompt 'STAGING_PREVIEW_ACCESS_URL (existing Vercel Shareable Link; optional)' -AsSecureString
  $previewAccessProvided = $previewAccess.Length -gt 0

  if ([string]::IsNullOrWhiteSpace($adminEmail) -or $adminEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
    throw 'ADMIN_TEST_EMAIL must be a valid email address.'
  }
  if ([string]::IsNullOrWhiteSpace($userEmail) -or $userEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
    throw 'USER_TEST_EMAIL must be a valid email address.'
  }
  if ($adminPassword.Length -eq 0 -or $userPassword.Length -eq 0) {
    $adminPassword.Dispose()
    $userPassword.Dispose()
    $previewAccess.Dispose()
    throw 'Both test-account passwords are required.'
  }

  Save-Credential -Target $adminTarget -UserName $adminEmail.Trim() -Secret $adminPassword
  Save-Credential -Target $userTarget -UserName $userEmail.Trim() -Secret $userPassword
  if ($previewAccessProvided) {
    Save-Credential -Target $previewTarget -UserName 'url' -Secret $previewAccess
  }
  else {
    $previewAccess.Dispose()
  }

  Write-Host 'Test-account credentials are stored in Windows Credential Manager.'
  if ($previewAccessProvided) {
    Write-Host 'The Preview Shareable Link is stored locally in Windows Credential Manager.'
  }
  else {
    Write-Host 'No new Preview link was entered; any previously stored link was left unchanged.'
  }
  exit 0
}

$playwrightCli = Join-Path $repositoryRoot 'node_modules\@playwright\test\cli.js'
if (!(Test-Path -LiteralPath $playwrightCli -PathType Leaf)) {
  throw 'The existing local Playwright installation is required to run the auth suite.'
}

try {
  $adminCredential = [SmartExitCredentialStore]::Read($adminTarget)
  $userCredential = [SmartExitCredentialStore]::Read($userTarget)
}
catch {
  throw 'No complete test-account credential set was found in Windows Credential Manager. Run npm.cmd run setup:test-auth in a local terminal.'
}

$env:SMARTEXIT_ADMIN_TEST_EMAIL = $adminCredential.UserName
$env:SMARTEXIT_ADMIN_TEST_PASSWORD = $adminCredential.Secret
$env:SMARTEXIT_USER_TEST_EMAIL = $userCredential.UserName
$env:SMARTEXIT_USER_TEST_PASSWORD = $userCredential.Secret
if (-not $env:SMARTEXIT_TEST_BASE_URL) {
  $env:SMARTEXIT_TEST_BASE_URL = 'https://smartexit-staging.onrender.com'
}

try {
  $previewCredential = [SmartExitCredentialStore]::Read($previewTarget)
  $env:SMARTEXIT_TEST_ACCESS_URL = $previewCredential.Secret
}
catch {
  Remove-Item Env:\SMARTEXIT_TEST_ACCESS_URL -ErrorAction SilentlyContinue
}

$arguments = @(
  'test',
  '--config=playwright.config.ts',
  'e2e/auth.spec.ts'
)
if ($Suite -ne 'auth') {
  $arguments += "--grep=${Suite}:"
}

& node.exe $playwrightCli @arguments
$exitCode = $LASTEXITCODE
foreach ($name in @(
  'SMARTEXIT_ADMIN_TEST_EMAIL',
  'SMARTEXIT_ADMIN_TEST_PASSWORD',
  'SMARTEXIT_USER_TEST_EMAIL',
  'SMARTEXIT_USER_TEST_PASSWORD',
  'SMARTEXIT_TEST_ACCESS_URL',
  'SMARTEXIT_TEST_BASE_URL'
)) {
  Remove-Item "Env:\$name" -ErrorAction SilentlyContinue
}
exit $exitCode
