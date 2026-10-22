# Preparation only. Run yourself in Windows PowerShell 5.1 as non-elevated James.
# No Docker, SQL execution, accounts, network requests, or existing-packet changes.
#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedSid = 'S-1-5-21-3618251315-97338079-3510826831-1001'
$expectedAccount = 'LAPTOP-DMJ9UOUC\James Freian Hapitan'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.User.Value -cne $expectedSid -or $identity.Name -ine $expectedAccount) {
    throw 'STOP: Run only as the verified James Windows account, never CodexSandboxOffline.'
}
if (([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole(
        [System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'STOP: An elevated/administrator token is forbidden. Open a normal terminal.'
}
if ($PSVersionTable.PSEdition -ne 'Desktop') {
    throw 'STOP: Use Windows PowerShell 5.1 for this reviewed Windows-only wrapper.'
}

function Assert-Cp4PrivateAcl {
    param([string]$Path, [bool]$ProtectedRoot)
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "STOP: Reparse point refused: $Path"
    }
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -cne $expectedSid -or
        $acl.AreAccessRulesProtected -ne $ProtectedRoot) {
        throw "STOP: Unexpected owner or inheritance: $Path"
    }
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $allowed = @($expectedSid, 'S-1-5-18', 'S-1-5-32-544')
    if ($rules.Count -ne 3) { throw "STOP: Expected exactly three ACEs: $Path" }
    $inheritance = if ($item.PSIsContainer) { 3 } else { 0 }
    foreach ($sid in $allowed) {
        $matches = @($rules | Where-Object { $_.IdentityReference.Value -ceq $sid })
        if ($matches.Count -ne 1) { throw "STOP: Unexpected permission principal: $Path" }
        $rule = $matches[0]
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            [int]$rule.FileSystemRights -ne [int][System.Security.AccessControl.FileSystemRights]::FullControl -or
            [int]$rule.InheritanceFlags -ne $inheritance -or
            [int]$rule.PropagationFlags -ne 0 -or $rule.IsInherited -eq $ProtectedRoot) {
            throw "STOP: Unexpected permission scope or rights: $Path"
        }
    }
}

$repo = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $PSScriptRoot 'admin-audit-cp4.mjs'
if (!(Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'STOP: CP4 helper missing.' }
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$tempBase = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'
if (!(Test-Path -LiteralPath $tempBase -PathType Container) -or
    $tempBase.StartsWith('\\') -or ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($tempBase))).DriveFormat -ne 'NTFS') {
    throw 'STOP: An existing local NTFS user temporary directory is required.'
}
$ancestor = Get-Item -LiteralPath $tempBase -Force
while ($null -ne $ancestor) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'STOP: Temporary directory ancestry contains a reparse point.'
    }
    $ancestor = $ancestor.Parent
}

# All values below are generated only when this script is executed by James.
$nonce = [guid]::NewGuid().ToString('N')
$parent = Join-Path $tempBase "mc-audit-cp4-james-$nonce"
$packet = Join-Path $parent "mc-audit-cp4-compose-$nonce"
$oldTemp = [Environment]::GetEnvironmentVariable('TEMP', 'Process')
$oldTmp = [Environment]::GetEnvironmentVariable('TMP', 'Process')

