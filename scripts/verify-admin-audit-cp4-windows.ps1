# Static/offline only: never invoke the wrapper, native creation, generator or Docker.
#Requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$wrapper = Join-Path $PSScriptRoot 'prepare-admin-audit-cp4-windows.ps1'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$tokens, [ref]$parseErrors)
$source = $ast.Extent.Text
$script:checks = 0
function Check([bool]$Condition, [string]$Label) {
    if (!$Condition) { throw "FAIL: $Label" }
    $script:checks++
}
Check ($parseErrors.Count -eq 0) 'PowerShell 5.1 syntax'
$commands = @($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst]}, $true) |
    ForEach-Object { $_.GetCommandName() })
foreach ($forbidden in @('Set-Acl','Set-ExecutionPolicy','Start-Process','Remove-Item','Copy-Item','Move-Item','icacls','takeown','docker','supabase','Invoke-Expression','Invoke-WebRequest','Invoke-RestMethod')) {
    Check ($commands -notcontains $forbidden) "No $forbidden command"
}
foreach ($required in @('S-1-5-21-3618251315-97338079-3510826831-1001',
    'LAPTOP-DMJ9UOUC\James Freian Hapitan', '[System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '[System.Security.Principal.WindowsBuiltInRole]::Administrator',
    'DriveFormat -ne ''NTFS''', 'ReparsePoint', '[guid]::NewGuid()',
    '$security.SetAccessRuleProtection($true, $false)',
    '[System.Security.AccessControl.DirectorySecurity]::new()',
    '$nativeType::CreateExclusive($parent, [ref]$attributes)',
    'CreateDirectoryW(path, ref attributes) ? 0 : Marshal.GetLastWin32Error()',
    '[ComponentModel.Win32Exception]::new($nativeError)',
    '$attributes.InheritHandle = $false',
    '[Environment]::SetEnvironmentVariable(''TEMP'', $oldTemp, ''Process'')',
    '[Environment]::SetEnvironmentVariable(''TMP'', $oldTmp, ''Process'')')) {
    Check ($source.Contains($required)) "Required guard: $required"
}
Check ($source.IndexOf('$identity.User.Value') -lt $source.IndexOf('$nonce = [guid]')) 'Identity before fresh names'
Check ($source.IndexOf('::Administrator') -lt $source.IndexOf('Add-Type -TypeDefinition')) 'Non-elevated check before creation machinery'
Check ($source.IndexOf('Assert-Cp4PrivateAcl -Path $parent -ProtectedRoot $true') -lt $source.IndexOf('$javascript =')) 'Parent ACL check before generator'
Check ($source.IndexOf('New private parent is not empty') -lt $source.IndexOf('$javascript =')) 'Empty parent before generator'
Check (!$source.Contains('.SetOwner(') -and !$source.Contains('.SetAuditRule(') -and !$source.Contains('AdjustTokenPrivileges')) 'No owner/SACL/privilege mutation'
Check (!$source.Contains('CreateDirectory(')) 'No non-exclusive managed directory creation'
Check ($source.Contains('throw  # Preserve original Windows exception')) 'Original exception rethrow'
Check ($source.Contains('$process.WaitForExit(30000)')) 'Bounded offline child process'

# Compile the extracted P/Invoke declaration only; NEVER call CreateExclusive/CreateDirectoryW.
# Compilation creates no packet or credentials and performs no Windows ACL operation.
$nativeAst = @($ast.FindAll({param($n)
    $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.StartsWith('using System;')
}, $true))
Check ($nativeAst.Count -eq 1) 'One native declaration'
$nativeSource = $nativeAst[0].Value.Replace('__NATIVE_NAME__','Cp4StaticSyntaxOnly')
$nativeType = 'Cp4StaticSyntaxOnly' -as [type]
if ($null -eq $nativeType) {
    $nativeType = Add-Type -TypeDefinition $nativeSource -PassThru | Where-Object { $_.Name -ceq 'Cp4StaticSyntaxOnly' }
}
$nativeAttributes = [Activator]::CreateInstance($nativeType.GetNestedType('SecurityAttributes'))
$layoutSize = [Runtime.InteropServices.Marshal]::SizeOf($nativeAttributes)
Check ($layoutSize -eq $(if([IntPtr]::Size -eq 8){24}else{12})) 'Native SECURITY_ATTRIBUTES layout; no native call'

