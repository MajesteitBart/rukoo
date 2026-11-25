; Rukoo Mail's additions to the electron-builder installer (package.json: build.nsis.include).

; Where the mailto: registration lives (src/main/mailclient.js); a test of this file points it at a scratch key.
!ifndef RUKOO_MAIL_KEYS
  !define RUKOO_MAIL_KEYS "Software"
!endif

; Lets Windows offer Rukoo Mail for mailto: links and under "Open with" for .ics files right after installing, also
; when the app doesn't start then. The app that opens .ics files now stays the default.
; Like the app at startup (MailClient.refresh), it leaves a registration that starts another copy alone. The values
; match MailClient.values(); test/mailclient.test.js checks that they stay the same.
!macro customInstall
  Push $0
  ReadRegStr $0 HKCU "${RUKOO_MAIL_KEYS}\Classes\RukooMail.mailto\shell\open\command" ""
  ${if} $0 == ""
  ${orIf} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Classes\RukooMail.mailto" "" "URL:MailTo Protocol"
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Classes\RukooMail.mailto" "URL Protocol" ""
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Classes\RukooMail.mailto\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Classes\RukooMail.mailto\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Clients\Mail\Rukoo Mail" "" "Rukoo Mail"
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Clients\Mail\Rukoo Mail\Capabilities" "ApplicationName" "Rukoo Mail"
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Clients\Mail\Rukoo Mail\Capabilities" "ApplicationDescription" "Email, calendar and agent chat for Windows"
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Clients\Mail\Rukoo Mail\Capabilities\URLAssociations" "mailto" "RukooMail.mailto"
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\RegisteredApplications" "Rukoo Mail" "Software\Clients\Mail\Rukoo Mail\Capabilities"
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Classes\RukooMail.ics" "" "Calendar file"
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Classes\RukooMail.ics\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Classes\RukooMail.ics\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Classes\.ics\OpenWithProgids" "RukooMail.ics" ""
    WriteRegStr HKCU "${RUKOO_MAIL_KEYS}\Clients\Mail\Rukoo Mail\Capabilities\FileAssociations" ".ics" "RukooMail.ics"
  ${endIf}
  Pop $0
!macroend

; Settings > General > Open when you sign in (src/main/loginitem.js): Electron writes a Run value named after the app's
; AppUserModelID (APP_ID in src/main/main.js): the program in double quotes, which a path with a backslash always gets,
; then --start-hidden. Uninstalling removes it when its program is exactly this installation's, so Windows doesn't look
; for a program that is gone at every sign-in. An update keeps it: the new version installs at the same path.
; Only the Windows user who uninstalls: the uninstaller reaches that user's registry alone, so after an install for
; all users, others who turned it on keep their Run value, and may still see Rukoo Mail under Startup apps.
!macro rukooRemoveLoginItem
  Push $0
  Push $1
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "nl.bvdm.rukoo-mail"
  !insertmacro rukooRunProgram
  ${if} $1 == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "nl.bvdm.rukoo-mail"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "nl.bvdm.rukoo-mail"
  ${endIf}
  Pop $1
  Pop $0
!macroend

; The program of the Run value in $0, as $1: what stands between its first two double quotes, or "" when it doesn't
; start with one. Electron's always does. test/loginitem.test.js runs it when it finds makensis.
!macro rukooRunProgram
  Push $2
  StrCpy $1 ""
  StrCpy $2 $0 1
  ${if} $2 == '"'
    ; $2: the position of the closing quote.
    StrCpy $2 1
    ${do}
      StrCpy $1 $0 1 $2
      ${ifThen} $1 == '"' ${|} ${break} ${|}
      ${ifThen} $1 == "" ${|} ${break} ${|}
      IntOp $2 $2 + 1
    ${loop}
    ${if} $1 == '"'
      IntOp $2 $2 - 1
      StrCpy $1 $0 $2 1
    ${else}
      StrCpy $1 ""
    ${endIf}
  ${endIf}
  Pop $2
!macroend

; Removes that registration again when it starts this installation; one that starts a portable copy stays. An update
; runs the old version's uninstaller first; the registration stays then too.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $0
    ReadRegStr $0 HKCU "${RUKOO_MAIL_KEYS}\Classes\RukooMail.mailto\shell\open\command" ""
    ${if} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
      DeleteRegValue HKCU "${RUKOO_MAIL_KEYS}\RegisteredApplications" "Rukoo Mail"
      DeleteRegKey HKCU "${RUKOO_MAIL_KEYS}\Clients\Mail\Rukoo Mail"
      DeleteRegKey HKCU "${RUKOO_MAIL_KEYS}\Classes\RukooMail.mailto"
      DeleteRegKey HKCU "${RUKOO_MAIL_KEYS}\Classes\RukooMail.ics"
      DeleteRegValue HKCU "${RUKOO_MAIL_KEYS}\Classes\.ics\OpenWithProgids" "RukooMail.ics"
    ${endIf}
    Pop $0
    !insertmacro rukooRemoveLoginItem
  ${endIf}
!macroend
