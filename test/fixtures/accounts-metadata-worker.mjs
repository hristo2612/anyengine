import { AccountMetadata } from '../../dist/src/accounts-metadata.mjs'
import { accountPaths } from '../../dist/src/accounts-store.mjs'

const [root, canonical, kind] = process.argv.slice(2)
process.send({ ready: true })
process.once('message', () => {
  const metadata = new AccountMetadata(accountPaths(root, canonical))
  metadata.editRegistry((r) => {
    if (kind === 'label') r.accounts[0].label = 'Updated'
    else r.rotation.enabled = true
    return r
  })
  process.send({ committed: true })
  if (kind === 'kill') return
  metadata.project()
  metadata.close()
  process.disconnect()
})
