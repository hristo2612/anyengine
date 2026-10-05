import { basename, dirname, join } from 'node:path'
import { absolute } from './control-layer-state.mjs'
import { m2RecoveryJxa } from './control-m2-recovery-jxa.mjs'
import { type M2Baseline, m2Paths, type RecoveryMilestone } from './control-m2-recovery-state.mjs'
import { m3RecoveryJxa } from './control-m3-recovery-jxa.mjs'
import { recoveryLifecycle } from './control-recovery-lifecycle.mjs'
import { recoveryShell } from './control-recovery-shell.mjs'
import { shellQuote } from './control-scripts.mjs'

export function m2Dispatcher(root: string, milestone: RecoveryMilestone = 'm2'): string {
  if (!absolute(root)) throw new Error('M2 recovery requires an absolute root')
  const script = `#!/bin/bash
set -u
set -o pipefail
umask 077
ROOT=${shellQuote(root)}
UID_NOW=$(/usr/bin/id -u) || exit 1
SCRIPT=$(/usr/bin/osascript -l JavaScript - "$ROOT" "$UID_NOW" <<'M2_POINTER_JXA'
ObjC.import('Foundation')
function run(args) {
  var fm=$.NSFileManager.defaultManager, root=args[0], uid=Number(args[1]), dir=root+'/recovery/m2'
  function own(path,type,mode) {
    var a=fm.attributesOfItemAtPathError($(path),null)
    if (a.isNil() || ObjC.unwrap(a.objectForKey($.NSFileType)) !== type || Number(ObjC.unwrap(a.objectForKey($.NSFileOwnerAccountID))) !== uid || (mode !== null && Number(ObjC.unwrap(a.objectForKey($.NSFilePosixPermissions))) !== mode)) throw new Error('invalid M2 recovery owner/path/mode')
  }
  [root,root+'/recovery',dir].forEach(function(p) { own(p,'NSFileTypeDirectory',p === root ? null : 448) })
  own(dir+'/current.json','NSFileTypeRegular',384)
  var data=$.NSData.dataWithContentsOfFile($(dir+'/current.json'))
  if (data.isNil() || Number(data.length) > 2000000) throw new Error('invalid M2 pointer size')
  var p=JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding)))
  if (!p || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(p.baselineId) || p.script !== dir+'/'+p.baselineId+'/recover.sh' || p.journal !== dir+'/'+p.baselineId+'/journal.json' || !/^[a-f0-9]{64}$/.test(p.scriptSha256)) throw new Error('invalid M2 pointer')
  own(dir+'/'+p.baselineId,'NSFileTypeDirectory',448); own(p.script,'NSFileTypeRegular',448); own(p.journal,'NSFileTypeRegular',384)
  return p.script+'\\n'+p.scriptSha256
}
M2_POINTER_JXA
) || exit 1
EXPECTED="\${SCRIPT##*$'\\n'}"
SCRIPT="\${SCRIPT%$'\\n'*}"
ACTUAL=$(/usr/bin/shasum -a 256 "$SCRIPT" | /usr/bin/cut -d' ' -f1) || exit 1
[ "$ACTUAL" = "$EXPECTED" ] || { printf 'M2 recovery script hash mismatch; preserve evidence\\n' >&2; exit 1; }
exec /bin/bash "$SCRIPT" "$@"
`
  return milestone === 'm3'
    ? script.replaceAll('recovery/m2', 'recovery/m3').replaceAll('M2', 'M3')
    : script
}

const primitives = recoveryShell
  .slice(0, recoveryShell.indexOf('\nrestore_shared()'))
  .replace(
    '/bin/rm -f "$tmp" && /bin/ln -s "$link" "$tmp" || return 1',
    '/bin/rm -f "$tmp" && /bin/ln -s "$link" "$tmp" || return 1\n      /bin/chmod -h "$(jxa link-mode "$ROOT" "$BASELINE" "$UID_NOW" "$target")" "$tmp" || { /bin/rm -f "$tmp"; return 1; }',
  )
const application = recoveryLifecycle.slice(0, recoveryLifecycle.indexOf('\nfinish_exit()'))

const lifecycle = String.raw`
LOCKED=0
LOCK_ID=''
CONTROL_DONE=0
ROUTER_STOPPED=0
SMOKE_STOPPED=0
RESTART=1
QUIT_WAIT=30
for arg in "$@"; do
  case "$arg" in --no-restart) RESTART=0;; *) error 'usage: recover.sh [--no-restart]'; exit 2;; esac
done
WORK=$(/usr/bin/mktemp -d "$ROOT/recovery/m2/.run.XXXXXX") || exit 1
/bin/chmod 700 "$WORK" || exit 1
JXA_FILE="$WORK/recovery.js"
write_jxa > "$JXA_FILE" || exit 1
jxa() { /usr/bin/osascript -l JavaScript "$JXA_FILE" "$@"; }
UID_NOW=$(/usr/bin/id -u) || exit 1
START=$(jxa start "$$") || exit 1
TOKEN=$(/usr/bin/uuidgen | /usr/bin/tr A-Z a-z) || exit 1
gate_lock() {
  local quoted
  quoted=$(jxa quote "$JXA_FILE" "$1" "$ROOT" "$UID_NOW" "$$" "$START" "$TOKEN" "$LOCK_ID") || return 1
  /usr/bin/sqlite3 "$ROOT/state/flip-admission.lock.sqlite" > "$WORK/gate-out" 2> "$WORK/gate-error" <<M2_GATE_SQL
.timeout 10000
BEGIN IMMEDIATE;
.shell /usr/bin/osascript -l JavaScript $quoted
ROLLBACK;
M2_GATE_SQL
  [ "$?" = 0 ] && [ ! -s "$WORK/gate-error" ] || { /bin/cat "$WORK/gate-error" >&2; return 1; }
  /bin/chmod 600 "$ROOT/state/flip-admission.lock.sqlite" || return 1
  /bin/sync
}
checkpoint() { jxa checkpoint "$ROOT" "$BASELINE" "$UID_NOW" "$1" && /bin/sync; }
clean_m1_evidence() {
  local quoted
  jxa evidence-gate "$ROOT" "$BASELINE" "$UID_NOW" || return 1
  quoted=$(jxa quote "$JXA_FILE" m1-evidence "$ROOT" "$BASELINE" "$UID_NOW") || return 1
  /usr/bin/sqlite3 "$ROOT/state/proof-degraded.lock.sqlite" > "$WORK/evidence-out" 2> "$WORK/evidence-error" <<M2_EVIDENCE_SQL
.timeout 10000
BEGIN IMMEDIATE;
.shell /usr/bin/osascript -l JavaScript $quoted
ROLLBACK;
M2_EVIDENCE_SQL
  [ "$?" = 0 ] && [ ! -s "$WORK/evidence-error" ] || { /bin/cat "$WORK/evidence-error" >&2; return 1; }
  /bin/chmod 600 "$ROOT/state/proof-degraded.lock.sqlite" && /bin/sync
}
error() {
  printf '[m2-rollback] LEFT %s; recover with /bin/bash %s\n' "$*" "$RECOVER" >&2
  STATUS=1; FAILED=1
  [ -z "$WORK" ] || jxa conflict "$ROOT" "$BASELINE" "$UID_NOW" "$*" >/dev/null 2>&1 || :
}
finish_exit() {
  local code=$?
  trap - EXIT
  [ "$code" = 0 ] || STATUS=1
  if [ "$STATUS" != 0 ] && [ "$CONTROL_DONE" = 0 ] && [ "$ROUTER_STOPPED" = 1 ]; then
    restart_job dev.anyengine.router "$HOME/Library/LaunchAgents/dev.anyengine.router.plist"
    if [ "$SMOKE_STOPPED" = 1 ]; then restart_job dev.anyengine.smoke "$HOME/Library/LaunchAgents/dev.anyengine.smoke.plist"; fi
  fi
  reopen_app
  if [ "$LOCKED" = 1 ]; then gate_lock release || STATUS=1; fi
  [ -z "$WORK" ] || /bin/rm -rf "$WORK" || STATUS=1
  exit "$STATUS"
}
trap finish_exit EXIT
trap 'error "recovery interrupted"; exit 1' HUP INT TERM
gate_lock lock || { error 'another control operation or invalid control lock'; exit 1; }
LOCK_ID=$(/usr/bin/stat -f '%d:%i' "$ROOT/state/flip.lock") || exit 1
LOCKED=1
jxa plan "$ROOT" "$BASELINE" "$UID_NOW" > "$WORK/plan" || { error 'M2 recovery authority validation'; exit 1; }
. "$WORK/plan"
verify_health() {
  local attempt=0
  until "$CURL" --silent --show-error --fail --max-time 1 --noproxy '*' "http://127.0.0.1:$PORT/health" > "$WORK/health" 2> "$WORK/health-error"; do
    [ "$attempt" -lt 20 ] || { error 'M1 router health unavailable'; return 1; }
    /bin/sleep 0.25
    attempt=$((attempt+1))
  done
  [ ! -s "$WORK/health-error" ] && jxa health "$WORK/health" "§{PRIOR_LIB##*/}" "$M1_MODE" || { error 'M1 router health/version/fault mismatch'; return 1; }
}
verify_terminal() {
  verify_controls && verify_jobs &&
    [ "$(sha "$ROOT/state/layers.json")" = "$LAYERS_SHA" ] && verify_health
}
if [ "$PHASE" = rolled-back ]; then
  clean_m1_evidence || { error 'M1 status cleanup failed'; exit 1; }
  verify_terminal || { error 'terminal M2 baseline superseded or unhealthy'; exit 1; }
  exit 0
fi
current_layers=$(sha "$ROOT/state/layers.json") || exit 1
[ "$current_layers" = "$EXPECTED_LAYERS_SHA" ] || [ "$current_layers" = "$LAYERS_SHA" ] || { error 'M1 layer records changed outside M2 transaction'; exit 1; }
jxa admit-marker "$ROOT" "$BASELINE" "$UID_NOW" || { error 'foreign shared flip marker'; exit 1; }
if [ "$RESTART" = 0 ]; then confirmed_down || exit 1
else quit_app || exit 1; fi
stop_job dev.anyengine.router
[ "$FAILED" = 0 ] || exit 1
ROUTER_STOPPED=1
job_state dev.anyengine.smoke; smoke_state=$?
[ "$smoke_state" != 2 ] || { error 'cannot inspect smoke job'; exit 1; }
stop_job dev.anyengine.smoke
[ "$FAILED" = 0 ] || exit 1
[ "$smoke_state" != 0 ] || SMOKE_STOPPED=1
clean_m1_evidence || { error 'M1 status cleanup failed'; exit 1; }
restore_claude() {
  local target="$1" before="$2" after="$3" owned="$4" mode="$5" aftersha="$6" beforesha="$7" current tmp
  if [ -z "$before" ] && [ -z "$beforesha" ]; then
    current=$(jxa kind "$target") || { error "invalid Claude settings $target"; return 1; }
    [ "$current" != absent ] || return 0
  fi
  current=$(sha "$target") || { error "invalid Claude settings $target"; return 1; }
  [ -z "$beforesha" ] || [ "$current" != "$beforesha" ] || return 0
  tmp=$(/usr/bin/mktemp "$target.m2-recovery.XXXXXX") || { error "Claude recovery output $target"; return 1; }
  if [ "$current" = "$aftersha" ] && [ "$(jxa claude-exact "$target" "$before" "$after" "$owned")" = yes ]; then
    if [ -z "$before" ]; then
      /bin/rm -f "$tmp"
      [ "$(sha "$target")" = "$current" ] && /bin/rm -f "$target" && /bin/sync || { error "Claude settings changed $target"; return 1; }
      return 0
    fi
    /usr/bin/install -m "$mode" "$before" "$tmp" || { /bin/rm -f "$tmp"; error "Claude baseline $target"; return 1; }
  elif ! jxa claude-merge "$target" "$before" "$after" "$owned" > "$tmp"; then
    /bin/rm -f "$tmp"; error "Claude settings conflict $target"; return 1
  fi
  [ "$(sha "$target")" = "$current" ] || { /bin/rm -f "$tmp"; error "Claude settings changed $target"; return 1; }
  /bin/chmod "$mode" "$tmp" && /bin/mv -fh "$tmp" "$target" && /bin/sync || { error "Claude restore $target"; return 1; }
}
if [ "$current_layers" != "$LAYERS_SHA" ]; then
  jxa claude-plan "$ROOT" > "$WORK/claude-plan" || { error 'Claude semantic recovery admission'; exit 1; }
  FAILED=0; RC_BLOCKED=0
  . "$WORK/claude-plan"
  [ "$FAILED" = 0 ] || exit 1
fi
checkpoint 'before-marker-detach' || exit 1
jxa detach "$ROOT" "$BASELINE" "$UID_NOW" && /bin/sync || { error 'shared marker detach conflict'; exit 1; }
checkpoint 'shared-marker-detached' || exit 1
restore_controls || exit 1
CONTROL_DONE=1
checkpoint 'control-restored' || exit 1
current_layers=$(sha "$ROOT/state/layers.json") || exit 1
if [ "$current_layers" != "$LAYERS_SHA" ]; then
  [ "$current_layers" = "$EXPECTED_LAYERS_SHA" ] || { error 'M1 records changed before restore'; exit 1; }
  tmp=$(/usr/bin/mktemp "$ROOT/state/layers.json.m2.XXXXXX") || exit 1
  /usr/bin/install -m 600 "$LAYERS_BACKUP" "$tmp" && /bin/mv -fh "$tmp" "$ROOT/state/layers.json" && /bin/sync || { error 'M1 layer records restore'; exit 1; }
fi
checkpoint 'layers-restored' || exit 1
restore_jobs || exit 1
ROUTER_STOPPED=0
checkpoint 'jobs-restored' || exit 1
reopen_app
verify_terminal || { error 'M1 terminal verification failed'; exit 1; }
checkpoint 'rolled-back' || exit 1
exit "$STATUS"
`.replaceAll('§{', '${')