$jsAst = @($ast.FindAll({param($n)
    $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.StartsWith("import fs from 'node:fs';")
}, $true))
Check ($jsAst.Count -eq 1) 'One embedded preparation/verification program'
$javascript = $jsAst[0].Value
foreach ($required in @('prepareCompose(nonce)', 'loadPlan(packet)', 'Object.keys(plan.files).length, 10',
    'fs.readdirSync(packet)', "fs.readdirSync(path.join(packet,'private'))", 'payload.exp-payload.iat,86400',
    'payload.exp>Date.now()/1000', 'os.tmpdir(), __PARENT__', 'process.exitCode=1', 'stage,errorType:error.name,code:error.code||null')) {
    Check ($javascript.Contains($required)) "Embedded verifier: $required"
}
Check ($javascript -notmatch '\b(verify|viewer|inspectCompose|composeFiles)\s*\(') 'No accounts/runtime modes or alternate generator'
Check ($javascript -notmatch 'console\.(log|error)\((error|env|plan|packet)\)') 'No raw secret-bearing diagnostics'
# Parse JavaScript only. --check never evaluates imports, generates keys, or writes packets.
$javascript | & node --check --input-type=module
Check ($LASTEXITCODE -eq 0) 'Embedded JavaScript syntax without execution'

# Execute ONLY the extracted pure ACL validator against synthetic Get-Item/Get-Acl.
# No real filesystem ACL is read or written in these behavioral tests.
$functionAst = @($ast.FindAll({param($n)
    $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-Cp4PrivateAcl'
}, $true))[0]
& {
    . ([scriptblock]::Create($functionAst.Extent.Text))
    $expectedSid = 'S-1-5-21-3618251315-97338079-3510826831-1001'
    function Get-Item { param($LiteralPath, [switch]$Force) return $fixture.Item }
    function Get-Acl { param($LiteralPath) return $fixture.Acl }
    function Fixture([bool]$Root, [bool]$Directory) {
        $acl = [pscustomobject]@{ Owner=$expectedSid; AreAccessRulesProtected=$Root; Rules=@() }
        $acl | Add-Member ScriptMethod GetOwner { param($type) return [pscustomobject]@{ Value=$this.Owner } }
        $acl | Add-Member ScriptMethod GetAccessRules { param($explicit,$inherited,$type) return $this.Rules }
        foreach ($sid in @($expectedSid,'S-1-5-18','S-1-5-32-544')) {
            $acl.Rules += [pscustomobject]@{ IdentityReference=[pscustomobject]@{Value=$sid};
                AccessControlType=[System.Security.AccessControl.AccessControlType]::Allow;
                FileSystemRights=2032127; InheritanceFlags=$(if($Directory){3}else{0});
                PropagationFlags=0; IsInherited=(!$Root) }
        }
        return [pscustomobject]@{ Item=[pscustomobject]@{Attributes=0;PSIsContainer=$Directory}; Acl=$acl }
    }
    foreach ($shape in @(@($true,$true),@($false,$true),@($false,$false))) {
        $fixture = Fixture $shape[0] $shape[1]
        Assert-Cp4PrivateAcl -Path 'synthetic' -ProtectedRoot $shape[0]
        Check $true 'Accept correct parent/directory/file ACL'
    }
    foreach ($fault in @('wrong-owner','unprotected-parent','extra-principal','missing-principal','deny',
        'excess-rights','missing-rights','wrong-inheritance','wrong-propagation','inherited-root','reparse')) {
        $fixture = Fixture $true $true
        switch ($fault) {
            'wrong-owner' {$fixture.Acl.Owner='S-1-5-21-0-0-0-1003'}
            'unprotected-parent' {$fixture.Acl.AreAccessRulesProtected=$false}
            'extra-principal' {$fixture.Acl.Rules += $fixture.Acl.Rules[0]}
            'missing-principal' {$fixture.Acl.Rules=$fixture.Acl.Rules[0..1]}
            'deny' {$fixture.Acl.Rules[0].AccessControlType=[System.Security.AccessControl.AccessControlType]::Deny}
            'excess-rights' {$fixture.Acl.Rules[0].FileSystemRights=2147483647}
            'missing-rights' {$fixture.Acl.Rules[0].FileSystemRights=1179785}
            'wrong-inheritance' {$fixture.Acl.Rules[0].InheritanceFlags=0}
            'wrong-propagation' {$fixture.Acl.Rules[0].PropagationFlags=1}
            'inherited-root' {$fixture.Acl.Rules[0].IsInherited=$true}
            'reparse' {$fixture.Item.Attributes=[IO.FileAttributes]::ReparsePoint}
        }
        $rejected=$false
        try { Assert-Cp4PrivateAcl -Path 'synthetic' -ProtectedRoot $true } catch { $rejected=$true }
        Check $rejected "Reject $fault"
    }
}
Write-Output "PASS: $script:checks offline assertions; wrapper/native creation/generator never executed; no credentials or ACL writes."
