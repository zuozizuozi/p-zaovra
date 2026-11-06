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

!macro customInstallMode
  ; No "who should this be installed for" page. Keep whatever initMultiUser chose:
  ; an existing per-machine installation is upgraded in place (UAC), anything else
  ; installs for the current user into the channel's default folder.
  ${If} $installMode == "all"
    StrCpy $isForceMachineInstall "1"
  ${Else}
    StrCpy $isForceCurrentInstall "1"
  ${EndIf}
!macroend

; No finish page: the progress page closes by itself and the app starts.
!macro customFinishPage
!macroend

!macro customInstall
  ; Silent updates (/S --force-run) are relaunched by the builder's own install section.
  ${IfNot} ${Silent}
    SetAutoClose true
    HideWindow
    ${If} ${isUpdated}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
    ${Else}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
    ${EndIf}
  ${EndIf}
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
; Installers have no directory page; this only matters if one is ever re-enabled.
; Silent and /D installs remain guarded by customInit.
Function .onVerifyInstDir
  ${If} ${FileExists} "$INSTDIR\${ZAOVRA_OTHER_EXE_1}"
  ${OrIf} ${FileExists} "$INSTDIR\${ZAOVRA_OTHER_EXE_2}"
    Abort
  ${EndIf}
FunctionEnd
!endif
