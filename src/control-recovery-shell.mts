// Bash 3.2 primitives. All operation failures remain nonterminal; no command
// reads coordination databases. Generated plans pass data only as quoted argv.
export const recoveryShell = String.raw`
set -u
set -o pipefail
umask 077
export LC_ALL=C
STATUS=0
FAILED=0
RC_OK=1
REOPEN=0
WORK=''
error() { printf '[rollback] LEFT %s\n' "$*" >&2; FAILED=1; STATUS=1; }
sha() { /usr/bin/shasum -a 256 "$1" | /usr/bin/cut -d' ' -f1; }
verify_blob() {
  local got
  [ -f "$1" ] && [ ! -L "$1" ] || { error "missing physical backup $1"; exit 1; }
  got=$(sha "$1") && [ "$got" = "$2" ] || { error "backup hash mismatch $1"; exit 1; }
}
# State comparison: 0 equal, 1 different, 2 failed inspection.
matches() {
  local target="$1" kind="$2" want="$3" link="$4" bytes="$5" mode="$6" got permissions
  case "$kind" in
    absent) got=$(jxa kind "$target") || return 2
      [ "$got" = absent ]; return $? ;;
    symlink) [ -L "$target" ] || return 1
      got=$(/usr/bin/readlink "$target") || return 2
      [ "$got" = "$link" ]; return $? ;;
    file) [ -f "$target" ] && [ ! -L "$target" ] || return 1
      got=$(sha "$target") || return 2
      permissions=$(/usr/bin/stat -f '%Lp' "$target") || return 2
      [ "$got" = "$want" ] && [ "$permissions" = "$mode" ]; return $? ;;
    *) return 2 ;;
  esac
}
apply_state() {
  local target="$1" kind="$2" want="$3" link="$4" bytes="$5" mode="$6" tmp
  if [ "$kind" = absent ]; then /bin/rm -f "$target" || return 1
  else
    tmp=$(/usr/bin/mktemp "$target.anyengine-off.XXXXXX") || return 1
    if [ "$kind" = file ]; then
      /usr/bin/install -m "$mode" "$bytes" "$tmp" || { /bin/rm -f "$tmp"; return 1; }
    else
      /bin/rm -f "$tmp" && /bin/ln -s "$link" "$tmp" || return 1
    fi
    /bin/mv -fh "$tmp" "$target" || { /bin/rm -f "$tmp"; return 1; }
  fi
  /bin/sync || return 1
  matches "$target" "$kind" "$want" "$link" "$bytes" "$mode"
}
restore() {
  local target="$1" role="$2" code known=0 current_mode tmp changed=0
  shift 2
  local -a base=("$1" "$2" "$3" "$4" "$5"); shift 5
  local -a a=("$1" "$2" "$3" "$4" "$5"); shift 5
  local -a b=("$1" "$2" "$3" "$4" "$5"); shift 5
  local -a c=("$1" "$2" "$3" "$4" "$5")
  if [ "$role" != rc ] && [ "$RC_BLOCKED" != 0 ]; then error "KEPT $target: rc recovery needs retry"; return; fi
  [ "$role" != rc ] || RC_OK=0
  matches "$target" "§{base[@]}"; code=$?
  if [ "$code" = 0 ]; then [ "$role" != rc ] || RC_OK=1; printf '[rollback] already %s\n' "$target"; return; fi
  if [ "$code" = 2 ]; then error "inspection failed $target"; [ "$role" != rc ] || RC_OK=0; return; fi
  for generation in a b c; do
    case "$generation" in a) matches "$target" "§{a[@]}";; b) matches "$target" "§{b[@]}";; c) matches "$target" "§{c[@]}";; esac
    code=$?
    if [ "$code" = 2 ]; then error "inspection failed $target"; [ "$role" != rc ] || RC_OK=0; return; fi
    [ "$code" != 0 ] || known=1
  done
  if [ "$known" = 1 ]; then
    if apply_state "$target" "§{base[@]}"; then [ "$role" != rc ] || RC_OK=1; printf '[rollback] restored %s\n' "$target"
    else error "restore failed $target"; [ "$role" != rc ] || RC_OK=0; fi
    return
  fi
  if [ "$role" = claude ]; then error "edited Claude file $target"; return; fi
  # A unique evidenced hunk preserves current operator edits and permissions.
  if [ "§{base[0]}" = file ] && [ -f "$target" ] && [ ! -L "$target" ]; then
    current_mode=$(/usr/bin/stat -f '%Lp' "$target") || { error "stat $target"; return; }
    local -a variants=()
    [ "§{a[0]}" != file ] || [ "§{a[4]}" != "$current_mode" ] || variants[§{#variants[@]}]="§{a[3]}"
    [ "§{b[0]}" != file ] || [ "§{b[4]}" != "$current_mode" ] || variants[§{#variants[@]}]="§{b[3]}"
    [ "§{c[0]}" != file ] || [ "§{c[4]}" != "$current_mode" ] || variants[§{#variants[@]}]="§{c[3]}"
    tmp=$(/usr/bin/mktemp "$target.anyengine-off.XXXXXX") || { error "create recovery output $target"; return; }
    if [ "§{#variants[@]}" -gt 0 ] && jxa hunk "$target" "§{base[3]}" "§{variants[@]}" > "$tmp"; then
      if ! /usr/bin/cmp -s "$target" "$tmp"; then
        /bin/chmod "$current_mode" "$tmp" && /bin/mv -fh "$tmp" "$target" && /bin/sync || { error "hunk write $target"; [ "$role" != rc ] || RC_OK=0; return; }
        changed=1
      fi
      /bin/rm -f "$tmp" || { error "hunk cleanup $target"; return; }
      [ "$role" != rc ] || RC_OK=1
      printf '[rollback] preserved operator edits in %s\n' "$target"
      if [ "$role" = rc ] && [ "$changed" = 1 ]; then RC_OK=2; error "rc block reverted; dependent files KEPT until durable-command retry"; fi
      return
    fi
    /bin/rm -f "$tmp" || error "hunk cleanup $target"
  fi
  error "$target changed since AnyEngine wrote it; evidence retained"
  [ "$role" != rc ] || RC_OK=0
}
job_state() {
  local label="$1" uid code expected actual
  uid=$(/usr/bin/id -u) || return 2
  "$LAUNCHCTL" print "gui/$uid/$label" > "$WORK/job-out" 2> "$WORK/job-error"
  code=$?
  if [ "$code" = 0 ] && [ ! -s "$WORK/job-error" ]; then return 0; fi
  [ "$code" = 113 ] && [ ! -s "$WORK/job-out" ] || return 2
  expected=$(printf 'Bad request.\nCould not find service "%s" in domain for user gui: %s' "$label" "$uid")
  actual=$(/bin/cat "$WORK/job-error")
  [ "$actual" = "$expected" ] || return 2
  "$LAUNCHCTL" print "gui/$uid" > "$WORK/domain-out" 2> "$WORK/domain-error" || return 2
  [ ! -s "$WORK/domain-error" ] || return 2
  return 1
}
stop_job() {
  job_state "$1"; local code=$? uid attempt=0
  if [ "$code" = 1 ]; then printf '[rollback] job already absent %s\n' "$1"; return; fi
  if [ "$code" != 0 ]; then error "cannot inspect job $1"; return; fi
  uid=$(/usr/bin/id -u) || { error 'cannot inspect job domain'; return; }
  "$LAUNCHCTL" bootout "gui/$uid/$1" > "$WORK/job-stop-out" 2> "$WORK/job-stop-error"
  code=$?
  if [ -s "$WORK/job-stop-error" ]; then
    /bin/cat "$WORK/job-stop-error" >&2
    if [ "$code" = 0 ]; then error "bootout $1 failed; error diagnostic"; return; fi
  fi
  # A service can disappear between inspection and bootout. Only the exact
  # known missing-service result plus a readable same domain proves completion.
  job_state "$1"; code=$?
  # launchd can acknowledge bootout before its service entry disappears.
  while [ "$code" = 0 ] && [ "$attempt" -lt 60 ]; do
    /bin/sleep 0.5
    attempt=$((attempt+1))
    job_state "$1"; code=$?
  done
  [ "$code" = 1 ] || error "bootout $1 failed; job absence not proven"
}
restart_job() {
  job_state "$1"; local code=$? uid
  if [ "$code" = 2 ]; then error "cannot inspect prior job $1"; return; fi
  uid=$(/usr/bin/id -u) || { error 'cannot inspect job domain'; return; }
  if [ "$code" = 0 ]; then
    "$LAUNCHCTL" kickstart -k "gui/$uid/$1" > "$WORK/job-update-out" 2> "$WORK/job-update-error"
    code=$?
  else
    if [ "$#" -lt 2 ]; then error "missing recorded prior plist $1"; return; fi
    if [ ! -f "$2" ] && [ ! -L "$2" ]; then error "prior plist not restored $1"; return; fi
    "$LAUNCHCTL" bootstrap "gui/$uid" "$2" > "$WORK/job-update-out" 2> "$WORK/job-update-error"
    code=$?
  fi
  [ "$code" = 0 ] && [ ! -s "$WORK/job-update-error" ] || error "restart prior job $1 failed"
}
restore_shared() {
  local target="$1" pick="$2" rows="$3" tmp original='absent' picked='absent' mode=600 kind
  kind=$(jxa kind "$target") || { error "inspect config"; return; }
  case "$kind" in
    NSFileTypeRegular) original=$(sha "$target") || { error "read config"; return; }; mode=$(/usr/bin/stat -f '%Lp' "$target") || { error "stat config"; return; };;
    absent) ;;
    *) error 'config must be a regular file'; return;;
  esac
  kind=$(jxa kind "$pick") || { error "inspect pick"; return; }
  case "$kind" in
    NSFileTypeRegular) picked=$(sha "$pick") || { error "read pick"; return; };;
    absent) ;;
    *) error 'pick must be a regular file'; return;;
  esac
  tmp=$(/usr/bin/mktemp "$target.anyengine-off.XXXXXX") || { error "create config output"; return; }
  if ! jxa toml "$target" "$pick" "$rows" > "$tmp"; then /bin/rm -f "$tmp"; error "unsupported config/pick; retained"; return; fi
  if [ "$original" = absent ]; then
    [ ! -e "$target" ] && [ ! -L "$target" ] || { error "config appeared"; /bin/rm -f "$tmp"; return; }
  else [ "$(sha "$target")" = "$original" ] || { error "config changed"; /bin/rm -f "$tmp"; return; }; fi
  if [ "$picked" = absent ]; then
    [ ! -e "$pick" ] && [ ! -L "$pick" ] || { error "pick appeared"; /bin/rm -f "$tmp"; return; }
  else [ "$(sha "$pick")" = "$picked" ] || { error "pick changed"; /bin/rm -f "$tmp"; return; }; fi
  if /usr/bin/cmp -s "$target" "$tmp"; then
    /bin/rm -f "$tmp" || { error "config temp cleanup"; return; }
    printf '[rollback] kept the model line of %s\n' "$target"
  else
    /bin/chmod "$mode" "$tmp" && /bin/mv -fh "$tmp" "$target" && /bin/sync || { error "config write failed; pick retained"; return; }
  fi
  /bin/rm -f "$pick" && /bin/sync || error "pick removal failed"
}
clean_cache() {
  local cache="$CODEX_HOME/models_cache.json" backup="$1/models_cache.json" state before after
  state=$(jxa cache "$cache") || { error "cache evidence retained"; return; }
  [ "$state" = owned ] || return 0
  before=$(/usr/bin/stat -f '%d:%i:%z:%m:%c' "$cache") || { error "cache stat"; return; }
  [ ! -e "$backup" ] && [ ! -L "$backup" ] || { error "cache backup already exists; retain both"; return; }
  (set -o noclobber; /bin/cat "$cache" > "$backup") && /bin/sync || { error "cache backup failed; retain evidence"; return; }
  after=$(/usr/bin/stat -f '%d:%i:%z:%m:%c' "$cache") || { error "cache stat"; return; }
  [ "$before" = "$after" ] && /usr/bin/cmp -s "$cache" "$backup" || { error "cache changed; retain both"; return; }
  /bin/rm "$cache" && /bin/sync || error "cache removal failed; retain backup"
}
`.replaceAll('§{', '${')
