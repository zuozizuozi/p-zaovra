param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$MakeNSIS = (Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'NSIS/makensis.exe')
)
$ErrorActionPreference = "Stop"
$project = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ($project.Contains('"') -or $OutputDirectory.Contains('"')) { throw "Invalid NSIS fixture path" }
if (-not (Test-Path -LiteralPath $MakeNSIS -PathType Leaf)) { throw "makensis is required; parsing configuration is insufficient" }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
foreach ($channel in @("dev", "beta", "prod")) {
  $script = Join-Path $OutputDirectory "$channel.nsi"
  $output = Join-Path $OutputDirectory "$channel.exe"
  $source = @'
Unicode true
Name "Zaovra compile-only fixture"
RequestExecutionLevel user
OutFile "__OUTPUT__"
!define PROJECT_DIR "__PROJECT__"
!define APP_EXECUTABLE_FILENAME "Zaovra.exe"
; Custom includes are expanded before the builder's LogicLib include.
!include "__PROJECT__\resources\channel-__CHANNEL__.nsh"
!include "LogicLib.nsh"
Section "compile-only"
  !insertmacro customInit
  WriteUninstaller "$TEMP\zaovra-compile-only-uninstall.exe"
SectionEnd
Section "Uninstall"
  !insertmacro customUnInit
  !insertmacro customUnInstall
SectionEnd
'@
  $source = $source.Replace('__PROJECT__', $project).Replace('__CHANNEL__', $channel).Replace('__OUTPUT__', $output)
  [IO.File]::WriteAllText($script, $source, [Text.UTF8Encoding]::new($true))
  & $MakeNSIS /INPUTCHARSET UTF8 /V4 $script
  if ($LASTEXITCODE -ne 0) { throw "Actual NSIS compile failed for $channel" }
  if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw "NSIS output missing" }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($output))).Replace('-', '')
  } finally { $hasher.Dispose() }
  Write-Output "NSIS_COMPILED $channel $hash"
}
# These synthetic installers are compiler outputs only. Never launch them.
