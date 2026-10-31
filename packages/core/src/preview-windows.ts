export * as PreviewWindows from "./preview-windows"

export const script = `
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('PreviewNative'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$module=$assembly.DefineDynamicModule('PreviewNative')
$type=$module.DefineType('PreviewNative',[Reflection.TypeAttributes]::Public)
function Import-Native([string]$name,[Type]$result,[Type[]]$parameters) {
 $method=$type.DefinePInvokeMethod($name,'kernel32.dll',[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$result,$parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
 $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
Import-Native GetCurrentProcess ([IntPtr]) @()
Import-Native OpenProcess ([IntPtr]) @([uint32],[bool],[uint32])
Import-Native GetProcessTimes ([bool]) @([IntPtr],[IntPtr],[IntPtr],[IntPtr],[IntPtr])
Import-Native CreateProcessW ([bool]) @([IntPtr],[Text.StringBuilder],[IntPtr],[IntPtr],[bool],[uint32],[IntPtr],[string],[IntPtr],[IntPtr])
Import-Native CreateJobObjectW ([IntPtr]) @([IntPtr],[IntPtr])
Import-Native SetInformationJobObject ([bool]) @([IntPtr],[int],[IntPtr],[uint32])
Import-Native AssignProcessToJobObject ([bool]) @([IntPtr],[IntPtr])
Import-Native ResumeThread ([uint32]) @([IntPtr])
Import-Native CloseHandle ([bool]) @([IntPtr])
Import-Native WaitForSingleObject ([uint32]) @([IntPtr],[uint32])
Import-Native GetExitCodeProcess ([bool]) @([IntPtr],[IntPtr])
Import-Native QueryInformationJobObject ([bool]) @([IntPtr],[int],[IntPtr],[uint32],[IntPtr])
Import-Native TerminateJobObject ([bool]) @([IntPtr],[uint32])
Import-Native TerminateProcess ([bool]) @([IntPtr],[uint32])
Import-Native CreateFileW ([IntPtr]) @([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr])
Import-Native GetLastError ([uint32]) @()
$null=$type.CreateType()
function Native-Error { throw [ComponentModel.Win32Exception]::new([int][PreviewNative]::GetLastError()) }
function Native-Buffer([int]$size) { $memory=[Runtime.InteropServices.Marshal]::AllocHGlobal($size); [Runtime.InteropServices.Marshal]::Copy([byte[]]::new($size),0,$memory,$size); return $memory }
function Native-Launch([string]$line,[string]$directory,[bool]$independent,[int]$deadline,[string]$log) {
 if([IntPtr]::Size -ne 8){throw 'Persistent previews require 64-bit Windows'}
 $si=Native-Buffer 104; $pi=Native-Buffer 24; $limits=Native-Buffer 144; $sa=Native-Buffer 24
 $processHandle=[IntPtr]::Zero; $thread=[IntPtr]::Zero; $job=[IntPtr]::Zero; $outputHandle=[IntPtr]::Zero; $inputHandle=[IntPtr]::Zero
 try {
  [Runtime.InteropServices.Marshal]::WriteInt32($si,104); [Runtime.InteropServices.Marshal]::WriteInt32($si,60,1)
  if(!$independent){
   [Runtime.InteropServices.Marshal]::WriteInt32($sa,24); [Runtime.InteropServices.Marshal]::WriteInt32($sa,16,1)
   $outputHandle=[PreviewNative]::CreateFileW($log,4,3,$sa,4,0,[IntPtr]::Zero)
   $inputHandle=[PreviewNative]::CreateFileW('NUL',2147483648,3,$sa,3,0,[IntPtr]::Zero)
   if($outputHandle.ToInt64() -eq -1 -or $inputHandle.ToInt64() -eq -1){Native-Error}
   [Runtime.InteropServices.Marshal]::WriteInt32($si,60,257)
   [Runtime.InteropServices.Marshal]::WriteIntPtr($si,80,$inputHandle); [Runtime.InteropServices.Marshal]::WriteIntPtr($si,88,$outputHandle); [Runtime.InteropServices.Marshal]::WriteIntPtr($si,96,$outputHandle)
  }
  $flags=20; if($independent){$flags=$flags -bor 16777216}
  if(!$independent){
   $job=[PreviewNative]::CreateJobObjectW([IntPtr]::Zero,[IntPtr]::Zero); [Runtime.InteropServices.Marshal]::WriteInt32($limits,16,8192)
   if($job -eq [IntPtr]::Zero -or ![PreviewNative]::SetInformationJobObject($job,9,$limits,144) -or ![PreviewNative]::AssignProcessToJobObject($job,[PreviewNative]::GetCurrentProcess())){Native-Error}
   # Joining before CreateProcess makes child membership atomic. Keep the sole
   # Job handle until the supervisor exits, after it writes its durable result.
   $script:PreviewJob=$job
  }
  if(![PreviewNative]::CreateProcessW([IntPtr]::Zero,[Text.StringBuilder]::new($line),[IntPtr]::Zero,[IntPtr]::Zero,!$independent,$flags,[IntPtr]::Zero,$directory,$si,$pi)){Native-Error}
  $processHandle=[Runtime.InteropServices.Marshal]::ReadIntPtr($pi,0); $thread=[Runtime.InteropServices.Marshal]::ReadIntPtr($pi,8); $processID=[Runtime.InteropServices.Marshal]::ReadInt32($pi,16)
  $clock=[Diagnostics.Stopwatch]::StartNew()
  $null=[PreviewNative]::ResumeThread($thread)
  if($independent){return $processID}
  $wait=[uint32]::MaxValue; if($deadline -gt 0){$wait=[uint32]$deadline}
  if([PreviewNative]::WaitForSingleObject($processHandle,$wait) -eq 258){[IO.File]::WriteAllText([IO.Path]::Combine([IO.Path]::GetDirectoryName($log),'result.json'),'124');$null=[PreviewNative]::TerminateJobObject($job,124); $null=[PreviewNative]::WaitForSingleObject($processHandle,5000);return 124}
  if(![PreviewNative]::GetExitCodeProcess($processHandle,$limits)){Native-Error};$code=[Runtime.InteropServices.Marshal]::ReadInt32($limits)
  while($true){
   if(![PreviewNative]::QueryInformationJobObject($job,1,$limits,48,[IntPtr]::Zero)){Native-Error}
   if([Runtime.InteropServices.Marshal]::ReadInt32($limits,40) -le 1){break}
   if($deadline -gt 0 -and $clock.ElapsedMilliseconds -ge $deadline){[IO.File]::WriteAllText([IO.Path]::Combine([IO.Path]::GetDirectoryName($log),'result.json'),'124');$null=[PreviewNative]::TerminateJobObject($job,124);return 124}
   [Threading.Thread]::Sleep(50)
  }
  return $code
 } finally {
  foreach($handle in @($thread,$processHandle,$outputHandle,$inputHandle)){if($handle -ne [IntPtr]::Zero -and $handle.ToInt64() -ne -1){$null=[PreviewNative]::CloseHandle($handle)}}
  foreach($memory in @($si,$pi,$limits,$sa)){[Runtime.InteropServices.Marshal]::FreeHGlobal($memory)}
 }
}`