# CreateDirectoryW is exclusive: ERROR_ALREADY_EXISTS is a failure, not adoption.
# A fresh descriptor contains only the protected DACL, no owner/group/SACL sections.
# No Set-Acl, privilege adjustment, or edit of an existing object is performed.
$nativeName = "Cp4CreateDirectory_$nonce"
$nativeSource = @'
using System;
using System.Runtime.InteropServices;
public static class __NATIVE_NAME__ {
    [StructLayout(LayoutKind.Sequential)]
    public struct SecurityAttributes {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
    public static int CreateExclusive(string path, ref SecurityAttributes attributes) {
        return CreateDirectoryW(path, ref attributes) ? 0 : Marshal.GetLastWin32Error();
    }
}
'@
$nativeType = Add-Type -TypeDefinition ($nativeSource.Replace('__NATIVE_NAME__', $nativeName)) -PassThru |
    Where-Object { $_.Name -ceq $nativeName }
$security = [System.Security.AccessControl.DirectorySecurity]::new()
$security.SetAccessRuleProtection($true, $false)
foreach ($sid in @($expectedSid, 'S-1-5-18', 'S-1-5-32-544')) {
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($sid),
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]3,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow))
}
$descriptor = $security.GetSecurityDescriptorBinaryForm()
$nativeBuffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($descriptor.Length)
try {
    [Runtime.InteropServices.Marshal]::Copy($descriptor, 0, $nativeBuffer, $descriptor.Length)
    $attributes = [Activator]::CreateInstance($nativeType.GetNestedType('SecurityAttributes'))
    $attributes.Length = [Runtime.InteropServices.Marshal]::SizeOf($attributes)
    $attributes.Descriptor = $nativeBuffer
    $attributes.InheritHandle = $false
    $nativeError = $nativeType::CreateExclusive($parent, [ref]$attributes)
    if ($nativeError -ne 0) {
        throw [ComponentModel.Win32Exception]::new($nativeError)
    }
} finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($nativeBuffer)
}

