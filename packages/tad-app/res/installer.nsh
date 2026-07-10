; Custom NSIS install steps for Tads.
;
; Without a DPI-aware manifest Windows bitmap-stretches the installer window
; on high-DPI displays, so it renders blurry on 4K screens. The bundled NSIS
; (3.0.4.1) predates ManifestDPIAwareness/PerMonitorV2, so system-DPI aware
; is the best available. Applies to the uninstaller too.
ManifestDPIAware true
;
; electron-builder's fileAssociations config already sets each extension's
; per-user default ProgId (with a *_backup of any previous value). Windows
; 10/11 additionally require an Applications registration with SupportedTypes
; plus OpenWithProgids entries for an app to reliably appear in Explorer's
; "Open with" list when another app owns the extension default. The ProgId
; names below must match the fileAssociations `name` values in package.json —
; electron-builder uses the name verbatim as the registry file class.

!macro tadsRegisterExt EXT PROGID
  WriteRegStr SHCTX "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${EXT}" ""
!macroend

!macro tadsUnregisterExt EXT PROGID
  DeleteRegValue SHCTX "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}"
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Tads"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro tadsRegisterExt ".parquet" "Parquet files"
  !insertmacro tadsRegisterExt ".csv" "Comma Separated Values"
  !insertmacro tadsRegisterExt ".tsv" "Tab Separated Values"
  !insertmacro tadsRegisterExt ".tad" "Tad Saved Workspace"
  !insertmacro tadsRegisterExt ".sqlite" "Sqlite files"
  !insertmacro tadsRegisterExt ".duckdb" "DuckDb files"
  ; SHCNE_ASSOCCHANGED so Explorer picks up the new handler without a restart
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro tadsUnregisterExt ".parquet" "Parquet files"
  !insertmacro tadsUnregisterExt ".csv" "Comma Separated Values"
  !insertmacro tadsUnregisterExt ".tsv" "Tab Separated Values"
  !insertmacro tadsUnregisterExt ".tad" "Tad Saved Workspace"
  !insertmacro tadsUnregisterExt ".sqlite" "Sqlite files"
  !insertmacro tadsUnregisterExt ".duckdb" "DuckDb files"
  DeleteRegKey SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend
