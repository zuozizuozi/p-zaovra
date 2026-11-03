export function archiveInspection(file: string) {
  return `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$p='${file.replaceAll("'", "''")}'
$z=[System.IO.Compression.ZipFile]::OpenRead($p)
$z.Entries | Select-Object FullName,Length | Format-Table -AutoSize
$e=$z.Entries | Where-Object {$_.FullName -eq 'xl/sharedStrings.xml'}
if($e){$sr=New-Object System.IO.StreamReader($e.Open()); $t=$sr.ReadToEnd(); $sr.Close(); Write-Output ('SHAREDSTRINGS LEN: '+$t.Length)}
$z.Dispose()`
}
