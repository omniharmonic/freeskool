// Minimal standalone did:plc directory for the Spaces-alpha lab.
// Mirrors packages/dev-env/src/plc.ts from the atproto permissioned-data branch:
// an in-memory (mock) database, so no Postgres is required.
import * as plc from '@did-plc/server'

const PORT = Number(process.env.PLC_PORT ?? 2582)

const db = plc.Database.mock()
const server = plc.PlcServer.create({ db, port: PORT })
await server.start()
console.log(`[plc] did:plc directory listening on http://0.0.0.0:${PORT}`)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await server.destroy()
    process.exit(0)
  })
}