export function generateM2Rollback(
  baseline: M2Baseline,
  options: { root: string; app: string; bundleId: string; milestone?: RecoveryMilestone },
): string {
  if (
    !absolute(options.root) ||
    !absolute(options.app) ||
    dirname(baseline.rollbackDir) !== m2Paths(options.root, options.milestone).directory ||
    baseline.recoveryScript !== join(baseline.rollbackDir, 'recover.sh')
  )
    throw new Error('invalid M2 recovery script paths')
  const values = {
    ROOT: options.root,
    APP: options.app,
    BUNDLE: options.bundleId,
    BASELINE: basename(baseline.rollbackDir),
    RECOVER: m2Paths(options.root, options.milestone).entry,
  }
  const script = `#!/bin/bash\n# Independent M2 → M1 recovery. No installed Node or bootstrap dependency.\n${Object.entries(
    values,
  )
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(
      '\n',
    )}\n${primitives}\nwrite_jxa() { /bin/cat <<'M2_JXA_BODY'\n${options.milestone === 'm3' ? m3RecoveryJxa : m2RecoveryJxa}\nM2_JXA_BODY\n}\n${application}\n${options.milestone === 'm3' ? m3Lifecycle : lifecycle}`
  return options.milestone === 'm3'
    ? script.replace('Independent M2 → M1', 'Independent M3 → M2')
    : script
}

