import { m2RecoveryJxa } from './control-m2-recovery-jxa.mjs'

// Reuse the private journal's existing physical admission and bounded readers.
// Broad retirement never invokes the M2 restore engine or shared flip marker.
const authority =
  m2RecoveryJxa.slice(
    m2RecoveryJxa.indexOf('\nfunction own('),
    m2RecoveryJxa.indexOf('\nfunction libraryPlan('),
  ) +
  m2RecoveryJxa.slice(
    m2RecoveryJxa.indexOf('\nfunction m2Record('),
    m2RecoveryJxa.indexOf('\nfunction m2Plan('),
  )

export const m2RetirementJxa = `${authority}
function m2RetirementHash(path) {
  regular(path,2000000)
  var result=taskText('/usr/bin/shasum',['-a','256',path]), hash=result.text.slice(0,64)
  if (result.status !== 0 || !/^[a-f0-9]{64}$/.test(hash)) fail('M2 retirement hash '+path)
  return hash
}
function m2RetirementIdentity(path) {
  var result=taskText('/usr/bin/stat',['-f','%d:%i',path])
  if (result.status !== 0 || !/^[0-9]+:[0-9]+$/.test(result.text)) fail('M2 reference identity')
  return result.text
}
function m2RetirementAuthority(root) {
  var path=root+'/m2-upgrade.json'
  if (!attr(path)) return null
  var who=taskText('/usr/bin/id',['-u'])
  if (who.status !== 0 || !/^[0-9]+$/.test(who.text)) fail('M2 retirement owner')
  var uid=Number(who.text)
  own(path,'NSFileTypeRegular',384,uid)
  var record=json(path,2000000), dir=root+'/recovery/m2'
  if (!obj(record) || !absolute(record.rollbackDir) || record.rollbackDir.slice(0,record.rollbackDir.lastIndexOf('/')) !== dir) fail('M2 retirement reference')
  var id=record.rollbackDir.slice(record.rollbackDir.lastIndexOf('/')+1), j=m2Record(root,id,uid,true), p=currentM2(root,id,uid)
  if (!m2Equal(record,j.baseline) || (j.retired !== undefined && typeof j.retired !== 'boolean') || (j.retired === true && j.checkpoint !== 'broad-off')) fail('M2 retirement journal/reference mismatch')
  own(dir+'/recover.sh','NSFileTypeRegular',448,uid)
  if (m2RetirementHash(p.script) !== p.scriptSha256 || m2RetirementHash(j.baseline.m1LayersBackup) !== j.baseline.m1LayersSha256 || m2RetirementHash(j.baseline.priorLib+'/install-manifest.json') !== j.manifestSha256) fail('M2 immutable recovery evidence changed')
  j.baseline.controlChanges.forEach(function(c) {
    [before(c),settled(c),c.pending].forEach(function(s) {
      if (!s || s.kind !== 'file') return
      var blob=j.baseline.rollbackDir+'/'+s.bytes
      own(blob,'NSFileTypeRegular',384,uid)
      if (m2RetirementHash(blob) !== s.sha) fail('M2 private control evidence changed')
    })
  })
  return {journal:j,receipt:{baselineId:id,recordSha:m2RetirementHash(path),recordIdentity:m2RetirementIdentity(path),journalSha:m2RetirementHash(p.journal),pointerSha:m2RetirementHash(dir+'/current.json')}}
}
function m2RetirementAdmit(root) {
  var admitted=m2RetirementAuthority(root)
  return JSON.stringify(admitted ? admitted.receipt : null)
}
function m2RetirementFinish(root,receiptPath) {
  var receipt=json(receiptPath,100000), admitted=m2RetirementAuthority(root)
  if (receipt === null) { if (admitted !== null) fail('M2 reference appeared during broad removal'); return }
  if (!admitted || !m2Equal(receipt,admitted.receipt)) fail('M2 authority changed during broad removal')
  var file=journal(root)
  if (file.layers.some(function(l) { return !l.isPopped && ['router','claude-code'].indexOf(l.name) >= 0 })) fail('routing remains active; retain M2 pin')
  var j=admitted.journal, path=root+'/m2-upgrade.json', dir=root+'/recovery/m2'
  j.retired=true; j.checkpoint='broad-off'
  writeJson(j.baseline.recoveryJournal,j)
  if (taskText('/bin/sync',[]).status !== 0) fail('M2 retirement checkpoint sync')
  // Recheck the public inode and pointer after the durable private checkpoint.
  if (m2RetirementHash(path) !== receipt.recordSha || m2RetirementIdentity(path) !== receipt.recordIdentity || m2RetirementHash(dir+'/current.json') !== receipt.pointerSha) fail('M2 reference superseded before retirement')
  if (!fm.removeItemAtPathError($(path),null)) fail('M2 reference retirement')
}
`
