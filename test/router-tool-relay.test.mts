import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib'
import { killChildren } from './helpers/children.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'
import { setup } from './helpers/trampoline-router.mjs'

after(killChildren)
after(removeTempDirs)

test('HTTP GPT strips bridge call ids from encoded bodies and preserves untouched encoded bytes', async (t) => {
  const h = await setup(t)
  const encoded = {
    gzip: gzipSync,
    deflate: deflateSync,
    br: brotliCompressSync,
    zstd: zstdCompressSync,
  }
  for (const [encoding, compress] of Object.entries(encoded)) {
    for (const changed of [false, true]) {
      const input = [
        {
          type: 'custom_tool_call',
          id: changed ? 'ctc_ae_1' : 'ctc_upstream_1',
          call_id: 'call_1',
          name: 'exec',
          namespace: 'functions',
          input: 'text(1)',
        },
      ]
      const raw = compress(
        Buffer.from(`{ "model": "gpt-6-sol", "input": ${JSON.stringify(input)} }\n`),
      )
      const response = await fetch(`${h.router.baseUrl}/responses`, {
        method: 'POST',
        body: raw,
        headers: {
          'content-encoding': encoding,
          'content-type': 'application/json',
          'content-length': String(raw.byteLength),
        },
      })
      assert.equal(response.status, 200)
      await response.text()
      const received = h.backend.requests.at(-1)
      assert.ok(received)
      if (changed) {
        assert.equal(received.headers['content-encoding'], undefined)
        assert.equal(Number(received.headers['content-length']), received.raw.byteLength)
        const actual = JSON.parse(received.raw.toString()).input[0]
        assert.deepEqual(actual, {
          type: 'custom_tool_call',
          call_id: 'call_1',
          name: 'exec',
          namespace: 'functions',
          input: 'text(1)',
        })
      } else {
        assert.equal(received.headers['content-encoding'], encoding)
        assert.deepEqual(received.raw, raw)
      }
    }
  }
})
