// Text decisions embedded in system JXA. Unsupported TOML refuses mutation;
// strings and arrays are scanned as values, never searched for model lines.
export const recoveryText = String.raw`
function emit(s) { $.NSFileHandle.fileHandleWithStandardOutput.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding)) }
function stringEnd(s, start) {
  var quote = s[start], triple = s.slice(start,start+3) === quote+quote+quote, width = triple ? 3 : 1, i = start+width
  while (i < s.length) {
    if (quote === '"' && s[i] === '\\') { i += 2; continue }
    if (s.slice(i,i+width) === quote.repeat(width)) {
      i += width
      if (triple) for (var extra = 0; extra < 2 && s[i] === quote; extra++) i++
      return i
    }
    if (!triple && /[\r\n]/.test(s[i])) fail('TOML newline in string')
    i++
  }
  fail('TOML unterminated string')
}
function stringValue(s) {
  var quote = s[0], triple = s.slice(0,3) === quote.repeat(3), width = triple ? 3 : 1
  var body = s.slice(width,-width)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) fail('TOML control character')
  if (triple) body = body.replace(/^\r?\n/,'')
  if (quote === "'") return body
  if (/\\(?![btnfr"\\uU\r\n\t ])/.test(body)) fail('unsupported TOML escape')
  // Long Unicode escapes and continuation whitespace are conservatively refused.
  if (/\\U|\\[\r\n\t ]/.test(body)) fail('unsupported TOML escape')
  try { return JSON.parse('"' + body.replace(/\r/g,'\\r').replace(/\n/g,'\\n').replace(/\t/g,'\\t').replace(/(?<!\\)"/g,'\\"') + '"') }
  catch (_) { fail('TOML string') }
}
function keyParts(raw) {
  var out = [], i = 0
  while (i < raw.length) {
    while (/[ \t]/.test(raw[i] || '') && i < raw.length) i++
    if (raw[i] === '"' || raw[i] === "'") {
      var end = stringEnd(raw,i), token = raw.slice(i,end)
      if (token.slice(0,3) === token[0].repeat(3)) fail('TOML multiline key')
      out.push(stringValue(token)); i = end
    } else {
      var word = /^[a-zA-Z0-9_-]+/.exec(raw.slice(i))
      if (!word) fail('TOML key')
      out.push(word[0]); i += word[0].length
    }
    while (/[ \t]/.test(raw[i] || '') && i < raw.length) i++
    if (i === raw.length) break
    if (raw[i++] !== '.' || i === raw.length) fail('TOML dotted key')
  }
  if (!out.length) fail('TOML empty key')
  return out
}
function value(raw) {
  var i = 0
  function ws() {
    for (;;) {
      while (/\s/.test(raw[i] || '') && i < raw.length) i++
      if (raw[i] !== '#') break
      while (i < raw.length && raw[i] !== '\n') i++
    }
  }
  function item(depth) {
    if (depth > 32) fail('TOML nesting')
    ws()
    if (raw[i] === '"' || raw[i] === "'") { var end = stringEnd(raw,i), result = stringValue(raw.slice(i,end)); i = end; return result }
    if (raw[i] === '[') {
      i++; ws()
      while (raw[i] !== ']') {
        item(depth+1); ws()
        if (raw[i] === ']') break
        if (raw[i++] !== ',') fail('TOML array')
        ws()
      }
      i++; return null
    }
    var word = /^(?:true|false|[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(i))
    if (!word) fail('unsupported TOML value')
    i += word[0].length; return null
  }
  var result = item(0); ws()
  if (i !== raw.length) fail('unsupported TOML trailing value')
  return result
}
function scanToml(s) {
  var spans = [], start = 0, line = 0, index = 0, depth = 0
  for (var i = 0; i < s.length; i++) {
    var c = s[i]
    if (c === '"' || c === "'") { var end = stringEnd(s,i); line += (s.slice(i,end).match(/\n/g) || []).length; i = end-1 }
    else if (c === '#') { var e = s.indexOf('\n',i); i = (e < 0 ? s.length : e)-1 }
    else if (c === '[') depth++
    else if (c === ']') { depth--; if (depth < 0) fail('TOML bracket') }
    else if (c === '\n') {
      line++
      if (depth === 0) { spans.push({start:start,end:i+1,index:index,text:s.slice(start,i).replace(/\r$/,'')}); start=i+1; index=line }
    }
  }
  if (depth) fail('TOML bracket')
  if (start < s.length) spans.push({start:start,end:s.length,index:index,text:s.slice(start)})
  var firstTable = s.length, inTable = false, keysSeen = Object.create(null), top = Object.create(null), table = '', namespaces = Object.create(null), serial = 0
  var scope = [], scalars = [], tables = [], arrays = []
  function prefix(a,b) { return a.length <= b.length && a.every(function(part,n) { return part === b[n] }) }
  spans.forEach(function(span) {
    var t = span.text.trim()
    if (!t || t[0] === '#') return
    if (t[0] === '[') {
      var h = /^(\[\[?)([\s\S]*?)(\]\]?)\s*(?:#.*)?$/.exec(t)
      if (!h || h[1].length !== h[3].length) fail('TOML table')
      var parts = keyParts(h[2].trim())
      if (Object.prototype.hasOwnProperty.call(top,parts[0]) || scalars.some(function(p) { return prefix(p,parts) })) fail('TOML conflicting table')
      if (arrays.some(function(p) { return prefix(p,parts) && !(h[1] === '[[' && p.length === parts.length) })) fail('unsupported nested array table')
      var name = JSON.stringify(parts), kind = h[1] === '[[' ? 'array' : 'table', prior = namespaces[name]
      if (prior && !(kind === 'array' && prior === 'array') && !(kind === 'table' && prior === 'implicit')) fail('TOML conflicting table ownership')
      for (var n = 1; n < parts.length; n++) {
        var parent = JSON.stringify(parts.slice(0,n))
        if (namespaces[parent] === 'dotted') fail('unsupported dotted table ownership')
        if (!namespaces[parent]) namespaces[parent] = 'implicit'
      }
      namespaces[name] = kind
      scope = parts.slice()
      if (h[1] === '[[') { arrays.push(parts); scope.push('@array-' + (serial+1)) }
      tables.push(scope)
      table = name
      if (h[1] === '[[') table += ':' + (++serial)
      inTable = true; firstTable = Math.min(firstTable,span.start); return
    }
    var equal = -1
    for (var pos = 0; pos < t.length; pos++) {
      if (t[pos] === '"' || t[pos] === "'") pos = stringEnd(t,pos)-1
      else if (t[pos] === '=') { equal = pos; break }
      else if (t[pos] === '#') break
    }
    if (equal < 0) fail('TOML assignment')
    var key = keyParts(t.slice(0,equal)), id = table + JSON.stringify(key)
    if (Object.prototype.hasOwnProperty.call(keysSeen,id)) fail('TOML duplicate key')
    keysSeen[id] = true
    var full = scope.concat(key)
    if (scalars.some(function(p) { return prefix(p,full) || prefix(full,p) }) || tables.some(function(p) { return prefix(full,p) })) fail('TOML conflicting key')
    for (var n = scope.length+1; n < full.length; n++) {
      var parent = JSON.stringify(full.slice(0,n))
      if (namespaces[parent] && namespaces[parent] !== 'dotted') fail('unsupported dotted key ownership')
      namespaces[parent] = 'dotted'
    }
    scalars.push(full)
    var v = value(t.slice(equal+1))
    if (!inTable) {
      if (key.length !== 1) fail('unsupported top-level TOML dotted key')
      top[key[0]] = v
      if (['model','review_model'].indexOf(key[0]) >= 0 && typeof v !== 'string') fail('TOML model string')
    }
  })
  return {spans:spans,firstTable:firstTable,top:top}
}
function restoreToml(path,pickPath,rows) {
  var s = attr(path) ? read(path,2000000) : '', parsed = scanToml(s), pick = json(pickPath,2000000)
  if (pick !== undefined) {
    if (!obj(pick) || Object.keys(pick).some(function(k) { return ['model','review_model'].indexOf(k) < 0 || typeof pick[k] !== 'string' || !/^[A-Za-z0-9._:\/-]+$/.test(pick[k]) })) fail('app pick')
  }
  rows.forEach(function(row) {
    if (Object.prototype.hasOwnProperty.call(parsed.top,row.key)) return
    var v = pick && pick[row.key] !== undefined ? pick[row.key] : row.value
    if (!/^[A-Za-z0-9._:\/-]+$/.test(v)) fail('unsupported model value')
    var slot = parsed.spans.filter(function(p) { return p.index >= row.index })[0]
    var at = Math.min(parsed.firstTable,slot ? slot.start : s.length), nl = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n', lead = s.slice(0,at)
    s = lead + (lead && lead[lead.length-1] !== '\n' ? nl : '') + row.key + ' = "' + v + '"' + nl + s.slice(at)
    parsed = scanToml(s)
  })
  emit(s)
}
function revert(current,before,after) {
  var a = before.split('\n'), b = after.split('\n'), start = 0, ea = a.length, eb = b.length
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  while (ea > start && eb > start && a[ea-1] === b[eb-1]) { ea--; eb-- }
  if (start === ea && start === eb) return current
  var lead = start > 0 ? [b[start-1]] : [], trail = eb < b.length ? [b[eb]] : []
  var needle = lead.concat(b.slice(start,eb),trail).join('\n'), replacement = lead.concat(a.slice(start,ea),trail).join('\n'), first = current.indexOf(needle)
  if (first < 0 || current.indexOf(needle,first+1) >= 0 || (first > 0 && current[first-1] !== '\n')) return null
  var end = first+needle.length
  if (!needle.endsWith('\n') && end < current.length && current[end] !== '\n') return null
  return current.slice(0,first)+replacement+current.slice(end)
}
function hunk(paths) {
  var current = read(paths[0],999999), before = read(paths[1],999999), results = [], already = false
  if (current.indexOf('\0') >= 0 || before.indexOf('\0') >= 0) fail('binary hunk')
  paths.slice(2).forEach(function(path) {
    if (!path) return
    var after = read(path,999999)
    if (after === before || after.indexOf('\0') >= 0) return
    var r = revert(current,before,after)
    if (r !== null && results.indexOf(r) < 0) results.push(r)
    else if (r === null && revert(current,after,before) !== null) already = true
  })
  if (results.length === 1 && !already) emit(results[0])
  else if (results.length === 0 && already) emit(current)
  else fail('ambiguous or changed hunk')
}
function cache(path) {
  var f = json(path,16000000)
  if (f === undefined) return 'absent'
  if (!obj(f) || !Array.isArray(f.models) || (f.client_version !== undefined && typeof f.client_version !== 'string') || !f.models.every(function(m) { return obj(m) && typeof m.slug === 'string' && m.slug.length })) fail('models cache structure')
  return f.models.some(function(m) { return typeof m.description === 'string' && m.description.indexOf('via AnyEngine') >= 0 }) ? 'owned' : 'clean'
}
function run(argv) {
  if (argv[0] === 'kind') { ordinary(argv[1]); var a = attr(argv[1]); return a ? a.type : 'absent' }
  if (argv[0] === 'plan') return plan(argv[1],argv[2],argv[3])
  if (argv[0] === 'claude-merge') return claudeBroadMerge(argv[1],argv[2])
  if (argv[0] === 'claude-intent') { claudeBroadIntent(argv[1],argv[2],argv[3],argv[4],argv[5]); return }
  if (argv[0] === 'm2-retirement-admit') return m2RetirementAdmit(argv[1])
  if (argv[0] === 'm2-retirement-finish') { m2RetirementFinish(argv[1],argv[2]); return }
  if (argv[0] === 'hunk') { hunk(argv.slice(1)); return }
  if (argv[0] === 'toml') { restoreToml(argv[1],argv[2],JSON.parse(argv[3])); return }
  if (argv[0] === 'cache') return cache(argv[1])
  fail('unknown recovery operation')
}
`
