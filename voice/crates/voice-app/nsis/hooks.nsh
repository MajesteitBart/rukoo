; Rukoo Voice's additions to Tauri's NSIS installer (tauri.conf.json: bundle > windows > nsis > installerHooks).
; Tauri includes this file near the top of its script, before it defines ${PRODUCTNAME} and the pages, so the
; product name is spelled out here: keep it equal to productName in tauri.conf.json. The texts are in English.nsh
; and Dutch.nsh next to this file.

!include LogicLib.nsh

!define VOICE_PRODUCT "Rukoo Voice"
; Voice's data folder: meetings, models and settings (voice-core's paths). Neither the installer nor the uninstaller
; puts files there or deletes anything in it.
!define VOICE_DATA "$LOCALAPPDATA\${VOICE_PRODUCT}"
; Where the program goes instead, next to Rukoo Mail's %LOCALAPPDATA%\Programs\Rukoo Mail.
!define VOICE_PROGRAM "$LOCALAPPDATA\Programs\${VOICE_PRODUCT}"

; Tauri installs a per-user app in $LOCALAPPDATA\<product name>, which is Voice's data folder. Its .onInit picks
; that folder (or the one a previous install used); .onGUIInit runs after it, so the directory page offers the
; Programs folder instead. A silent install skips .onGUIInit, so NSIS_HOOK_PREINSTALL moves the folder as well.
!define MUI_CUSTOMFUNCTION_GUIINIT VoiceOfferProgramsFolder
Function VoiceOfferProgramsFolder
  ${If} $INSTDIR == "${VOICE_DATA}"
    StrCpy $INSTDIR "${VOICE_PROGRAM}"
  ${EndIf}
FunctionEnd

; The uninstaller says that the data folder stays.
!define MUI_UNCONFIRMPAGE_TEXT_TOP "$(voiceKeepsData)"

; Stops the installer or the uninstaller while the recorder in the install folder runs. The recorder outlives the app
; on purpose, so a meeting keeps recording when the app quits; replacing or deleting its exe now would fail halfway,
; and stopping it would end the meeting. It asks the Restart Manager about that one file, as Tauri's
; CheckIfAppIsRunning does for the app, and never stops the process.
!macro VOICE_REFUSE_WHILE_RECORDING message
  Push $R1
  Push $R0
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $R1 0
  !insertmacro RestartManager_StartSession $R0
  ${If} $R0 != ""
    !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\rukoo-voice-recorder.exe"
    ${If} $0 = 0
      System::Call 'RSTRTMGR::RmGetList(p R0, *i .r1, *i .r2, p 0, *i .r3) i .r0'
      ; ERROR_MORE_DATA: at least one process runs that exe.
      ${IfThen} $0 = 234 ${|} StrCpy $R1 1 ${|}
    ${EndIf}
    !insertmacro RestartManager_EndSession $R0
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $R0
  ${If} $R1 = 1
    MessageBox MB_ICONEXCLAMATION|MB_OK "${message}" /SD IDOK
    Abort "${message}"
  ${EndIf}
  Pop $R1
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${If} $INSTDIR == "${VOICE_DATA}"
    StrCpy $INSTDIR "${VOICE_PROGRAM}"
    SetOutPath $INSTDIR
    DetailPrint "$(voiceMovedInstall)"
  ${EndIf}
  !insertmacro VOICE_REFUSE_WHILE_RECORDING "$(voiceRecordingInstall)"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro VOICE_REFUSE_WHILE_RECORDING "$(voiceRecordingUninstall)"
!macroend
