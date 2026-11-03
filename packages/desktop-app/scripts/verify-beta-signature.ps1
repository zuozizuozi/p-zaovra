param([Parameter(Mandatory=$true)][string]$Installer, [Parameter(Mandatory=$true)][string]$Publisher)
$ErrorActionPreference = "Stop"
$signature = Get-AuthenticodeSignature -LiteralPath $Installer
if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne $Publisher) { throw "Installer signature or publisher validation failed" }
Write-Output "Installer signature and publisher verified"
