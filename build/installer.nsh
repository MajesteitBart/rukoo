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
  ${endIf}
!macroend
