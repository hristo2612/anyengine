// Embedded system JXA: strict JSON authority and physical evidence admission.
// This code runs in /usr/bin/osascript, never Node, during disaster recovery.
export const recoveryEvidence = String.raw`
ObjC.import('Foundation')
var fm = $.NSFileManager.defaultManager
function fail(message) { throw new Error('invalid recovery evidence: ' + message) }
function obj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function keys(v, allowed) {
  if (!obj(v) || Object.keys(v).some(function(k) { return allowed.indexOf(k) < 0 })) fail('unsupported fields')
}
function text(v) { return typeof v === 'string' && v.length > 0 && !/[\0\r\n]/.test(v) }
function absolute(v) {
  return text(v) && v[0] === '/' && v !== '/' && v.split('/').slice(1).every(function(p) { return p && p !== '.' && p !== '..' })
}
function ordinary(p) { if (/\.(sqlite3?|db)(-(wal|shm|journal))?$/i.test(p)) fail('opaque SQLite path') }
function attr(p) {
  var a = fm.attributesOfItemAtPathError($(p), null)
  if (a.isNil()) {
    if (p === '/') fail('cannot inspect root')
    var cut = p.lastIndexOf('/'), parent = p.slice(0,cut) || '/', name = p.slice(cut+1), pa = attr(parent)
    if (!pa) return null
    if (pa.type !== 'NSFileTypeDirectory') fail('non-directory ancestor ' + parent)
    var listing = fm.contentsOfDirectoryAtPathError($(parent), null)
    if (listing.isNil() || ObjC.deepUnwrap(listing).indexOf(name) >= 0) fail('cannot inspect ' + p)
    return null
  }
  return { type: ObjC.unwrap(a.objectForKey($.NSFileType)), size: Number(ObjC.unwrap(a.objectForKey($.NSFileSize))), mode: Number(ObjC.unwrap(a.objectForKey($.NSFilePosixPermissions))) }
}
function directory(p) { var a = attr(p); if (!a || a.type !== 'NSFileTypeDirectory') fail('physical directory ' + p) }
function regular(p, bound) {
  ordinary(p)
  var a = attr(p)
  if (!a || a.type !== 'NSFileTypeRegular' || a.size > bound) fail('regular bounded file ' + p)
  return a
}
function read(p, bound) {
  regular(p, bound)
  var data = $.NSData.dataWithContentsOfFile($(p))
  if (data.isNil() || Number(data.length) > bound) fail('read ' + p)
  var decoded = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)
  if (decoded.isNil()) fail('UTF-8 ' + p)
  var result = ObjC.unwrap(decoded)
  // NSString strips an initial UTF-8 BOM. Preserve it as data, as Node's fatal
  // ignoreBOM decoder does, so JSON.parse rejects rather than normalizes it.
  if (Number(data.length) >= 3 && ObjC.unwrap(data.subdataWithRange($.NSMakeRange(0,3)).base64EncodedStringWithOptions(0)) === '77u/') result = '\uFEFF' + result
  return result
}
function json(p, bound) {
  if (!attr(p)) return undefined
  try { return JSON.parse(read(p, bound)) } catch (e) { fail('JSON/UTF-8 ' + p + ': ' + e.message) }
}
function q(v) { return "'" + String(v).replace(/'/g, "'\\''") + "'" }
function call(name, args) { return name + ' ' + args.map(q).join(' ') + '\n' }
function leaf(v) { return text(v) && v !== '.' && v !== '..' && v.indexOf('/') < 0 }
function mode(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 && v <= 4095 }
var blobs = []
function state(v, dir) {
  keys(v, ['kind','sha','link','bytes','mode'])
  if (v.kind === 'file') {
    if (typeof v.sha !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha) || !leaf(v.bytes) || !mode(v.mode) || v.link !== null) fail('file state')
    regular(dir + '/' + v.bytes, Infinity)
    blobs.push([dir + '/' + v.bytes, v.sha])
  } else if (v.kind === 'symlink') {
    if (!text(v.link) || v.sha !== null || v.bytes !== null || v.mode !== null) fail('link state')
  } else if (v.kind !== 'absent' || v.sha !== null || v.link !== null || v.bytes !== null || v.mode !== null) fail('absent state')
  return v
}
function before(c) { return { kind:c.before, sha:c.beforeSha, link:c.beforeLink, bytes:c.backup, mode:c.mode } }
function settled(c) { return { kind:c.afterLink !== null ? 'symlink' : c.afterSha !== null ? 'file' : 'absent', sha:c.afterSha, link:c.afterLink, bytes:c.after, mode:c.afterMode } }
function target(p, root) {
  if (!absolute(p)) fail('absolute target')
  ordinary(p)
  if (p === root || p === root + '/state' || p === root + '/state/layers.json' || p === root + '/RECOVER.txt' || p === root + '/recovery' || p.indexOf(root + '/recovery/') === 0) fail('recovery overlap')
}
function shared(s, dir) {
  if (s === null || s === undefined) return
  keys(s, ['target','pickFile','backup','removed'])
  if (!absolute(s.target) || !absolute(s.pickFile) || !leaf(s.backup) || !Array.isArray(s.removed)) fail('shared config')
  ordinary(s.target); ordinary(s.pickFile); regular(dir + '/' + s.backup, Infinity)
  s.removed.forEach(function(r) {
    keys(r,['key','value','index','text'])
    if (['model','review_model'].indexOf(r.key) < 0 || typeof r.value !== 'string' || typeof r.text !== 'string' || !Number.isSafeInteger(r.index) || r.index < 0) fail('shared row')
  })
}
function validateLayer(l, root) {
  keys(l,['name','rollbackDir','adoptedFrom','createdAt','changes','jobs','cleansCache','sharedConfig','pending','upgrade','claudeCode'])
  var dir = l.rollbackDir
  if (['adapter','router','claude-code'].indexOf(l.name) < 0 || !absolute(dir) || !text(l.createdAt) || !isFinite(Date.parse(l.createdAt)) || !Array.isArray(l.changes) || !Array.isArray(l.jobs) || !l.jobs.every(text) || typeof l.cleansCache !== 'boolean') fail('layer structure')
  var parent = dir.slice(0,dir.lastIndexOf('/'))
  if (!(parent === root + '/recovery/layers' || (parent === root && /^rollback-[a-zA-Z0-9_-]+$/.test(dir.slice(parent.length+1))))) fail('owned rollback directory')
  for (var p = dir; p !== root; p = p.slice(0,p.lastIndexOf('/'))) directory(p)
  if (!(l.adoptedFrom === null || absolute(l.adoptedFrom)) || [undefined,null,'after-quit'].indexOf(l.pending) < 0) fail('layer origin/phase')
  var marker = attr(dir + '/POPPED')
  if (marker && (marker.type !== 'NSFileTypeRegular' || marker.size !== 0)) fail('POPPED')
  shared(l.sharedConfig,dir)
  var seen = []
  l.changes.forEach(function(c) {
    keys(c,['target','before','backup','after','mode','beforeSha','afterSha','beforeLink','afterLink','afterMode','pending','lastGood'])
    target(c.target,root)
    if (seen.indexOf(c.target) >= 0) fail('duplicate target')
    seen.push(c.target)
    state(before(c),dir); state(settled(c),dir)
    if (c.pending !== null) state(c.pending,dir)
    if (c.lastGood !== undefined) state(c.lastGood,dir)
  })
  if (l.upgrade !== undefined) {
    var u = l.upgrade
    keys(u,['createdAt','jobs','cleansCache','sharedConfig','claudeCode'])
    if (!text(u.createdAt) || !isFinite(Date.parse(u.createdAt)) || !Array.isArray(u.jobs) || !u.jobs.every(text) || typeof u.cleansCache !== 'boolean' || l.changes.some(function(c) { return c.lastGood === undefined })) fail('last-good upgrade')
    shared(u.sharedConfig,dir)
    if (u.claudeCode !== undefined && typeof validateClaudeDescriptor === 'function') validateClaudeDescriptor({name:l.name,claudeCode:u.claudeCode})
  } else if (l.changes.some(function(c) { return c.lastGood !== undefined })) fail('last-good without upgrade')
  if (typeof validateClaudeDescriptor === 'function') validateClaudeDescriptor(l)
  return !!marker
}
function journal(root) {
  if (!absolute(root)) fail('root')
  directory(root)
  if (attr(root + '/state')) directory(root + '/state')
  var f = json(root + '/state/layers.json',2000000)
  if (f === undefined) return {version:1,layers:[],absent:true}
  keys(f,['version','layers','recovery'])
  if (f.version !== 1 || !Array.isArray(f.layers)) fail('journal version/layers')
  var names = []
  f.layers.forEach(function(l) {
    if (names.indexOf(l.name) >= 0) fail('duplicate layer')
    names.push(l.name)
    l.isPopped = validateLayer(l,root)
  })
  if (f.recovery !== undefined) {
    var r = f.recovery
    keys(r,['entry','controlLib','pinnedLibs'])
    if (r.entry !== root + '/recovery/anyengine-off' || !absolute(r.controlLib) || !Array.isArray(r.pinnedLibs) || !r.pinnedLibs.every(absolute) || r.pinnedLibs.indexOf(r.controlLib) < 0) fail('recovery pins')
  }
  return f
}
function args(s,dir) { return [s.kind,s.sha || '',s.link || '',s.bytes ? dir + '/' + s.bytes : '',s.mode === null ? '' : s.mode.toString(8)] }
function plan(root, selector, baseline) {
  var f = journal(root)
  if (f.absent) return 'JOURNAL_ABSENT=1\n'
  var out = 'JOURNAL_ABSENT=0\n', active = f.layers.filter(function(l) { return !l.isPopped })
  var selected = active.filter(function(l) { return selector === 'all' || (selector === 'router' && ['router','claude-code'].indexOf(l.name) >= 0) || selector === l.rollbackDir }).reverse()
  if (selector !== 'all' && selector !== 'router' && !f.layers.some(function(l) { return l.rollbackDir === selector })) fail('unrecorded direct layer')
  if (baseline === 'last-good') {
    selected = selected.filter(function(l) { return l.name === 'router' })
    if (selected.length !== 1 || !selected[0].upgrade) fail('missing last-good checkpoint')
  }
  selected.forEach(function(l) { if (l.name === 'claude-code') claudePlanLayer(l) })
  selected.sort(function(a,b) { return Number(b.name === 'claude-code') - Number(a.name === 'claude-code') })
  blobs.forEach(function(b) { out += call('verify_blob',b) })
  // The first writer in the initial ladder owns the terminal public baseline.
  // Keep POPPED records here: a retirement retry must still prove that origin.
  out += 'PUBLIC_BASE=()\n'
  f.layers.some(function(l) {
    var c = l.changes.find(function(c) { return c.target === root + '/bin/anyengine-off' })
    if (!c) return false
    out += 'PUBLIC_BASE=(' + args(before(c),l.rollbackDir).map(q).join(' ') + ')\n'
    return true
  })
  out += 'LAYER_DIRS=(); LAYER_NAMES=(); FILE_OK=()\n'
  selected.forEach(function(l, n) {
    var dir = l.rollbackDir
    out += 'LAYER_DIRS['+n+']=' + q(dir) + '\nLAYER_NAMES['+n+']=' + q(l.name) + '\n'
    out += 'files_'+n+'() {\n  RC_OK=1; RC_BLOCKED=0; FAILED=0\n'
    var changes = l.changes.slice().reverse()
    changes.sort(function(a,b) { return Number(/\/(\.zshrc|\.bash_profile)$/.test(b.target)) - Number(/\/(\.zshrc|\.bash_profile)$/.test(a.target)) })
    var claude = l.name === 'claude-code' ? claudePlanLayer(l) : null
    changes.forEach(function(c) {
      if (claude && c === claude.change) {
        var observed=claude.observed, b=before(c), a=settled(c)
        out += call('restore_claude',[dir,c.target,observed.kind,observed.sha || '',observed.mode === null ? '600' : observed.mode.toString(8),b.kind,b.sha || '',b.bytes ? dir+'/'+b.bytes : '',b.mode === null ? '' : b.mode.toString(8),a.sha,dir+'/'+a.bytes,a.mode.toString(8),claude.exact ? '1' : '0'])
        return
      }
      var base = baseline === 'last-good' ? c.lastGood : before(c)
      var states = [settled(c), c.pending || settled(c), c.lastGood || settled(c)]
      out += call('restore',[c.target,/\/(\.zshrc|\.bash_profile)$/.test(c.target) ? 'rc' : claude ? 'claude' : 'file'].concat(args(base,dir),args(states[0],dir),args(states[1],dir),args(states[2],dir)))
      if (/\/(\.zshrc|\.bash_profile)$/.test(c.target)) out += '[ "$RC_OK" = 1 ] || RC_BLOCKED=1\n'
    })
    out += 'return "$FAILED"; }\n'
    out += 'after_'+n+'() {\n  FAILED=0\n'
    l.jobs.forEach(function(job) {
      var prior = baseline === 'last-good' && l.upgrade.jobs.indexOf(job) >= 0
      var plists = l.changes.filter(function(c) { return c.target.slice(-('/Library/LaunchAgents/' + job + '.plist').length) === '/Library/LaunchAgents/' + job + '.plist' })
      if (prior && plists.length > 1) fail('ambiguous prior job plist')
      var plist = plists[0]
      if (prior && plist) {
        if (!plist.lastGood) fail('missing prior job plist state')
        prior = plist.lastGood.kind !== 'absent'
      }
      out += call(prior ? 'restart_job' : 'stop_job',[job].concat(prior && plist ? [plist.target] : []))
    })
    if (baseline === 'last-good' && JSON.stringify(l.sharedConfig || null) !== JSON.stringify(l.upgrade.sharedConfig)) fail('unsupported changed upgrade shared config')
    if (l.sharedConfig && baseline !== 'last-good') out += call('restore_shared',[l.sharedConfig.target,l.sharedConfig.pickFile,JSON.stringify(l.sharedConfig.removed)])
    if (l.cleansCache) out += call('clean_cache',[dir])
    out += 'return "$FAILED"; }\n'
  })
  out += 'TOTAL_ACTIVE=' + active.length + '\n'
  return out
}
`