try {
    Assert-Cp4PrivateAcl -Path $parent -ProtectedRoot $true
    if (@(Get-ChildItem -LiteralPath $parent -Force).Count -ne 0) {
        throw 'STOP: New private parent is not empty.'
    }
    Write-Host 'PASS: James non-elevated identity; empty, James-owned restricted parent created before credentials.'
    [Environment]::SetEnvironmentVariable('TEMP', $parent, 'Process')
    [Environment]::SetEnvironmentVariable('TMP', $parent, 'Process')

    # Existing generator and verifier only. No CLI runtime/inspect/verify modes.
    $javascript = @'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
let stage = 'import';
try {
  const {prepareCompose, loadPlan} = await import(__HELPER_URL__);
  const nonce = __NONCE__;
  assert.equal(os.tmpdir(), __PARENT__);
  stage = 'prepare';
  const packet = prepareCompose(nonce);
  stage = 'verify';
  const plan = loadPlan(packet);
  assert.equal(plan.nonce, nonce);
  assert.equal(Object.keys(plan.files).length, 10);
  assert.deepEqual(fs.readdirSync(packet).sort(), ['compose.json','runtime-manifest.json','db-start.sh','setup.sql','plan.json','private'].sort());
  assert.deepEqual(fs.readdirSync(path.join(packet,'private')).sort(), ['db.env','auth.env','rest.env','realtime.env','client.env','kong.json'].sort());
  const env = Object.fromEntries(fs.readFileSync(path.join(packet,'private/client.env'),'utf8').trim().split(/\r?\n/).map(line => {
    const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)];
  }));
  const expiries = ['MC_CP4_ANON_KEY','MC_CP4_SERVICE_KEY'].map((name,i) => {
    const payload = JSON.parse(Buffer.from(env[name].split('.')[1],'base64url'));
    assert.equal(payload.role, ['anon','service_role'][i]);
    assert(Number.isInteger(payload.iat) && Number.isInteger(payload.exp));
    assert.equal(payload.exp-payload.iat,86400);
    assert(Math.abs(Date.now()/1000-payload.iat)<300 && payload.exp>Date.now()/1000);
    return payload.exp;
  });
  assert.equal(expiries[0],expiries[1]);
  console.log(JSON.stringify({packet,nonce,hashes:10,expiresUtc:new Date(expiries[0]*1000).toISOString(),planHash:createHash('sha256').update(fs.readFileSync(path.join(packet,'plan.json'))).digest('hex')}));
} catch (error) {
  // Preserve stage/type/code, never print assertion values or secret-bearing content.
  console.error(JSON.stringify({stage,errorType:error.name,code:error.code||null}));
  process.exitCode=1;
}
'@
    $javascript = $javascript.Replace('__HELPER_URL__', (([uri]$helper).AbsoluteUri | ConvertTo-Json -Compress))
    $javascript = $javascript.Replace('__NONCE__', ($nonce | ConvertTo-Json -Compress))
    $javascript = $javascript.Replace('__PARENT__', ($parent | ConvertTo-Json -Compress))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.Arguments = '--input-type=module'
    $start.WorkingDirectory = $repo
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($javascript)
        $process.StandardInput.Close()
        if (!$process.WaitForExit(30000)) { $process.Kill(); throw 'STOP: Preparation timed out; retain partial packet, do not retry it.' }
        $output = $stdout.GetAwaiter().GetResult()
        $diagnostic = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            # Only accept the fixed diagnostic shape; raw child output is never echoed.
            try { $failure = $diagnostic | ConvertFrom-Json } catch { throw 'STOP: Node failed without a structured diagnostic; retain packet.' }
            if ($failure.stage -notin @('import','prepare','verify') -or $failure.errorType -notmatch '^(Error|[A-Za-z]+Error)$' -or
                ($null -ne $failure.code -and $failure.code -notmatch '^[A-Z0-9_]+$')) { throw 'STOP: Unrecognized child diagnostic; retain packet.' }
            throw "STOP: Node phase=$($failure.stage); type=$($failure.errorType); code=$($failure.code). Retain packet."
        }
        $summary = $output | ConvertFrom-Json
    } finally { $process.Dispose() }
    if ($summary.packet -ine $packet -or $summary.nonce -cne $nonce -or $summary.hashes -ne 10 -or
        $summary.planHash -notmatch '^[a-f0-9]{64}$') { throw 'STOP: Generator receipt mismatch.' }
    Assert-Cp4PrivateAcl -Path $parent -ProtectedRoot $true
    Assert-Cp4PrivateAcl -Path $packet -ProtectedRoot $false
    Assert-Cp4PrivateAcl -Path (Join-Path $packet 'private') -ProtectedRoot $false
    $files = @('plan.json','compose.json','runtime-manifest.json','db-start.sh','setup.sql',
        'private\db.env','private\auth.env','private\rest.env','private\realtime.env','private\client.env','private\kong.json')
    foreach ($name in $files) {
        $path = Join-Path $packet $name
        Assert-Cp4PrivateAcl -Path $path -ProtectedRoot $false
        $handle = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $handle.Dispose()
    }
    if ((Get-FileHash -LiteralPath (Join-Path $packet 'plan.json') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $summary.planHash) {
        throw 'STOP: Seal receipt changed during access verification.'
    }
    $expiry = [DateTimeOffset]::Parse($summary.expiresUtc)
    if ($expiry -le [DateTimeOffset]::UtcNow) { throw 'STOP: Credentials expired during preparation.' }
    Write-Host 'PASS: Eleven files and three directories owned by James; only James/SYSTEM/Administrators ACEs.'
    Write-Host 'PASS: Ten sealed SHA-256 hashes, exact inventory, fresh 24-hour API keys, and reviewed manifest contract.'
    Write-Host 'PASS: Read-only file handles verified as James. No Docker or SQL executed. Stop for separate preflight approval.'
    [pscustomobject]@{ Parent=$parent; Packet=$packet; Nonce=$nonce; VerifiedAs=$identity.Name;
        PlanSHA256=$summary.planHash; ExpiresPhilippineTime=$expiry.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd HH:mm:ss zzz') }
} catch {
    Write-Warning "STOP: Failed preparation retained at $parent. No cleanup, ACL broadening, or retry of that packet."
    throw  # Preserve original Windows exception and stack; never replace it with a generic recovery exception.
} finally {
    [Environment]::SetEnvironmentVariable('TEMP', $oldTemp, 'Process')
    [Environment]::SetEnvironmentVariable('TMP', $oldTmp, 'Process')
}
