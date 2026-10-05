import { claudeRecoveryJxa } from './control-claude-recovery.mjs'
import { recoveryEvidence } from './control-recovery-evidence.mjs'
import { recoveryText } from './control-recovery-text.mjs'

// Foundation and M1's strict state/hunk readers are shared. The M2 run function
// replaces the broad dispatcher; no M0/config/cache operation is called here.
export const m2RecoveryJxa = `${recoveryEvidence}\n${recoveryText}\n${claudeRecoveryJxa}\n${String.raw`
function own(p,kind,mode,uid) {
  var a = fm.attributesOfItemAtPathError($(p),null)
  if (a.isNil() || ObjC.unwrap(a.objectForKey($.NSFileType)) !== kind || Number(ObjC.unwrap(a.objectForKey($.NSFileOwnerAccountID))) !== Number(uid) || (mode !== null && Number(ObjC.unwrap(a.objectForKey($.NSFilePosixPermissions))) !== mode)) fail('unowned/unsafe '+p)
}
function writeJson(p,value) {
  var bytes = $(JSON.stringify(value)+'\n').dataUsingEncoding($.NSUTF8StringEncoding)
  if (!bytes.writeToFileAtomically($(p),true)) fail('write '+p)
  if (!fm.setAttributesOfItemAtPathError($({NSFilePosixPermissions:384}),$(p),null)) fail('mode '+p)
  var handle = $.NSFileHandle.fileHandleForWritingAtPath($(p))
  if (handle.isNil()) fail('sync '+p)
  handle.synchronizeFile; handle.closeFile
}
function taskText(command,args,environment) {
  var task=$.NSTask.alloc.init, pipe=$.NSPipe.pipe
  task.launchPath=command; task.arguments=args; task.standardOutput=pipe; task.standardError=$.NSPipe.pipe
  task.environment=$(environment || {TZ:'UTC',LC_ALL:'C',PATH:'/usr/bin:/bin'})
  task.launch; var data=pipe.fileHandleForReading.readDataToEndOfFile; task.waitUntilExit
  return {status:Number(task.terminationStatus),text:ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding)).trim()}
}
function libraryPlan(lib) {
  directory(lib)
  var manifest=json(lib+'/install-manifest.json',2000000), out='', names=[]
  if (!obj(manifest) || manifest.version !== lib.slice(lib.lastIndexOf('/')+1) || !obj(manifest.files) || !obj(manifest.links)) fail('M1 manifest')
  Object.keys(manifest.files).forEach(function(name) {
    if (name.split('/').some(function(p) { return !p || p === '.' || p === '..' }) || !/^[a-f0-9]{64}$/.test(manifest.files[name])) fail('M1 manifest path/hash')
    names.push(name); out+=call('verify_blob',[lib+'/'+name,manifest.files[name]])
  })
  Object.keys(manifest.links).forEach(function(name) {
    if (names.indexOf(name) >= 0 || name.split('/').some(function(p) { return !p || p === '.' || p === '..' }) || !text(manifest.links[name])) fail('M1 manifest link')
    names.push(name); out+=call('matches',[lib+'/'+name,'symlink','',manifest.links[name],'','']).trimEnd()+' || { error '+q('M1 library link '+name)+'; exit 1; }\n'
  })
  function walk(dir,prefix) {
    var entries=ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError($(dir),null))
    if (!Array.isArray(entries)) fail('M1 library traversal')
    entries.forEach(function(name) { var relative=prefix+name, a=attr(dir+'/'+name)
      if (relative === 'install-manifest.json') return
      if (a.type === 'NSFileTypeDirectory') walk(dir+'/'+name,relative+'/')
      else if (names.indexOf(relative) < 0) fail('unmanifested M1 entry')
    })
  }
  walk(lib,'')
  return out
}
function m2Record(root,baselineId,uid,allowRetired) {
  var dir = root+'/recovery/m2', base = dir+'/'+baselineId
  if (!absolute(root) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(baselineId)) fail('M2 root/id')
  [root,root+'/recovery',dir,base].forEach(function(p) { own(p,'NSFileTypeDirectory',p === root ? null : 448,uid) })
  own(base+'/journal.json','NSFileTypeRegular',384,uid)
  var j = json(base+'/journal.json',2000000), b = j && j.baseline
  if (!obj(j) || j.version !== 1 || j.baselineId !== baselineId || !obj(b) || b.version !== 1 || b.rollbackDir !== base || b.recoveryScript !== base+'/recover.sh' || b.recoveryJournal !== base+'/journal.json' || b.m1LayersBackup !== base+'/m1-layers.json' || !absolute(b.priorLib) || b.priorLib.slice(0,root.length+5) !== root+'/lib/' || !/^[a-f0-9]{64}$/.test(b.m1LayersSha256) || !/^[a-f0-9]{64}$/.test(j.expectedLayersSha256) || !/^[a-f0-9]{64}$/.test(j.manifestSha256) || !Array.isArray(b.controlChanges) || b.controlChanges.length > 128 || !Array.isArray(b.jobs) || b.jobs.length !== 2 || typeof j.sharedMarkerDetached !== 'boolean' || !absolute(j.home) || !Number.isSafeInteger(j.port) || j.port < 1 || j.port > 65535 || !Array.isArray(j.conflicts)) fail('M2 journal structure')
  own(b.m1LayersBackup,'NSFileTypeRegular',384,uid)
  if (['agent','model'].indexOf(j.m1Mode) < 0) fail('M1 baseline mode')
  if (j.retired === true && !allowRetired) fail('retired M2 baseline; preserve evidence')
  var layers=json(b.m1LayersBackup,2000000)
  if (!obj(layers) || !Array.isArray(layers.layers)) fail('M1 layer copy')
  var rollbackScripts=layers.layers.map(function(l) { return l.rollbackDir+'/ROLLBACK.sh' })
  var seen=[]
  b.controlChanges.forEach(function(c) {
    if (!obj(c) || !absolute(c.target) || seen.indexOf(c.target) >= 0 || c.target.indexOf(dir+'/') === 0) fail('M2 control change')
    var t=c.target, allowed=t === root+'/lib/current' || t === root+'/runtime.env' || t.slice(0,t.lastIndexOf('/')) === root+'/bin' || t === j.home+'/bin/codex' || t === root+'/RECOVER.txt' || t === root+'/recovery/anyengine-off' || /^dev\.anyengine\.(router|smoke)\.plist$/.test(t.slice(t.lastIndexOf('/')+1)) && t.slice(0,t.lastIndexOf('/')) === j.home+'/Library/LaunchAgents' || rollbackScripts.indexOf(t) >= 0
    if (!allowed) fail('M2 target outside install')
    seen.push(t); state(before(c),base); state(settled(c),base); if (c.pending !== null) state(c.pending,base)
  })
  b.jobs.forEach(function(job) { if (!obj(job) || ['dev.anyengine.router','dev.anyengine.smoke'].indexOf(job.label) < 0 || job.plist !== j.home+'/Library/LaunchAgents/'+job.label+'.plist' || typeof job.loaded !== 'boolean') fail('M2 job') })
  var links=b.controlChanges.filter(function(c) { return c.before === 'symlink' })
  if (!obj(j.linkModes) || Object.keys(j.linkModes).length !== links.length || !links.every(function(c) { return mode(j.linkModes[c.target]) })) fail('M2 link modes')
  return j
}
function currentM2(root,baselineId,uid) {
  var dir=root+'/recovery/m2'
  own(dir+'/current.json','NSFileTypeRegular',384,uid)
  var pointer=json(dir+'/current.json',2000000)
  if (!obj(pointer) || pointer.baselineId !== baselineId || pointer.script !== dir+'/'+baselineId+'/recover.sh' || pointer.journal !== dir+'/'+baselineId+'/journal.json' || !/^[a-f0-9]{64}$/.test(pointer.scriptSha256)) fail('superseded/invalid M2 pointer')
  own(pointer.script,'NSFileTypeRegular',448,uid)
  return pointer
}
function saveM2(root,j) {
  writeJson(j.baseline.recoveryJournal,j)
  writeJson(root+'/m2-upgrade.json',j.baseline)
}
function m2Plan(root,id,uid) {
  var j=m2Record(root,id,uid), b=j.baseline, pointer=currentM2(root,id,uid)
  var out=''
  out+=call('verify_blob',[pointer.script,pointer.scriptSha256])
  out+=call('verify_blob',[b.m1LayersBackup,b.m1LayersSha256])
  out+=call('verify_blob',[b.priorLib+'/install-manifest.json',j.manifestSha256])
  out+=libraryPlan(b.priorLib)
  blobs.forEach(function(v) { out+=call('verify_blob',v) })
  var names={launchctl:'LAUNCHCTL',osascript:'OSASCRIPT',open:'OPEN',pgrep:'PGREP',plutil:'PLUTIL',curl:'CURL'}
  Object.keys(names).forEach(function(k) { if (!absolute(j.commands[k])) fail('M2 command'); out+=names[k]+'='+q(j.commands[k])+'\n' })
  out+='HOME='+q(j.home)+'\nPORT='+q(String(j.port))+'\nM1_MODE='+q(j.m1Mode)+'\nPRIOR_LIB='+q(b.priorLib)+'\nLAYERS_BACKUP='+q(b.m1LayersBackup)+'\nLAYERS_SHA='+q(b.m1LayersSha256)+'\nEXPECTED_LAYERS_SHA='+q(j.expectedLayersSha256)+'\nPHASE='+q(b.phase)+'\n'
  out+='restore_controls() { FAILED=0; RC_BLOCKED=0\n'
  b.controlChanges.slice().reverse().forEach(function(c) { var a=settled(c), p=c.pending || a; out+=call('restore',[c.target,'file'].concat(args(before(c),b.rollbackDir),args(a,b.rollbackDir),args(p,b.rollbackDir),args(a,b.rollbackDir))) })
  out+='return "$FAILED"; }\nverify_controls() {\n'
  b.controlChanges.forEach(function(c) {
    out+=call('matches',[c.target].concat(args(before(c),b.rollbackDir))).trimEnd()+' || { error '+q('superseded or changed control '+c.target)+'; return 1; }\n'
    if (c.before === 'symlink') out+='[ "$(/usr/bin/stat -f \'%Lp\' '+q(c.target)+')" = '+q(j.linkModes[c.target].toString(8))+' ] || { error '+q('M1 link mode '+c.target)+'; return 1; }\n'
  })
  out+='}\nrestore_jobs() { FAILED=0\n'
  b.jobs.forEach(function(job) { out+=call(job.loaded ? 'restart_job' : 'stop_job',[job.label].concat(job.loaded ? [job.plist] : [])) })
  out+='return "$FAILED"; }\nverify_jobs() {\n'
  b.jobs.forEach(function(job) { out+=call('job_state',[job.label]).trimEnd()+'; [ "$?" = '+(job.loaded ? '0' : '1')+' ] || { error '+q('M1 job state '+job.label)+'; return 1; }\n' })
  out+='}\n'
  return out
}
function checkpointM2(root,id,uid,phase) {
  var j=m2Record(root,id,uid); currentM2(root,id,uid)
  j.checkpoint=phase
  j.baseline.phase=phase === 'rolled-back' ? 'rolled-back' : 'rolling-back'
  if (phase === 'shared-marker-detached') j.sharedMarkerDetached=true
  saveM2(root,j)
}
function admitMarkerM2(root,id,uid) {
  var j=m2Record(root,id,uid), path=root+'/state/flip.json', marker=json(path,2000000)
  if (marker !== undefined && (!obj(marker) || !j.transactionId || marker.id !== j.transactionId || !obj(marker.state) || marker.state.m2BaselineId !== id || marker.state.failureTarget !== 'm2')) fail('foreign shared flip marker')
  return {journal:j,marker:marker,path:path}
}
function detachM2(root,id,uid) {
  var admitted=admitMarkerM2(root,id,uid), j=admitted.journal, marker=admitted.marker, path=admitted.path
  j.sharedMarkerDetached=true; j.checkpoint='shared-marker-detached'; j.baseline.phase='rolling-back'; saveM2(root,j)
  if (marker !== undefined && !fm.removeItemAtPathError($(path),null)) fail('shared marker detach')
}
function pidStart(pid) {
  var result=taskText('/bin/ps',['-p',String(pid),'-o','lstart='])
  if (result.status === 1 && !result.text) return null
  if (result.status !== 0 || !result.text) fail('process start inspection')
  var date=new Date(result.text+' UTC')
  if (!isFinite(date.getTime())) fail('process start parse')
  return date.toISOString()
}
function lockM2(root,uid,pid,start,token,release,identity) {
  var path=root+'/state/flip.lock', value=json(path,4096)
  if (value !== undefined) {
    own(path,'NSFileTypeRegular',384,uid)
    if (!obj(value) || !Number.isSafeInteger(value.pid) || !text(value.processStart) || !/^[a-f0-9-]{36}$/.test(value.token)) fail('flip lock owner')
    if (release) {
      var inode=taskText('/usr/bin/stat',['-f','%d:%i',path])
      if (value.pid === Number(pid) && value.processStart === start && value.token === token && inode.status === 0 && inode.text === identity && !fm.removeItemAtPathError($(path),null)) fail('flip release')
      return
    }
    if (pidStart(value.pid) === value.processStart) fail('another live control operation')
    if (!fm.removeItemAtPathError($(path),null)) fail('stale flip lock release')
  } else if (release) return
  if (pidStart(Number(pid)) !== start) fail('recovery process identity')
  writeJson(path,{pid:Number(pid),processStart:start,token:token})
}
function mergeClaudeFile(paths,exact) {
  var target=paths[0], before=paths[1], after=paths[2], owned=JSON.parse(paths[3])
  var current, prior, installed
  try { current=JSON.parse(read(target,2000000)); prior=before ? JSON.parse(read(before,2000000)) : {}; installed=JSON.parse(read(after,2000000)) }
  catch(e) { fail(target+': invalid Claude settings JSON') }
  var result=mergeClaudeSettings(current,prior,installed,owned)
  if (result.conflicts.length) fail(target+': '+result.conflicts.join(', '))
  if (exact) return m2Equal(result.value,prior) ? 'yes' : 'no'
  emit(JSON.stringify(result.value)+'\n')
}
function claudePlan(root) {
  var file=journal(root), layer=file.layers.filter(function(l) { return l.name === 'claude-code' })[0], out=''
  if (!layer) return out
  claudePlanLayer(layer)
  layer.changes.slice().reverse().forEach(function(c) {
    var a=settled(c), p=c.pending || a
    if (c.target === layer.claudeCode.settingsTarget) {
      if (a.kind !== 'file' || before(c).kind === 'symlink') fail('Claude settings state')
      out+=call('restore_claude',[c.target, c.backup ? layer.rollbackDir+'/'+c.backup : '',layer.rollbackDir+'/'+a.bytes,JSON.stringify(layer.claudeCode.ownedModels),(c.mode === null ? 384 : c.mode).toString(8),a.sha,c.beforeSha || ''])
    } else out+=call('restore',[c.target,'file'].concat(args(before(c),layer.rollbackDir),args(a,layer.rollbackDir),args(p,layer.rollbackDir),args(a,layer.rollbackDir)))
  })
  blobs.forEach(function(v) { out=call('verify_blob',v)+out })
  return out
}
function m1Evidence(root,id,uid) {
  m2Record(root,id,uid); currentM2(root,id,uid);
  ['proven','degraded'].forEach(function(name) {
    var p=root+'/state/'+name+'.json', v=json(p,2000000)
    if (v === undefined) return
    own(p,'NSFileTypeRegular',null,uid); keys(v,['version','paths'])
    if ((v.version !== undefined && v.version !== 1) || !obj(v.paths)) fail('M1 evidence structure')
    Object.keys(v.paths).forEach(function(path) {
      if (['claude-code-gpt','router','gpt','claude-agent','claude-model','native-fanout','bridge'].indexOf(path) < 0 || !obj(v.paths[path])) fail('M1 evidence path')
    })
    if (Object.prototype.hasOwnProperty.call(v.paths,'claude-code-gpt')) {
      delete v.paths['claude-code-gpt']; writeJson(p,v)
    }
  })
}
function run(argv) {
  var op=argv[0], root=argv[1], id=argv[2], uid=argv[3]
  if (op === 'kind') { ordinary(argv[1]); var a=attr(argv[1]); return a ? a.type : 'absent' }
  if (op === 'hunk') { hunk(argv.slice(1)); return }
  if (op === 'plan') return m2Plan(root,id,uid)
  if (op === 'checkpoint') { checkpointM2(root,id,uid,argv[4]); return }
  if (op === 'detach') { detachM2(root,id,uid); return }
  if (op === 'admit-marker') { admitMarkerM2(root,id,uid); return }
  if (op === 'm1-evidence') { m1Evidence(root,id,uid); return }
  if (op === 'evidence-gate') {
    own(root+'/state','NSFileTypeDirectory',null,uid)
    var gate=root+'/state/proof-degraded.lock.sqlite'
    if (attr(gate)) own(gate,'NSFileTypeRegular',384,uid)
    return
  }
  if (op === 'conflict') { var j=m2Record(root,id,uid); j.baseline.phase='conflict'; j.conflicts.push(argv[4]); saveM2(root,j); return }
  if (op === 'start') return pidStart(Number(argv[1]))
  if (op === 'quote') return argv.slice(1).map(q).join(' ')
  if (op === 'lock' || op === 'release') { lockM2(root,argv[2],argv[3],argv[4],argv[5],op === 'release',argv[6]); return }
  if (op === 'claude-plan') return claudePlan(root)
  if (op === 'claude-merge') { mergeClaudeFile(argv.slice(1)); return }
  if (op === 'claude-exact') return mergeClaudeFile(argv.slice(1),true)
  if (op === 'link-mode') {
    var j=m2Record(root,id,uid), target=argv[4]
    if (!Object.prototype.hasOwnProperty.call(j.linkModes,target)) fail('missing M1 link mode')
    return j.linkModes[target].toString(8)
  }
  if (op === 'health') {
    var health=JSON.parse(read(argv[1],128000))
    if (['agent','model'].indexOf(argv[3]) < 0 || !obj(health) || health.ok !== true || health.version !== argv[2] || !Number.isSafeInteger(health.pid) || health.pid < 1 || health.mode !== argv[3] || !obj(health.faults) || health.faults.hookErrors !== 0 || health.faults.unhandledRejections !== 0) fail('M1 router health identity/faults')
    return
  }
  fail('unknown M2 operation')
}
`}`
