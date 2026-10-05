import { accountRecoveryJxa } from './control-account-recovery-jxa.mjs'
import { m2RecoveryJxa } from './control-m2-recovery-jxa.mjs'

// Same restoration primitives, a separate authority, and no pre-M2 Claude undo.
const authority = m2RecoveryJxa
  .replaceAll('/recovery/m2', '/recovery/m3')
  .replaceAll('/m2-upgrade.json', '/m3-upgrade.json')
  .replaceAll('m2BaselineId', 'm3BaselineId')
  .replace("marker.state.failureTarget !== 'm2'", "marker.state.failureTarget !== 'm3'")
  .replace(
    "if (!allowed) fail('M2 target outside install')",
    `
    allowed=allowed || t === j.home+'/.claude/settings.json' ||
      t.slice(0,t.lastIndexOf('/')) === j.home+'/.claude/agents' && /^gpt-[a-zA-Z0-9._-]+\\.md$/.test(t.slice(t.lastIndexOf('/')+1))
    if (!allowed || t.indexOf(root+'/recovery/m2/') === 0) fail('M3 target outside install')`,
  )
  .replace(
    "out+='restore_controls()",
    `out+='preflight_controls() {\\n'
  b.controlChanges.forEach(function(c) {
    if (c.target === j.home+'/.claude/settings.json') {
      out+=call('jxa',['settings-check',root,id,uid]); return
    }
    var states=[before(c),settled(c),c.pending].filter(function(s) { return s !== null })
    out+=states.map(function(s) { return call('matches',[c.target].concat(args(s,b.rollbackDir))).trimEnd() }).join(' || ')+
      ' || { error '+q('edited control '+c.target)+'; return 1; }\\n'
  })
  out+='}\\n'
  out+='restore_controls()`,
  )
  .replace(
    'var a=settled(c), p=c.pending || a; out+=call',
    "if (c.target === j.home+'/.claude/settings.json') { out+=call('jxa',['settings-restore',root,id,uid]); return } var a=settled(c), p=c.pending || a; out+=call",
  )
  .replace(
    "out+=call('matches',[c.target].concat(args(before(c),b.rollbackDir)))",
    "if (c.target === j.home+'/.claude/settings.json') { out+=call('jxa',['settings-verify',root,id,uid]); return } out+=call('matches',[c.target].concat(args(before(c),b.rollbackDir)))",
  )
  .replace('function run(argv) {\n  var op=argv[0]', 'function m3BaseRun(argv) {\n  var op=argv[0]')

