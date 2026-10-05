// The configured application must be positively down at each after-quit entry.
// A signal after quit attempts reopen through EXIT; SIGKILL leaves durable retry.
export const recoveryLifecycle = String.raw`
inspect_app() {
  local executable pattern code output
  "$PLUTIL" -extract CFBundleExecutable raw -o - "$APP/Contents/Info.plist" > "$WORK/executable" 2> "$WORK/error"
  code=$?
  [ "$code" = 0 ] && [ ! -s "$WORK/error" ] || return 2
  executable=$(/bin/cat "$WORK/executable")
  case "$executable" in ''|.|..|*/*|*$'\n'*|*$'\r'*) return 2;; esac
  pattern=$(printf '%s' "$APP/Contents/MacOS/$executable" | /usr/bin/sed 's/[][\\.^$*+?(){}|]/\\&/g') || return 2
  "$PGREP" -f "^$pattern([[:space:]]|$)" > "$WORK/pids" 2> "$WORK/error"
  code=$?
  [ ! -s "$WORK/error" ] || return 2
  if [ "$code" = 1 ] && [ ! -s "$WORK/pids" ]; then return 1; fi
  [ "$code" = 0 ] && [ -s "$WORK/pids" ] || return 2
  /usr/bin/awk 'BEGIN { ok=1 } !/^[0-9]+$/ || $0+0<=0 {ok=0} END {exit ok ? 0 : 1}' "$WORK/pids" || return 2
  return 0
}
confirmed_down() {
  inspect_app; local code=$?
  [ "$code" = 1 ] && return 0
  error "configured app is running or unknown; dependent jobs/config/cache stay; retry $RECOVER"
  return 1
}
staged_notice() {
  local sparkle="$HOME/Library/Caches/$BUNDLE/org.sparkle-project.Sparkle"
  if [ -n "$(/bin/ls -A "$sparkle/Installation" "$sparkle/PersistentDownloads" 2>/dev/null)" ] ||
     "$LAUNCHCTL" print "gui/$(/usr/bin/id -u)/$BUNDLE-sparkle-updater" >/dev/null 2>&1; then
    printf '[anyengine-off] an app update is staged; this restart may install it\n'
  fi
}
quit_app() {
  local code count=0 wait="$QUIT_WAIT" script
  case "$wait" in ''|*[!0-9]*) error 'invalid quit wait'; return 1;; esac
  [ "§{#wait}" -le 4 ] && [ "$wait" -le 3600 ] || { error 'invalid quit wait'; return 1; }
  inspect_app; code=$?
  if [ "$code" = 2 ]; then error 'configured app state unknown'; return 1; fi
  if [ "$code" = 1 ]; then REOPEN=1; return 0; fi
  staged_notice
  script=$(printf '%s' "$APP" | /usr/bin/sed 's/\\/\\\\/g; s/"/\\"/g') || { error 'app quote'; return 1; }
  "$OSASCRIPT" -e "tell application \"$script\" to quit" || { error 'app quit failed'; return 1; }
  while :; do
    inspect_app; code=$?
    if [ "$code" = 1 ]; then REOPEN=1; return 0; fi
    if [ "$code" = 2 ]; then error 'configured app state unknown after quit'; return 1; fi
    [ "$count" -lt "$((10#$wait * 2))" ] || break
    /bin/sleep 0.5
    count=$((count+1))
  done
  error "configured app did not quit; router kept running; retry $RECOVER"
  return 1
}
reopen_app() {
  if [ "$REOPEN" = 1 ]; then
    REOPEN=0
    "$OPEN" -a "$APP" || error 'app reopen failed; recovery retained'
  fi
}
finish_exit() {
  local previous=$?
  trap - EXIT
  [ "$previous" = 0 ] || STATUS=1
  reopen_app
  if [ -n "$WORK" ]; then /bin/rm -rf "$WORK" || STATUS=1; fi
  exit "$STATUS"
}
trap finish_exit EXIT
trap 'STATUS=1; exit 1' HUP INT TERM
MODE=all
SELECTOR="$DIRECT"
BASELINE=initial
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --router-only) [ "$DIRECT" = all ] || { error 'direct entry has one layer'; exit 2; }; SELECTOR=router;;
    --last-good) BASELINE=last-good;;
    --no-restart) RESTART=0;;
    --files-only|--copy-only|--after-quit) MODE="$arg";;
    *) error 'usage: anyengine-off [--router-only] [--last-good] [--no-restart]'; exit 2;;
  esac
done
# mktemp is outside target trees; all evidence is validated before mutations.
WORK=$(/usr/bin/mktemp -d "$RECOVERY/.run.XXXXXX") || { error 'cannot create recovery scratch'; exit 1; }
if ! jxa plan "$ROOT" "$SELECTOR" "$BASELINE" > "$WORK/plan"; then error 'journal/evidence validation refused'; exit 1; fi
# The only evaluated text is our quoted code generator's validated live plan.
. "$WORK/plan"
[ "$JOURNAL_ABSENT" != 1 ] || exit 0
M2_RETIRE=0
if [ "$DIRECT" = all ] && [ "$MODE" = all ] && [ "$BASELINE" = initial ]; then
  jxa m2-retirement-admit "$ROOT" > "$WORK/m2-receipt" || { error 'M2 retirement authority refused'; exit 1; }
  [ "$(/bin/cat "$WORK/m2-receipt")" = null ] || M2_RETIRE=1
fi
if [ "$MODE" != --after-quit ]; then
  for ((i=0; i<§{#LAYER_DIRS[@]}; i++)); do
    if "files_$i"; then FILE_OK[i]=1; else FILE_OK[i]=0; STATUS=1; [ "§{LAYER_NAMES[i]}" != claude-code ] || exit 1; fi
  done
fi
if [ "$MODE" = --files-only ] || [ "$MODE" = --copy-only ]; then exit "$STATUS"; fi
if [ "$MODE" = --after-quit ] || [ "$RESTART" = 0 ]; then confirmed_down || exit 1
else quit_app || exit 1; fi
for ((i=0; i<§{#LAYER_DIRS[@]}; i++)); do
  if [ "$MODE" != --after-quit ] && [ "§{FILE_OK[i]}" != 1 ]; then continue; fi
  # Recheck even direct --after-quit; a flag is never evidence of app exit.
  confirmed_down || break
  if "after_$i"; then
    if [ "$MODE" != --after-quit ] && [ "$BASELINE" = initial ]; then
      marker="§{LAYER_DIRS[i]}/POPPED"
      (set -o noclobber; : > "$marker") && /bin/sync || error "cannot publish POPPED $marker"
    fi
  else STATUS=1; fi
done
reopen_app
retire_m2() {
  [ "$M2_RETIRE" = 1 ] || return 0
  job_state dev.anyengine.router; local route_state=$?
  [ "$route_state" = 1 ] || { error 'router job remains or is unknown; retain M2 pin'; return 1; }
  jxa m2-retirement-finish "$ROOT" "$WORK/m2-receipt" && /bin/sync || { error 'M2 retirement refused; recovery evidence retained'; return 1; }
}
if [ "$STATUS" = 0 ] && [ "$M2_RETIRE" = 1 ] && [ "$SELECTOR" = router ]; then
  jxa plan "$ROOT" "$SELECTOR" initial > "$WORK/m2-terminal" || { error 'terminal routing authority changed'; exit 1; }
  . "$WORK/m2-terminal"
  retire_m2 || exit 1
fi
# Full terminal recovery alone retires journal/pins. Last-good remains for
# the Node owner to verify postflight and finishUpgrade('recovered').
if [ "$STATUS" = 0 ] && [ "$MODE" = all ] && [ "$BASELINE" = initial ] && [ "$SELECTOR" = all ]; then
  # Re-admit live authority and physical markers before dropping any pins.
  jxa plan "$ROOT" all initial > "$WORK/terminal" || { error 'terminal evidence changed'; exit 1; }
  . "$WORK/terminal"
  if [ "$TOTAL_ACTIVE" != 0 ]; then error 'layers remain active'; exit 1; fi
  public_kind=$(jxa kind "$PUBLIC") || { error 'cannot inspect public entry'; exit 1; }
  if [ "§{#PUBLIC_BASE[@]}" != 0 ]; then
    # A recorded original is kept, including its kind, mode and link target.
    matches "$PUBLIC" "§{PUBLIC_BASE[@]}" || { error 'original public entry changed or unknown; retained'; exit 1; }
  elif [ "$public_kind" != absent ]; then
    matches "$PUBLIC" file "$PUBLIC_SHA" '' '' 755 || { error 'public recovery entry changed; retained'; exit 1; }
    /bin/rm "$PUBLIC" && /bin/sync || { error 'public entry removal failed'; exit 1; }
  fi
  retire_m2 || exit 1
  /bin/rm -f "$ROOT/state/layers.json" && /bin/sync || { error 'journal removal failed'; exit 1; }
  # Private tools/instructions stay idle. With a positively absent journal,
  # later entry returns before any app, public file, config or job action.

fi
exit "$STATUS"
`.replaceAll('§{', '${')
