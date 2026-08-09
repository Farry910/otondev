/**
 * Smallest possible question, asked first: can this machine open a Ditto instance and write a
 * record with no cloud account, no App ID from the portal, and no offline licence token?
 *
 * If the answer is no, every later test in this spike is unreachable and that fact belongs in
 * FINDINGS.md immediately rather than after a day of harness building.
 */
import { Ditto, DittoConfig } from '@dittolive/ditto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const persistence = mkdtempSync(join(tmpdir(), 'ditto-smoke-'))

async function main(): Promise<void> {
  console.log('SDK version        :', Ditto.VERSION)
  console.log('default root dir   :', Ditto.DEFAULT_ROOT_DIRECTORY)

  const config = new DittoConfig(
    // A database ID must be a UUID. Peers only sync with peers sharing this ID, so a fixed
    // constant is what makes two local instances members of the same logical database.
    '0f3d5b0e-6a1b-4c2f-9f77-1a0f2c3d4e5b',
    { mode: 'smallPeersOnly', privateKey: null },
    persistence,
  )

  console.log('requires licence?  :', (config as unknown as { requiresOfflineLicenseToken: boolean })
    .requiresOfflineLicenseToken)

  const ditto = await Ditto.open(config)
  console.log('opened             : yes')
  console.log('persistence dir    :', ditto.absolutePersistenceDirectory)
  console.log('is activated       :', ditto.isActivated)

  await ditto.store.execute(
    'INSERT INTO memory DOCUMENTS (:doc)',
    { doc: { _id: 'smoke-1', kind: 'fact', text: 'ditto is reachable offline' } },
  )
  const result = await ditto.store.execute('SELECT * FROM memory WHERE _id = :id', { id: 'smoke-1' })
  console.log('round-tripped rows :', result.items.length)
  console.log('row                :', JSON.stringify(result.items[0]?.value))

  await ditto.close()
  console.log('RESULT             : offline smallPeersOnly works with no credentials')
}

main()
  .catch((error: unknown) => {
    const err = error as { name?: string; code?: string; message?: string }
    console.log('RESULT             : FAILED')
    console.log('error name         :', err.name)
    console.log('error code         :', err.code)
    console.log('error message      :', err.message)
    process.exitCode = 1
  })
  .finally(() => {
    rmSync(persistence, { recursive: true, force: true })
  })