export const m3RecoveryJxa = `${authority}\n${accountRecoveryJxa}\n${String.raw`
function m3SettingsResult(root,id,uid) {
  var j=m2Record(root,id,uid), b=j.baseline
  var c=b.controlChanges.filter(function(c) { return c.target === j.home+'/.claude/settings.json' })[0]
  if (!c || c.before !== 'file') fail('M3 settings baseline missing')
  own(c.target,'NSFileTypeRegular',null,uid)
  var current=m2Settings(json(c.target,2000000)), prior=m2Settings(json(b.rollbackDir+'/'+c.backup,2000000))
  var variants=[settled(c),c.pending].filter(function(s) { return s && s.kind === 'file' }).map(function(s) { return m2Settings(json(b.rollbackDir+'/'+s.bytes,2000000)) })
  var changed=variants.filter(function(v) { return !m2Equal(v,prior) })
  if (changed.length) variants=changed
  var result=null
  variants.some(function(installed) {
    var owned=m2Rows(installed).map(function(r) { return r.model }).filter(function(id) { return /^gpt-/.test(id) })
    var merged=mergeClaudeSettings(current,prior,installed,owned), rows=m2Rows(merged.value).slice()
    // M3 can update existing GPT rows as catalogs change; M2's remover only owns new rows.
    Array.from(new Set(m2Rows(prior).map(function(r) { return r.model }))).forEach(function(model) {
      var beforeRows=m2Rows(prior).filter(function(r) { return r.model === model }), afterRows=m2Rows(installed).filter(function(r) { return r.model === model })
      if (m2Equal(beforeRows,afterRows)) return
      var observed=m2Rows(current).filter(function(r) { return r.model === model })
      if (m2Equal(observed,beforeRows)) return
      if (!m2Equal(observed,afterRows)) { merged.conflicts.push('modelPicker.options:'+model); return }
      var index=rows.findIndex(function(r) { return r.model === model })
      rows=rows.filter(function(r) { return r.model !== model })
      rows.splice.apply(rows,[index < 0 ? rows.length : index,0].concat(beforeRows))
    })
    if (merged.conflicts.length) return false
    if (rows.length || Object.prototype.hasOwnProperty.call(prior.modelPicker || {},'options')) {
      merged.value.modelPicker=merged.value.modelPicker || {}; merged.value.modelPicker.options=rows
    }
    result={journal:j,change:c,current:current,value:merged.value}; return true
  })
  if (!result) fail('edited owned M3 Claude settings')
  return result
}
function m3SettingsControl(root,id,uid,op) {
  currentM2(root,id,uid)
  var p=m3SettingsResult(root,id,uid)
  if (op === 'settings-check') return
  if (op === 'settings-verify') { if (!m2Equal(p.current,p.value)) fail('M3 settings not restored'); return }
  if (m2Equal(p.current,p.value)) return
  var j=p.journal, c=p.change, mode=attr(c.target).mode, old=taskText('/usr/bin/shasum',['-a','256',c.target]).text.slice(0,64)
  var name='m3-settings-'+ObjC.unwrap($.NSUUID.UUID.UUIDString)+'.blob', blob=j.baseline.rollbackDir+'/'+name
  writeJson(blob,p.value)
  var hash=taskText('/usr/bin/shasum',['-a','256',blob]).text.slice(0,64)
  if (!/^[a-f0-9]{64}$/.test(old) || !/^[a-f0-9]{64}$/.test(hash)) fail('M3 settings inspection')
  c.pending={kind:'file',sha:hash,link:null,bytes:name,mode:mode}; saveM2(root,j)
  if (taskText('/bin/sync',[]).status !== 0 || taskText('/usr/bin/shasum',['-a','256',c.target]).text.slice(0,64) !== old) fail('concurrent Claude edit')
  var tmp=c.target+'.m3-'+ObjC.unwrap($.NSUUID.UUID.UUIDString)
  if (taskText('/usr/bin/install',['-m',mode.toString(8),blob,tmp]).status !== 0 || taskText('/bin/mv',['-fh',tmp,c.target]).status !== 0 || taskText('/bin/sync',[]).status !== 0) fail('M3 settings restore')
}
function m3ClaudeFace(root,id,uid,path) {
  var j=m2Record(root,id,uid), view=json(path,128000), layers=json(j.baseline.m1LayersBackup,2000000)
  var layer=layers.layers.filter(function(l) { return l.name === 'claude-code' })[0]
  if (!layer || !obj(layer.claudeCode) || !Array.isArray(layer.claudeCode.ownedModels) || !obj(view) || !Array.isArray(view.models) || !view.models.length || !view.models.every(function(m) { return obj(m) && /^gpt-/.test(m.id) })) fail('M2 Claude catalog face unavailable')
  var settings=json(j.home+'/.claude/settings.json',2000000)
  if (!obj(settings) || !obj(settings.env) || settings.env.ANTHROPIC_BASE_URL !== 'http://127.0.0.1:'+j.port || !obj(settings.modelPicker) || !Array.isArray(settings.modelPicker.options)) fail('M2 Claude routing settings unavailable')
  layer.claudeCode.ownedModels.forEach(function(id) {
    if (!settings.modelPicker.options.some(function(row) { return row.model === id })) fail('M2 picker model missing')
  })
}
function run(argv) {
  if (['settings-check','settings-restore','settings-verify'].indexOf(argv[0]) >= 0) return m3SettingsControl(argv[1],argv[2],argv[3],argv[0])
  if (argv[0] === 'accounts-home' || argv[0] === 'accounts-verify') {
    var j=m2Record(argv[1],argv[2],argv[3]); currentM2(argv[1],argv[2],argv[3])
    return recoverAccountHome(argv[1],j.canonical,argv[3],argv[4],argv[0] === 'accounts-verify')
  }
  if (argv[0] === 'claude-face') return m3ClaudeFace(argv[1],argv[2],argv[3],argv[4])
  // M3 preserves proven/degraded evidence and the pre-existing Claude layer.
  if (['m1-evidence','evidence-gate','claude-plan','claude-merge','claude-exact'].indexOf(argv[0]) >= 0) fail('M2-only operation in M3 recovery')
  return m3BaseRun(argv)
}
`}`
