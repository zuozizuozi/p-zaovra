!include "LogicLib.nsh"
!macro channelDirectoryGuard
  ; Also protect an explicitly selected /D path. Never overwrite another channel.
  ${If} ${FileExists} "$INSTDIR\${ZAOVRA_OTHER_EXE_1}"
  ${OrIf} ${FileExists} "$INSTDIR\${ZAOVRA_OTHER_EXE_2}"
    MessageBox MB_OK|MB_ICONSTOP "This folder contains another Zaovra channel. Choose a separate installation folder." /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro customInit
  !insertmacro channelDirectoryGuard
!macroend

!macro customUnInit
  !insertmacro channelDirectoryGuard
!macroend

!macro customUnInstall
  ; A newer installation may own this same channel's scheme. Delete only when
  ; the command still targets this exact installation; never touch another scheme.
  ReadRegStr $R0 HKCU "Software\Classes\${ZAOVRA_SCHEME}\shell\open\command" ""
  ${If} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ${OrIf} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
    DeleteRegKey HKCU "Software\Classes\${ZAOVRA_SCHEME}"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
; The assisted directory picker runs after customInit. Recheck its selection
; before Next is enabled; silent /D installs remain guarded by customInit.
Function .onVerifyInstDir
  ${If} ${FileExists} "$INSTDIR\${ZAOVRA_OTHER_EXE_1}"
  ${OrIf} ${FileExists} "$INSTDIR\${ZAOVRA_OTHER_EXE_2}"
    Abort
  ${EndIf}
FunctionEnd
!endif
