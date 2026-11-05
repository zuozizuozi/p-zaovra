$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'poll-feedback.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'PowerShell AST validation failed' }
$command = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type' }, $true)[0]
$definition = $command.CommandElements | Where-Object { $_ -is [Management.Automation.Language.StringConstantExpressionAst] -and $_.StringConstantType -eq 'SingleQuotedHereString' } | Select-Object -First 1
if (-not $definition) { throw 'Missing credential reader source' }
Add-Type -TypeDefinition $definition.Value
$result = @{ powershell_ast = 'pass'; credential_reader_compile = 'pass'; credential_read = 0; native_method_invocations = 0; tasks_registered = 0 }
$result | ConvertTo-Json
Write-Output 'PowerShell AST and isolated C# compilation passed; no Credential Manager or task operation executed.'
