param([Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference='Stop'
$resolved=[IO.Path]::GetFullPath($FixtureRoot)
if (-not $resolved.StartsWith('F:\Zaovra-研发记录\逐次记录\',[StringComparison]::OrdinalIgnoreCase)) {throw 'Fixture must stay in the F record session'}
$single=Join-Path $resolved "two'quotes"
$double=Join-Path $resolved "two''quotes"
[IO.Directory]::CreateDirectory($single) | Out-Null
[IO.Directory]::CreateDirectory($double) | Out-Null
[IO.File]::WriteAllText((Join-Path $single 'input.txt'),'SINGLE')
[IO.File]::WriteAllText((Join-Path $double 'input.txt'),'DOUBLE')
$doubleLiteral=Join-Path $resolved "two''quotes\input.txt"
$actualDouble=Get-Content -LiteralPath $doubleLiteral
$pointer=Join-Path $resolved 'pointer.txt'
[IO.File]::WriteAllText($pointer,$doubleLiteral,(New-Object Text.UTF8Encoding($true)))
$p='safe.txt'
Get-Content -LiteralPath $pointer -OutVariable p | Out-Null
$actualOutput=Get-Content -LiteralPath $p
$p='safe.txt'
Get-Content -LiteralPath $pointer -ov p | Out-Null
$actualAlias=Get-Content -LiteralPath $p
if ($actualDouble -ne 'DOUBLE' -or $actualOutput -ne 'DOUBLE' -or $actualAlias -ne 'DOUBLE') {throw 'Unexpected native PowerShell binding'}
@{version=$PSVersionTable.PSVersion.ToString();doubleQuoted=$actualDouble;outVariable=$actualOutput;alias=$actualAlias;userDataRead=$false} | ConvertTo-Json -Compress
