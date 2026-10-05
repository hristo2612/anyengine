// Semantic Claude restoration embedded in the existing node-free broad off.
import { m2ClaudeMergeJxa } from './control-m2-recovery-claude.mjs'
export const claudeRecoveryJxa = `${m2ClaudeMergeJxa}\n${String.raw`
function validateClaudeDescriptor(l) {
  var d=l.claudeCode
  if (d === undefined) { if (l.name === 'claude-code') fail('missing Claude semantic descriptor'); return }
  keys(d,['settingsTarget','ownedModels','touchedPaths','catalog'])
  if (l.name !== 'claude-code' || !absolute(d.settingsTarget) || !Array.isArray(d.ownedModels) || d.ownedModels.length > 10 || !d.ownedModels.every(function(id) { return typeof id === 'string' && id.length <= 128 && /^gpt-[a-z0-9][a-z0-9.-]*$/.test(id) }) || new Set(d.ownedModels).size !== d.ownedModels.length || !Array.isArray(d.touchedPaths) || d.touchedPaths.length !== 4 || new Set(d.touchedPaths).size !== 4 || !d.touchedPaths.every(function(p) { return ['env.ANTHROPIC_BASE_URL','env.ANTHROPIC_DEFAULT_HAIKU_MODEL','env.CLAUDE_CODE_GATEWAY_HINT_HEADERS','modelPicker.options'].indexOf(p) >= 0 })) fail('Claude semantic descriptor')
  keys(d.catalog,['generation','fetchedAt'])
  if (!Number.isSafeInteger(d.catalog.generation) || d.catalog.generation < 0 || !Number.isSafeInteger(d.catalog.fetchedAt) || d.catalog.fetchedAt < 0) fail('Claude catalog metadata')
}
function claudeHash(path) {
  var task=$.NSTask.alloc.init, pipe=$.NSPipe.pipe
  task.launchPath='/usr/bin/shasum'; task.arguments=$(['-a','256',path]); task.standardOutput=pipe
  task.launch; var data=pipe.fileHandleForReading.readDataToEndOfFile; task.waitUntilExit
  if (Number(task.terminationStatus) !== 0) fail('Claude hash '+path)
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding)).slice(0,64)
}
function claudeState(path) {
  var a=attr(path)
  if (!a) return {kind:'absent',sha:null,link:null,bytes:null,mode:null}
  if (a.type !== 'NSFileTypeRegular') fail('Claude regular target '+path)
  return {kind:'file',sha:claudeHash(path),link:null,bytes:null,mode:a.mode}
}
function claudeSame(a,b) { return a.kind === b.kind && a.sha === b.sha && a.link === b.link && a.mode === b.mode }
function claudePlanLayer(l) {
  var d=l.claudeCode, c=l.changes.filter(function(c) { return c.target === d.settingsTarget })[0]
  if (!c || settled(c).kind !== 'file' || before(c).kind === 'symlink') fail('Claude settings authority '+d.settingsTarget)
  var observed=claudeState(c.target), prior=c.backup ? json(l.rollbackDir+'/'+c.backup,2000000) : {}, installed=json(l.rollbackDir+'/'+c.after,2000000)
  var pristine=m2Equal(mergeClaudeSettings(installed,prior,installed,d.ownedModels).value,prior)
  var exact=claudeSame(observed,before(c)) || pristine && claudeSame(observed,settled(c)), result=null
  if (!exact) {
    var current=observed.kind === 'absent' ? {} : json(c.target,2000000)
    var merged=mergeClaudeSettings(current,prior,installed,d.ownedModels)
    if (merged.conflicts.length) fail(c.target+': '+merged.conflicts.join(', '))
    result=m2Equal(current,merged.value) ? null : merged.value
  }
  l.changes.forEach(function(agent) {
    if (agent === c) return
    var now=claudeState(agent.target)
    if (!claudeSame(now,before(agent)) && !claudeSame(now,settled(agent)) && !(agent.pending && claudeSame(now,agent.pending))) fail('edited Claude agent '+agent.target)
  })
  return {change:c,observed:observed,exact:exact,value:result}
}
function claudeBroadMerge(root,dir) {
  var f=journal(root), l=f.layers.filter(function(l) { return l.rollbackDir === dir && l.name === 'claude-code' })[0]
  if (!l) fail('missing Claude layer')
  var p=claudePlanLayer(l)
  if (p.exact) return 'CLAUDE_EXACT=1\n'
  if (p.value === null) return 'CLAUDE_EXACT=2\n'
  emit(JSON.stringify(p.value,null,2)+'\n')
}
function claudeBroadIntent(root,dir,path,hash,mode) {
  var f=journal(root), l=f.layers.filter(function(l) { return l.rollbackDir === dir && l.name === 'claude-code' })[0]
  if (!l || !/^[a-f0-9]{64}$/.test(hash) || !/^[0-7]{3,4}$/.test(mode)) fail('Claude semantic intent')
  var name='claude-off-'+ObjC.unwrap($.NSUUID.UUID.UUIDString)+'.blob', dest=dir+'/'+name
  regular(path,2000000)
  if (claudeHash(path) !== hash || !fm.copyItemAtPathToPathError($(path),$(dest),null)) fail('Claude semantic blob')
  if (!fm.setAttributesOfItemAtPathError($({NSFilePosixPermissions:384}),$(dest),null)) fail('Claude blob mode')
  var c=l.changes.filter(function(c) { return c.target === l.claudeCode.settingsTarget })[0]
  c.pending={kind:'file',sha:hash,link:null,bytes:name,mode:parseInt(mode,8)}
  f.layers.forEach(function(l) { delete l.isPopped })
  var data=$(JSON.stringify(f)+'\n').dataUsingEncoding($.NSUTF8StringEncoding)
  if (!data.writeToFileAtomically($(root+'/state/layers.json'),true) || !fm.setAttributesOfItemAtPathError($({NSFilePosixPermissions:384}),$(root+'/state/layers.json'),null)) fail('Claude intent journal')
}
`}`
export const claudeRecoveryShell = `
restore_claude() {
  local dir="$1" target="$2" kind="$3" hash="$4" mode="$5" before_kind="$6" before_hash="$7" before_bytes="$8" before_mode="$9" after_hash="§{10}" after_bytes="§{11}" after_mode="§{12}" exact="§{13}" tmp output new_hash
  if [ "$exact" = 1 ]; then
    restore "$target" claude "$before_kind" "$before_hash" '' "$before_bytes" "$before_mode" file "$after_hash" '' "$after_bytes" "$after_mode" file "$after_hash" '' "$after_bytes" "$after_mode" file "$after_hash" '' "$after_bytes" "$after_mode"
    return
  fi
  output="$WORK/claude-merge"
  jxa claude-merge "$ROOT" "$dir" > "$output" || { error "Claude settings conflict $target"; return; }
  matches "$target" "$kind" "$hash" '' '' "$mode" || { error "Claude settings changed $target"; return; }
  if /usr/bin/cmp -s "$output" /dev/null || /usr/bin/grep -q '^CLAUDE_EXACT=2$' "$output"; then return; fi
  /usr/bin/grep -q '^CLAUDE_EXACT=1$' "$output" && { error "Claude state changed $target"; return; }
  tmp=$(/usr/bin/mktemp "$target.anyengine-off.XXXXXX") || { error "Claude atomic target $target"; return; }
  /usr/bin/install -m "$mode" "$output" "$tmp" || { /bin/rm -f "$tmp"; error "Claude output $target"; return; }
  new_hash=$(sha "$tmp") || { /bin/rm -f "$tmp"; error "Claude output hash $target"; return; }
  jxa claude-intent "$ROOT" "$dir" "$tmp" "$new_hash" "$mode" && /bin/sync || { /bin/rm -f "$tmp"; error "Claude intent $target"; return; }
  matches "$target" "$kind" "$hash" '' '' "$mode" || { /bin/rm -f "$tmp"; error "Claude concurrent edit $target"; return; }
  /bin/mv -fh "$tmp" "$target" && /bin/sync || { error "Claude publication $target"; return; }
}
`.replaceAll('§{', '${')
