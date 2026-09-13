#!/usr/bin/env node
// Seed freeschool.draft.skill records under an authority account. No deps beyond Node 22.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Lexicons } from '@atproto/lexicon'
const here = dirname(fileURLToPath(import.meta.url))
const PDS = process.env.PDS_URL ?? 'http://localhost:3000'
const handle = process.env.AUTHORITY_HANDLE, password = process.env.AUTHORITY_PASSWORD
if (!handle || !password) { console.error('set AUTHORITY_HANDLE and AUTHORITY_PASSWORD'); process.exit(1) }
const lexDir = join(here, '..', 'lexicons', 'freeschool', 'draft')
const docs = readdirSync(lexDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(lexDir, f), 'utf8')))
const lex = new Lexicons([{ lexicon: 1, id: 'com.atproto.repo.strongRef', defs: { main: { type: 'object', required: ['uri','cid'], properties: { uri: { type: 'string', format: 'at-uri' }, cid: { type: 'string', format: 'cid' } } } } }, ...docs])
const xrpc = async (nsid, body, token) => {
  const r = await fetch(`${PDS}/xrpc/${nsid}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${nsid}: ${r.status} ${JSON.stringify(j)}`)
  return j
}
const session = await xrpc('com.atproto.server.createSession', { identifier: handle, password })
const did = session.did
const rows = readFileSync(join(here, '..', '..', '..', 'infra', 'seed', 'skills', 'skills-seed.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
const uriOf = (slug) => `at://${did}/freeschool.draft.skill/${slug}`
let ok = 0, failed = 0
for (const row of rows) {
  const { _provenance, ...rec } = row
  rec.broader = (rec.broader ?? []).map(uriOf)
  if (rec.prerequisites) rec.prerequisites = rec.prerequisites.map(uriOf)
  if (rec.externalIds && Object.keys(rec.externalIds).length === 0) delete rec.externalIds
  try {
    lex.assertValidRecord('freeschool.draft.skill', rec)
    await xrpc('com.atproto.repo.putRecord', { repo: did, collection: 'freeschool.draft.skill', rkey: rec.id, record: rec, validate: false }, session.accessJwt)
    ok++
  } catch (e) { failed++; console.error('FAIL', rec.id, e.message.slice(0, 200)) }
}
console.log(JSON.stringify({ did, ok, failed, total: rows.length }))