const claudeUndoStart = lifecycle.indexOf(
  '\nif [ "$current_layers" != "$LAYERS_SHA" ]; then\n  jxa claude-plan',
)
const claudeUndoEnd = lifecycle.indexOf('\nfi\n', claudeUndoStart) + 4
const m3Lifecycle = (lifecycle.slice(0, claudeUndoStart) + '\n' + lifecycle.slice(claudeUndoEnd))
  .split('\n')
  .filter((line) => !line.includes('clean_m1_evidence ||'))
  .join('\n')
  .replaceAll('recovery/m2', 'recovery/m3')
  .replaceAll('m2-rollback', 'm3-rollback')
  .replaceAll('M2 baseline', 'M3 baseline')
  .replaceAll('M1 ', 'M2 ')
  .replace(
    'jxa admit-marker',
    "preflight_controls || { error 'M3 control conflict; keeping current dispatchers'; exit 1; }\njxa admit-marker",
  )
  .replace(
    "checkpoint 'before-marker-detach'",
    () =>
      'jxa accounts-home "$ROOT" "$BASELINE" "$UID_NOW" "$$" || { error \'Home account recovery failed\'; exit 1; }\ncheckpoint \'before-marker-detach\'',
  )
  .replace(
    '[ "$PHASE" = rolled-back ]; then',
    '[ "$PHASE" = rolled-back ]; then\n  jxa accounts-verify "$ROOT" "$BASELINE" "$UID_NOW" || exit 1',
  )
  .replace('verify_controls && verify_jobs &&', 'verify_controls && verify_jobs &&')
  .replace(
    '&& verify_health\n}',
    '&& verify_health && verify_claude && jxa accounts-verify "$ROOT" "$BASELINE" "$UID_NOW"\n}',
  )
  .replace(
    'verify_terminal() {',
    `verify_claude() {
  "$CURL" --silent --show-error --fail --max-time 10 --noproxy '*' "http://127.0.0.1:$PORT/control/claude-code/models" > "$WORK/claude" 2> "$WORK/claude-error" &&
    [ ! -s "$WORK/claude-error" ] && jxa claude-face "$ROOT" "$BASELINE" "$UID_NOW" "$WORK/claude"
}
verify_terminal() {`,
  )
