// One-off, run inside the appview container: re-send the magic link for a custodial account
// whose first signup minted the account but failed at the mail step.
import { eq } from 'drizzle-orm'
import { getDb, closeDb } from '../src/db/index.ts'
import { custodialAccount } from '../src/db/schema.ts'
import { sendVerificationEmail } from '../src/lib/custody.ts'
const email = process.env.TARGET_EMAIL!.trim().toLowerCase()
const rows = await getDb().select({ did: custodialAccount.did, handle: custodialAccount.handle }).from(custodialAccount).where(eq(custodialAccount.email, email)).limit(1)
if (!rows[0]) { console.log('no custodial account for that email'); process.exit(2) }
try { await sendVerificationEmail(rows[0].did, email); console.log('mail sent', rows[0].did, rows[0].handle) }
catch (e: any) { console.log('mail FAILED:', e?.name, e?.code, String(e?.message).slice(0, 300)) }
await closeDb()
