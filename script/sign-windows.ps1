param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Path
)

$ErrorActionPreference = "Stop"

if (-not $Path -or $Path.Count -eq 0) {
  throw "At least one path is required"
}

if ($env:GITHUB_ACTIONS -ne "true") {
  Write-Host "Skipping Windows signing because this is not running on GitHub Actions"
  exit 0
}

$vars = @{
  endpoint = $env:AZURE_TRUSTED_SIGNING_ENDPOINT
  account = $env:AZURE_TRUSTED_SIGNING_ACCOUNT_NAME
  profile = $env:AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE
  publisher = $env:WINDOWS_SIGNING_PUBLISHER_NAME
}

if ($vars.Values | Where-Object { [string]::IsNullOrWhiteSpace($_) }) {
  throw "Windows signing configuration is incomplete: endpoint, account, certificate profile and publisher name are required in CI"
}

$files = @($Path | ForEach-Object { (Resolve-Path -LiteralPath $_ -ErrorAction Stop).Path } | Select-Object -Unique)
foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "Signing target is not a file: $file"
  }
}

$moduleVersion = "0.5.8"
$module = Get-Module -ListAvailable -Name TrustedSigning | Where-Object { $_.Version -eq [version] $moduleVersion }

if (-not $module) {
  try {
    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
  }
  catch {
    Write-Host "NuGet package provider install skipped: $($_.Exception.Message)"
  }

  Install-Module -Name TrustedSigning -RequiredVersion $moduleVersion -Force -Repository PSGallery -Scope CurrentUser
}

Import-Module TrustedSigning -RequiredVersion $moduleVersion -Force

$params = @{
  Endpoint                         = $vars.endpoint
  CodeSigningAccountName           = $vars.account
  CertificateProfileName           = $vars.profile
  Files                            = ($files -join ",")
  FileDigest                       = "SHA256"
  TimestampDigest                  = "SHA256"
  TimestampRfc3161                 = "http://timestamp.acs.microsoft.com"
  ExcludeEnvironmentCredential     = $true
  ExcludeWorkloadIdentityCredential = $true
  ExcludeManagedIdentityCredential = $true
  ExcludeSharedTokenCacheCredential = $true
  ExcludeVisualStudioCredential    = $true
  ExcludeVisualStudioCodeCredential = $true
  ExcludeAzureCliCredential        = $false
  ExcludeAzurePowerShellCredential = $true
  ExcludeAzureDeveloperCliCredential = $true
  ExcludeInteractiveBrowserCredential = $true
}

Invoke-TrustedSigning @params

foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Windows signing verification failed for ${file}: $($signature.Status)"
  }
  $publisher = $vars.publisher.Trim()
  $commonName = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($commonName -cne $publisher -and $signature.SignerCertificate.Subject -cne $publisher) {
    throw "Windows signing publisher does not match WINDOWS_SIGNING_PUBLISHER_NAME for ${file}"
  }
}
