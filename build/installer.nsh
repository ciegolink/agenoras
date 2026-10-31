; Registers Agenoras as a mail app, so Windows lists it under Settings → Default apps (Email / MAILTO).
; Windows 10/11 never lets an app make itself the default: the user picks it there.

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\Agenoras.mailto" "" "URL:MailTo Protocol"
  WriteRegStr SHCTX "Software\Classes\Agenoras.mailto" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\Agenoras.mailto\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Agenoras.mailto\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr SHCTX "Software\Clients\Mail\Agenoras" "" "Agenoras"
  WriteRegStr SHCTX "Software\Clients\Mail\Agenoras\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr SHCTX "Software\Clients\Mail\Agenoras\Capabilities" "ApplicationName" "Agenoras"
  WriteRegStr SHCTX "Software\Clients\Mail\Agenoras\Capabilities" "ApplicationDescription" "Mail, calendar, contacts and tasks"
  WriteRegStr SHCTX "Software\Clients\Mail\Agenoras\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Clients\Mail\Agenoras\Capabilities\URLAssociations" "mailto" "Agenoras.mailto"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Agenoras" "Software\Clients\Mail\Agenoras\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Agenoras"
  DeleteRegKey SHCTX "Software\Clients\Mail\Agenoras"
  DeleteRegKey SHCTX "Software\Classes\Agenoras.mailto"
!macroend
