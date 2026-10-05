// Shared system-JXA JSON merge for M2-only and broad recovery. It mirrors the
// pure settings policy; callers own physical admission, hashes and publication.
export const m2ClaudeMergeJxa = `
function m2Equal(a,b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  var ak = Object.keys(a).sort(), bk = Object.keys(b).sort()
  return ak.length === bk.length && ak.every(function(k,i) { return k === bk[i] && m2Equal(a[k],b[k]) })
}
function m2Settings(v) {
  if (!obj(v) || (Object.prototype.hasOwnProperty.call(v,'env') && !obj(v.env))) fail('Claude settings object/env')
  if (Object.prototype.hasOwnProperty.call(v,'modelPicker')) {
    if (!obj(v.modelPicker)) fail('Claude picker object')
    var rows = v.modelPicker.options
    if (rows !== undefined && (!Array.isArray(rows) || !rows.every(function(r) { return obj(r) && text(r.model) }))) fail('Claude picker options')
  }
  return v
}
function m2Rows(v) { return v.modelPicker && v.modelPicker.options || [] }
function m2Leaf(a,b,k) { return Object.prototype.hasOwnProperty.call(a,k) === Object.prototype.hasOwnProperty.call(b,k) && m2Equal(a[k],b[k]) }
function m2RestoreLeaf(v,b,k) {
  if (Object.prototype.hasOwnProperty.call(b,k)) Object.defineProperty(v,k,{value:JSON.parse(JSON.stringify(b[k])),writable:true,configurable:true,enumerable:true})
  else delete v[k]
}
function mergeClaudeSettings(current,before,after,ownedModels) {
  [current,before,after].forEach(m2Settings)
  var value = JSON.parse(JSON.stringify(current)), conflicts = []
  var owned = ownedModels.filter(function(id) { return !m2Rows(before).some(function(r) { return r.model === id }) && m2Rows(after).some(function(r) { return r.model === id }) })
  var env = value.env || {}, priorEnv = before.env || {}, afterEnv = after.env || {};
  ['ANTHROPIC_BASE_URL','ANTHROPIC_DEFAULT_HAIKU_MODEL','CLAUDE_CODE_GATEWAY_HINT_HEADERS'].forEach(function(k) {
    if (m2Leaf(priorEnv,afterEnv,k)) return
    if (m2Leaf(env,afterEnv,k)) m2RestoreLeaf(env,priorEnv,k)
    else if (!m2Leaf(env,priorEnv,k)) conflicts.push('env.'+k)
  })
  if (Object.keys(env).length) value.env = env
  else if (!Object.prototype.hasOwnProperty.call(before,'env')) delete value.env
  var rows = m2Rows(value).slice()
  owned.forEach(function(id) {
    var installed = m2Rows(after).filter(function(r) { return r.model === id })[0], found = -1
    rows.some(function(r,i) { if (r.model === id && m2Equal(r,installed)) { found=i; return true } return false })
    if (found >= 0) rows.splice(found,1)
    else if (rows.some(function(r) { return r.model === id })) conflicts.push('modelPicker.options:'+id)
  })
  var picker = value.modelPicker || {}
  if (rows.length || Object.prototype.hasOwnProperty.call(before.modelPicker || {},'options')) picker.options=rows
  else delete picker.options
  if (Object.keys(picker).length) value.modelPicker=picker
  else if (!Object.prototype.hasOwnProperty.call(before,'modelPicker')) delete value.modelPicker
  if (typeof value.model === 'string' && owned.indexOf(value.model) >= 0) m2RestoreLeaf(value,before,'model')
  if (!m2Leaf(priorEnv,afterEnv,'ANTHROPIC_MODEL') && owned.indexOf(afterEnv.ANTHROPIC_MODEL) >= 0 && owned.indexOf(env.ANTHROPIC_MODEL) >= 0) {
    m2RestoreLeaf(env,priorEnv,'ANTHROPIC_MODEL')
    if (Object.keys(env).length) value.env=env
    else if (!Object.prototype.hasOwnProperty.call(before,'env')) delete value.env
  }
  return {value:value,conflicts:conflicts}
}
`
