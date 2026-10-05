// Node-free account recovery uses the same SQL gate and inode-only move journal.
// auth.json is inspected with lstat/readlink and renamed; its bytes are never read.
export const accountRecoveryJxa = String.raw`
function aq(value) { return "'"+String(value).replace(/'/g,"''")+"'" }
function asql(db,sql) {
  var r=taskText('/usr/bin/sqlite3',['-batch','-bail','-json',db,'.timeout 10000',sql])
  if (r.status !== 0) fail('account SQL transaction refused')
  return r.text ? JSON.parse(r.text) : []
}
function assertChanged() { return 'INSERT INTO recovery_assert VALUES(changes());' }
function atx(db,sql) {
  return asql(db,'PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TEMP TABLE recovery_assert(v INTEGER CHECK(v=1));'+sql+'COMMIT;')
}
function accountRead(db) {
  var rows=asql(db,'SELECT body FROM gate WHERE id=1;'), r=asql(db,"SELECT revision,body FROM metadata WHERE name='registry';")
  if (rows.length !== 1 || r.length !== 1) fail('account metadata missing')
  var s=JSON.parse(rows[0].body), registry=JSON.parse(r[0].body)
  if (!obj(s) || !obj(registry) || registry.version !== 1 || !Array.isArray(registry.accounts) || registry.accounts.length > 32 || !Number.isSafeInteger(registry.generation) || !obj(registry.rotation) || typeof registry.rotation.enabled !== 'boolean') fail('account metadata structure')
  var ids=[]
  registry.accounts.forEach(function(a) {
    if (!obj(a) || !/^[a-z][a-z0-9-]{0,63}$/.test(a.id) || ids.indexOf(a.id) >= 0 || ['home','managed'].indexOf(a.kind) < 0 || ['ready','needs-login'].indexOf(a.login) < 0) fail('account identity')
    ids.push(a.id)
  })
  if (ids.indexOf(registry.home) < 0 || ids.indexOf(registry.active) < 0 || ['open','draining','stopped','sealed','journal','rolling-back','cleanup-commit','cleanup-rollback','bootstrap'].indexOf(s.phase) < 0 || !Number.isSafeInteger(s.generation)) fail('account state')
  return {state:s,registry:registry,revision:r[0].revision,body:rows[0].body}
}
function accountSave(db,old,next,extra) {
  atx(db,'UPDATE gate SET body='+aq(JSON.stringify(next))+' WHERE id=1 AND body='+aq(old.body)+';'+assertChanged()+(extra || ''))
}
function accountProcess(pid) {
  var r=taskText('/bin/ps',['-p',String(pid),'-o','pid=,pgid=,lstart='])
  if (r.status === 1 && !r.text) return null
  var m=/^(\d+)\s+(\d+)\s+(.+)$/.exec(r.text)
  if (r.status !== 0 || !m) fail('account process ownership unknown')
  return {pid:Number(m[1]),pgid:Number(m[2]),start:m[3]}
}
function accountDead(p) {
  if (!obj(p) || !Number.isSafeInteger(p.pid) || p.pid < 1 || !Number.isSafeInteger(p.pgid) || !text(p.start)) fail('account process identity')
  var now=accountProcess(p.pid)
  if (!now) return true
  if (now.pgid !== p.pgid || now.start !== p.start) fail('account process identity changed')
  return false
}
function accountFamilyDead(p,stop) {
  if (!obj(p) || p.pid !== p.pgid) fail('account family identity')
  accountDead(p)
  var self=accountProcess(Number(ObjC.unwrap($.NSProcessInfo.processInfo.processIdentifier)))
  if (self && self.pgid === p.pgid) fail('shared credential process group')
  function members() {
    var r=taskText('/bin/ps',['-axo','pgid='])
    if (r.status !== 0) fail('account process groups unknown')
    return r.text.split(/\s+/).some(function(g) { return Number(g) === p.pgid })
  }
  if (!members()) return true
  if (!stop) return false
  ['-TERM','-KILL'].forEach(function(signal) {
    if (!members()) return
    accountDead(p)
    var r=taskText('/bin/kill',[signal,'--','-'+p.pgid])
    if (r.status !== 0 && members()) fail('credential family stop failed')
    for (var i=0;i<100 && members();i++) $.NSThread.sleepForTimeInterval(0.05)
  })
  if (members()) fail('credential family exit unproven')
  return true
}
function accountPeer(p,request,root,uid) {
  if (!obj(p) || !/^[a-zA-Z0-9_-]+$/.test(p.id) || p.socket !== root+'/run/a/'+p.id+'.sock') fail('account control address')
  own(p.socket,'NSFileTypeSocket',384,uid)
  var task=$.NSTask.alloc.init, input=$.NSPipe.pipe, output=$.NSPipe.pipe
  task.launchPath='/usr/bin/nc'; task.arguments=['-U','-w','30',p.socket]
  task.standardInput=input; task.standardOutput=output; task.standardError=$.NSPipe.pipe
  task.environment=$({PATH:'/usr/bin:/bin'})
  task.launch
  input.fileHandleForWriting.writeData($(JSON.stringify(request)+'\n').dataUsingEncoding($.NSUTF8StringEncoding))
  input.fileHandleForWriting.closeFile
  var data=output.fileHandleForReading.readDataToEndOfFile; task.waitUntilExit
  if (Number(task.terminationStatus) !== 0 || Number(data.length) > 16384) fail('account control unavailable')
  var reply=JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding)))
  if (!reply || reply.ok !== true) fail('account participant refused recovery')
}
function authStamp(path,canonical,uid) {
  var a=attr(path)
  if (!a) return {path:path,kind:'absent',dev:null,ino:null,target:null}
  if (a.type === 'NSFileTypeSymbolicLink') {
    var link=ObjC.unwrap(fm.destinationOfSymbolicLinkAtPathError($(path),null))
    if (link !== canonical+'/auth.json') fail('unexpected credential symlink')
    return {path:path,kind:'home-link',dev:null,ino:null,target:link}
  }
  own(path,'NSFileTypeRegular',null,uid)
  if (a.mode & 63) fail('unsafe credential permissions')
  var r=taskText('/usr/bin/stat',['-f','%d:%i:%l',path]), m=/^(\d+):(\d+):1$/.exec(r.text)
  if (r.status !== 0 || !m) fail('unsafe credential inode')
  return {path:path,kind:'file',dev:Number(m[1]),ino:Number(m[2]),target:null}
}
function authInventory(root,canonical,r,uid) {
  var list=[authStamp(canonical+'/auth.json',canonical,uid),authStamp(root+'/codex-home/auth.json',canonical,uid)]
  r.accounts.filter(function(a) { return a.kind !== 'home' }).forEach(function(a) {
    list.push(authStamp(root+'/accounts/openai/'+a.id+'/auth.json',canonical,uid))
  })
  var ids=[]
  list.forEach(function(s) { if (s.kind === 'file') { var id=s.dev+':'+s.ino; if (ids.indexOf(id) >= 0) fail('duplicate credential inode'); ids.push(id) } })
  return list
}
function authLayout(root,canonical,r,uid) {
  var list=authInventory(root,canonical,r,uid), overlay=list[1]
  if (r.accounts.some(function(a) { return a.id === r.home && a.login === 'ready' }) && list[0].kind !== 'file') fail('Home credential missing')
  if (overlay.kind !== (r.active === r.home ? 'home-link' : 'file')) fail('active credential layout')
  r.accounts.filter(function(a) { return a.kind !== 'home' }).forEach(function(a) {
    var stamp=list.filter(function(s) { return s.path === root+'/accounts/openai/'+a.id+'/auth.json' })[0]
    if (a.id === r.active ? stamp.kind !== 'absent' : a.login === 'ready' && stamp.kind !== 'file') fail('parked credential layout')
  })
}
function authOp(root,canonical,j,op) {
  var overlay=root+'/codex-home/auth.json', home=canonical+'/auth.json'
  if (op.kind === 'move') {
    if (!((op.from === overlay && op.to === root+'/accounts/openai/'+j.from+'/auth.json') || (op.to === overlay && op.from === root+'/accounts/openai/'+j.to+'/auth.json')) || !Number.isSafeInteger(op.dev) || !Number.isSafeInteger(op.ino) || op.ino < 1) fail('credential move authority')
  } else if (['link','unlink'].indexOf(op.kind) < 0 || op.path !== overlay || op.target !== home) fail('credential link authority')
}
function authPrefix(root,canonical,r,j,counts,uid) {
  var actual=authInventory(root,canonical,r,uid)
  if (!Array.isArray(j.inventory) || j.inventory.length !== actual.length || !Array.isArray(j.operations) || j.operations.length > 2) fail('sealed account inventory')
  j.operations.forEach(function(op) { authOp(root,canonical,j,op) })
  function comparable(s) { return JSON.stringify(s.kind === 'file' ? [s.path,s.kind,s.dev,s.ino] : [s.path,s.kind,s.target]) }
  if (!counts.some(function(n) {
    var expected=JSON.parse(JSON.stringify(j.inventory))
    j.operations.slice(0,n).forEach(function(op) {
      function set(path,s) { var matches=expected.filter(function(e) { return e.path === path }); if (matches.length !== 1) fail('sealed path inventory'); Object.assign(matches[0],s) }
      if (op.kind === 'move') {
        set(op.from,{kind:'absent',dev:null,ino:null,target:null}); set(op.to,{kind:'file',dev:op.dev,ino:op.ino,target:null})
      } else set(op.path,{kind:op.kind === 'link' ? 'home-link' : 'absent',dev:null,ino:null,target:op.kind === 'link' ? op.target : null})
    })
    return actual.every(function(a) { var matches=expected.filter(function(e) { return e.path === a.path }); return matches.length === 1 && comparable(a) === comparable(matches[0]) })
  })) fail('credential inventory changed; admission remains frozen')
}
function moveAuth(op,canonical,uid) {
  if (op.kind === 'move') {
    var from=authStamp(op.from,canonical,uid), to=authStamp(op.to,canonical,uid)
    function matches(s) { return s.kind === 'file' && s.dev === op.dev && s.ino === op.ino }
    if (from.kind === 'absent' && matches(to)) return
    if (!matches(from) || to.kind !== 'absent') fail('credential rename conflict')
    var parent=op.to.slice(0,op.to.lastIndexOf('/')), d=taskText('/usr/bin/stat',['-f','%d',parent])
    if (d.status !== 0 || Number(d.text) !== op.dev || !fm.moveItemAtPathToPathError($(op.from),$(op.to),null)) fail('credential rename failed')
  } else {
    var current=authStamp(op.path,canonical,uid)
    if (op.kind === 'link') {
      if (current.kind === 'home-link') return
      if (current.kind !== 'absent' || !fm.createSymbolicLinkAtPathWithDestinationPathError($(op.path),$(op.target),null)) fail('credential link conflict')
    } else {
      if (current.kind === 'absent') return
      if (current.kind !== 'home-link' || !fm.removeItemAtPathError($(op.path),null)) fail('credential unlink conflict')
    }
  }
  if (taskText('/bin/sync',[]).status !== 0) fail('credential rename sync')
}
function accountProjection(root,db) {
  var doc=accountRead(db), prior=asql(db,"SELECT body FROM projection WHERE name='registry';"), current=json(root+'/accounts.json',4000000)
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(doc.registry) && (!prior.length || JSON.stringify(current) !== prior[0].body)) fail('account projection edited outside CLI')
  writeJson(root+'/accounts.json',doc.registry)
  atx(db,"INSERT INTO projection(name,revision,body) VALUES('registry',"+doc.revision+','+aq(JSON.stringify(doc.registry))+") ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,body=excluded.body;")
}
function finishAccount(root,canonical,db,uid) {
  var doc=accountRead(db), s=doc.state, path=root+'/account-switch.json'
  if (s.sealed) authPrefix(root,canonical,doc.registry,Object.assign({},s.sealed,{from:s.intent.from,to:s.intent.to}),[s.phase === 'cleanup-commit' ? s.sealed.operations.length : 0],uid)
  authLayout(root,canonical,doc.registry,uid)
  accountProjection(root,db)
  if (attr(path) && !fm.removeItemAtPathError($(path),null)) fail('account journal cleanup')
  if (taskText('/bin/sync',[]).status !== 0) fail('account cleanup sync')
  doc=accountRead(db)
  accountSave(db,doc,{active:doc.registry.active,generation:doc.registry.generation,phase:'stopped',owner:doc.state.owner,intent:{from:doc.registry.active,to:doc.registry.home,reason:'off'}})
}
function recoverAccountJournal(root,canonical,db,uid) {
  var doc=accountRead(db), s=doc.state, r=doc.registry, j=json(root+'/account-switch.json',4000000)
  if (!j) {
    if (s.phase === 'journal' || s.phase === 'rolling-back' || ['sealed','cleanup-commit','cleanup-rollback'].indexOf(s.phase) >= 0 && !s.sealed) fail('account journal missing')
    finishAccount(root,canonical,db,uid); return
  }
  own(root+'/account-switch.json','NSFileTypeRegular',384,uid)
  if (j.version !== 1 || !obj(j.owner) || j.owner.transaction !== s.owner.transaction || !s.intent || j.from !== s.intent.from || j.to !== s.intent.to || !Number.isSafeInteger(j.generation) || (j.generation !== s.generation && j.generation+1 !== s.generation) || !Array.isArray(j.operations) || j.operations.length > 2 || !Number.isSafeInteger(j.next) || j.next < 0 || j.next > j.operations.length || !(j.reverseNext === null || Number.isSafeInteger(j.reverseNext) && j.reverseNext >= -1 && j.reverseNext < j.operations.length) || ['forward','rollback','committed'].indexOf(j.phase) < 0) fail('account journal structure')
  authPrefix(root,canonical,r,j,j.phase === 'rollback' && j.reverseNext !== null ? [Math.max(0,j.reverseNext),Math.max(0,j.reverseNext+1)] : [j.next,Math.min(j.next+1,j.operations.length)],uid)
  if (r.active === j.to && r.generation === j.generation+1) { finishAccount(root,canonical,db,uid); return }
  if (r.active !== j.from || r.generation !== j.generation) fail('account publication changed')
  j.owner=s.owner; j.phase='rollback'
  if (j.reverseNext === null) j.reverseNext=Math.min(j.next,j.operations.length-1)
  s.phase='rolling-back'; accountSave(db,doc,s)
  for (;j.reverseNext >= 0;j.reverseNext--) {
    writeJson(root+'/account-switch.json',j)
    var op=j.operations[j.reverseNext], inverse=op.kind === 'move' ? {kind:'move',from:op.to,to:op.from,dev:op.dev,ino:op.ino} : {kind:op.kind === 'link' ? 'unlink' : 'link',path:op.path,target:op.target}
    moveAuth(inverse,canonical,uid)
    writeJson(root+'/account-switch.json',Object.assign({},j,{reverseNext:j.reverseNext-1}))
  }
  doc=accountRead(db); doc.state.phase='cleanup-rollback'; accountSave(db,doc,doc.state)
  finishAccount(root,canonical,db,uid)
}
function recoverAccountHome(root,canonical,uid,pid,verifyOnly) {
  var db=root+'/accounts-state.sqlite'
  if (!attr(db)) { if (attr(root+'/accounts.json') || attr(root+'/account-switch.json')) fail('account ledger missing'); return }
  if (!absolute(canonical)) fail('canonical account home missing from recovery')
  own(db,'NSFileTypeRegular',384,uid)
  var doc=accountRead(db), s=doc.state, r=doc.registry
  if (verifyOnly) {
    if (r.active !== r.home || r.rotation.enabled || attr(root+'/account-switch.json')) fail('Home recovery incomplete')
    authLayout(root,canonical,r,uid); return
  }
  var identity=accountProcess(Number(pid))
  if (!identity) fail('account recovery owner unavailable')
  if (s.phase !== 'open' && (!obj(s.owner) || !accountDead(s.owner.process))) fail('live account transition owner')
  var owner={transaction:s.phase === 'open' ? ObjC.unwrap($.NSUUID.UUID.UUIDString).toLowerCase() : s.owner.transaction,claim:s.phase === 'open' ? 1 : s.owner.claim+1,process:identity}
  s.owner=owner
  if (s.phase === 'open') {
    if (attr(root+'/account-switch.json') || s.active !== r.active || s.generation !== r.generation) fail('unowned account transition')
    s.phase='draining'; s.intent={from:r.active,to:r.home,reason:'off'}
  }
  r.rotation.enabled=false; r.replay='none'
  accountSave(db,doc,s,"UPDATE metadata SET revision=revision+1,body="+aq(JSON.stringify(r))+" WHERE name='registry' AND revision="+doc.revision+';'+assertChanged())
  function retireDead() {
    var peers=asql(db,'SELECT body FROM participant;').map(function(row) { return JSON.parse(row.body) }), families=asql(db,'SELECT body FROM family;').map(function(row) { return JSON.parse(row.body) })
    peers.forEach(function(p) {
      if (!accountDead(p.process)) return
      families.filter(function(f) { return f.participant === p.id }).forEach(function(f) {
        if (f.native) accountFamilyDead(f.native,true)
        else if (!accountDead(f.supervisor)) fail('unlaunched family supervisor alive')
        atx(db,'DELETE FROM family WHERE id='+aq(f.id)+';')
      })
      atx(db,'DELETE FROM work WHERE participant='+aq(p.id)+';DELETE FROM participant WHERE id='+aq(p.id)+';')
    })
    families.filter(function(f) { return f.purpose === 'bootstrap' && f.participant === owner.transaction }).forEach(function(f) {
      if (!accountDead(f.supervisor)) fail('bootstrap supervisor alive')
      if (f.native) accountFamilyDead(f.native,true)
      atx(db,'DELETE FROM family WHERE id='+aq(f.id)+';')
    })
  }
  var deadline=Date.now()+30000
  do { retireDead(); if (!asql(db,'SELECT id FROM work;').length) break; if (Date.now() > deadline) fail('managed work still active'); $.NSThread.sleepForTimeInterval(0.05) } while (true)
  var peers=asql(db,'SELECT body FROM participant;').map(function(row) { return JSON.parse(row.body) })
  peers.forEach(function(p) { accountPeer(p,{command:'stop',owner:owner,generation:s.generation},root,uid) })
  retireDead()
  if (asql(db,'SELECT id FROM family;').length || asql(db,'SELECT id FROM work;').length) fail('credential holders remain')
  var interrupted=s.phase !== 'draining' && s.phase !== 'stopped'
  if (!interrupted) { doc=accountRead(db); doc.state.phase='stopped'; accountSave(db,doc,doc.state) }
  // Live participants retain their actual overlay manifest. Dead writers must already be shared.
  if (!interrupted) peers.forEach(function(p) { accountPeer(p,{command:'reconcile',owner:owner,generation:s.generation},root,uid) })
  var entries=ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError($(root+'/codex-home'),null))
  if (!Array.isArray(entries)) fail('overlay unavailable')
  entries.filter(function(name) { return name !== 'auth.json' }).forEach(function(name) {
    var path=root+'/codex-home/'+name, a=attr(path)
    if (!a || a.type !== 'NSFileTypeSymbolicLink' || ObjC.unwrap(fm.destinationOfSymbolicLinkAtPathError($(path),null)) !== canonical+'/'+name) fail('unshared overlay state; preserve both homes')
  })
  recoverAccountJournal(root,canonical,db,uid)
  doc=accountRead(db); r=doc.registry; s=doc.state
  if (r.active !== r.home) {
    owner={transaction:ObjC.unwrap($.NSUUID.UUID.UUIDString).toLowerCase(),claim:1,process:identity}
    s.owner=owner
    var overlay=root+'/codex-home/auth.json', stamp=authStamp(overlay,canonical,uid)
    var operations=[{kind:'move',from:overlay,to:root+'/accounts/openai/'+r.active+'/auth.json',dev:stamp.dev,ino:stamp.ino},{kind:'link',path:overlay,target:canonical+'/auth.json'}]
    var j={version:1,owner:owner,from:r.active,to:r.home,generation:r.generation,registryRevision:doc.revision,phase:'forward',operations:operations,next:0,reverseNext:null,inventory:authInventory(root,canonical,r,uid)}
    operations.forEach(function(op) { authOp(root,canonical,j,op) })
    s.phase='sealed'; s.intent={from:r.active,to:r.home,reason:'off'}; s.sealed={inventory:j.inventory,operations:operations}; accountSave(db,doc,s)
    writeJson(root+'/account-switch.json',j)
    doc=accountRead(db); doc.state.phase='journal'; accountSave(db,doc,doc.state)
    operations.forEach(function(op,i) { moveAuth(op,canonical,uid); j.next=i+1; writeJson(root+'/account-switch.json',j) })
    authPrefix(root,canonical,r,j,[2],uid)
    r.active=r.home; r.generation++; s.active=r.active; s.generation=r.generation; s.phase='cleanup-commit'
    doc=accountRead(db)
    accountSave(db,doc,s,"UPDATE metadata SET revision=revision+1,body="+aq(JSON.stringify(r))+" WHERE name='registry' AND revision="+doc.revision+';'+assertChanged()+
      'INSERT INTO rotation_event VALUES('+aq(owner.transaction)+','+r.generation+','+Date.now()+','+aq(JSON.stringify({from:j.from,to:j.to,reason:'off'}))+');')
    j.phase='committed'; writeJson(root+'/account-switch.json',j)
    finishAccount(root,canonical,db,uid)
  }
  // Retire old M3 launchers before reopening admission for later upgrades.
  peers.forEach(function(p) { accountPeer(p,{command:'retire',owner:owner,generation:accountRead(db).state.generation},root,uid) })
  if (asql(db,'SELECT id FROM participant;').length || asql(db,'SELECT id FROM family;').length || asql(db,'SELECT id FROM work;').length) fail('old managed participants remain')
  doc=accountRead(db); authLayout(root,canonical,doc.registry,uid)
  accountSave(db,doc,{active:doc.registry.active,generation:doc.registry.generation,phase:'open',owner:null,intent:null})
  accountProjection(root,db)
}
`
