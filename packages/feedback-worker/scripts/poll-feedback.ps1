#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$BunPath = (Get-Command bun -ErrorAction Stop).Source,
    [string]$InboxRoot = 'F:\Zaovra-研发记录\反馈收件箱',
    [switch]$InstallTask
)
$ErrorActionPreference = 'Stop'
$approvedRoot = [IO.Path]::GetFullPath('F:\Zaovra-研发记录').TrimEnd('\') + '\'
$inbox = [IO.Path]::GetFullPath($InboxRoot)
if (-not $inbox.StartsWith($approvedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Inbox must stay in the approved records directory.' }
$archiveScript = Join-Path $PSScriptRoot 'archive-feedback.ts'
if ($InstallTask) {
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $quote = { param([string]$value) if ($value -match '["\r\n]') { throw 'Invalid task path.' }; '"' + $value + '"' }
    $arguments = '-NoProfile -NonInteractive -File ' + (& $quote $PSCommandPath) + ' -BunPath ' + (& $quote $BunPath) + ' -InboxRoot ' + (& $quote $inbox)
    $action = New-ScheduledTaskAction -Execute (Get-Process -Id $PID).Path -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
    Register-ScheduledTask -TaskName 'ZaovraFeedbackArchive' -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    Write-Output 'Feedback archive task registered for the current signed-in user, every five minutes.'
    exit 0
}
# Windows Credential Manager is outside the records/source trees. No secret path or value is an argument.
if (-not ('ZaovraFeedbackCredential.Reader' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Runtime.InteropServices;
namespace ZaovraFeedbackCredential {
    public static class Reader {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct Credential {
            public uint Flags, Type;
            public string TargetName, Comment;
            public long LastWritten;
            public uint BlobSize;
            public IntPtr Blob;
            public uint Persist, AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias, UserName;
        }
        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredRead(string target, uint type, uint flags, out IntPtr value);
        [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr value);
        public static NetworkCredential Read() {
            IntPtr value;
            if (!CredRead("ZaovraFeedbackAccess", 1, 0, out value)) throw new InvalidOperationException("Credential unavailable");
            try {
                var credential = Marshal.PtrToStructure<Credential>(value);
                if (credential.BlobSize > 32768 || credential.BlobSize % 2 != 0) throw new InvalidOperationException("Invalid credential");
                return new NetworkCredential(credential.UserName, Marshal.PtrToStringUni(credential.Blob, (int)credential.BlobSize / 2));
            } finally { CredFree(value); }
        }
    }
}
'@
}
$credential = $null
$payload = $null
$child = $null
[IO.Directory]::CreateDirectory($inbox) | Out-Null
try {
    $credential = [ZaovraFeedbackCredential.Reader]::Read()
    $payload = [Text.Encoding]::UTF8.GetBytes((@{ clientId = $credential.UserName; clientSecret = $credential.Password } | ConvertTo-Json -Compress))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $BunPath
    $start.ArgumentList.Add($archiveScript)
    $start.ArgumentList.Add($inbox)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $start
    if (-not $child.Start()) { throw 'Archive process unavailable.' }
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    $child.StandardInput.BaseStream.Write($payload, 0, $payload.Length)
    $child.StandardInput.Close()
    [Array]::Clear($payload, 0, $payload.Length)
    $payload = $null
    $credential = $null
    $child.WaitForExit()
    $output = $stdout.GetAwaiter().GetResult()
    $null = $stderr.GetAwaiter().GetResult() # Never persist external error details or stdin.
    $result = @{ checkedAt = [DateTime]::UtcNow.ToString('o'); exit = $child.ExitCode; success = ($child.ExitCode -eq 0) }
    if ($child.ExitCode -eq 0) { $result.archived = @((ConvertFrom-Json $output).archived).Count }
    [IO.File]::WriteAllText((Join-Path $inbox 'archive-status.json'), ($result | ConvertTo-Json))
    if ($child.ExitCode -ne 0) { throw 'Archive failed.' }
    Write-Output 'Feedback archive completed; see the inbox index.'
} catch {
    Write-Error 'Feedback archive did not complete. Check the Access policy, credential expiry and archive lock; secret values are not logged.' -ErrorAction Continue
    exit 1
} finally {
    if ($payload) { [Array]::Clear($payload, 0, $payload.Length) }
    $credential = $null
    if ($child) { $child.Dispose() }
}
