// R1 Spaces-alpha lab — end-to-end exercise of com.atproto.simplespace.* and
// com.atproto.space.* against the local `pds-spaces-alpha` PDS.
//
//   node plc-server.mjs &            # in-memory did:plc directory on :2582
//   docker compose up -d             # spaces-alpha PDS on :2583
//   node spaces-lab.mjs
//
// Author of record: Benjamin Life (@omniharmonic)

import { JoseKey } from '@atproto/jwk-jose'
import { createDpopProof, dpopJktForKey } from '@atproto/space'

const PDS = process.env.PDS_URL ?? 'http://localhost:2583'

// ---------------------------------------------------------------- log helpers

let step = 0
const h1 = (s) => console.log(`\n${'='.repeat(78)}\n${++step}. ${s}\n${'='.repeat(78)}`)
const h2 = (s) => console.log(`\n--- ${s}`)
const show = (label, v) =>
  console.log(`${label}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)

// ------------------------------------------------------------------ xrpc call

class XrpcError extends Error {
  constructor(status, body) {
    super(`${body?.error ?? 'HttpError'}: ${body?.message ?? status}`)
    this.status = status
    this.error = body?.error
    this.body = body
  }
}

async function xrpc(nsid, { method = 'GET', params, body, headers = {} } = {}) {
  const url = new URL(`/xrpc/${nsid}`, PDS)
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { error: 'NonJson', message: text.slice(0, 300) }
  }
  if (!res.ok) throw new XrpcError(res.status, parsed)
  return parsed
}

const bearer = (jwt) => ({ authorization: `Bearer ${jwt}` })

/**
 * Run a probe whose outcome is the finding. Prints ALLOWED or REFUSED (with the
 * real error name) and never aborts the lab, so one probe's result does not hide
 * the next one's.
 */
async function probe(label, fn) {
  try {
    const out = await fn()
    console.log(`[ALLOWED] ${label}`)
    show('  body', out)
    return { ok: true, out }
  } catch (err) {
    if (err instanceof XrpcError) {
      console.log(
        `[REFUSED] ${label}\n  HTTP ${err.status}  error="${err.error}"  message="${err.body?.message}"`,
      )
      return { ok: false, err }
    }
    throw err
  }
}

// -------------------------------------------------------------- jwt inspector

function decodeJwt(jwt) {
  const [h, p, s] = jwt.split('.')
  const dec = (b) => JSON.parse(Buffer.from(b, 'base64url').toString('utf8'))
  return { header: dec(h), payload: dec(p), sigBytes: Buffer.from(s, 'base64url').length }
}

function printJwt(label, jwt) {
  const { header, payload, sigBytes } = decodeJwt(jwt)
  console.log(`${label}`)
  console.log(`  raw (${jwt.length} chars): ${jwt.slice(0, 64)}...`)
  console.log(`  header:  ${JSON.stringify(header)}`)
  console.log(`  payload: ${JSON.stringify(payload, null, 2).replace(/\n/g, '\n  ')}`)
  if (typeof payload.exp === 'number') {
    console.log(`  lifetime: ${payload.exp - payload.iat}s   signature: ${sigBytes} bytes`)
  } else {
    console.log(`  no \`exp\` (DPoP proofs are bounded by \`iat\` + MAX_PROOF_AGE_SEC=60)   signature: ${sigBytes} bytes`)
  }
}

// ------------------------------------------------------------------- accounts

async function ensureAccount(handle, password) {
  try {
    const res = await xrpc('com.atproto.server.createAccount', {
      method: 'POST',
      body: { handle, email: `${handle.split('.')[0]}@test.invalid`, password },
    })
    console.log(`  created ${handle} -> ${res.did}`)
    return { did: res.did, handle, accessJwt: res.accessJwt }
  } catch (err) {
    if (err.error !== 'HandleNotAvailable' && err.error !== 'InvalidRequest') throw err
    const res = await xrpc('com.atproto.server.createSession', {
      method: 'POST',
      body: { identifier: handle, password },
    })
    console.log(`  reused  ${handle} -> ${res.did}`)
    return { did: res.did, handle, accessJwt: res.accessJwt }
  }
}

// ----------------------------------------------------- space credential flow

/**
 * The two-legged exchange from proposal 0016:
 *   1. the member's own PDS mints a short-lived delegation token (aud = the
 *      authority's `#atproto_space_host`), and
 *   2. the authority swaps it for a space credential bound to a DPoP key.
 */
async function getSpaceCredential({ space, actor, key }) {
  const { token } = await xrpc('com.atproto.space.getDelegationToken', {
    params: { space },
    headers: bearer(actor.accessJwt),
  })
  printJwt(`  delegation token (minted by ${actor.handle}'s PDS)`, token)

  const htu = new URL('/xrpc/com.atproto.space.getSpaceCredential', PDS).toString()
  const proof = await createDpopProof(key, { htm: 'POST', htu })
  printJwt('  DPoP proof (no `ath`: obtaining a credential)', proof)

  const { credential } = await xrpc('com.atproto.space.getSpaceCredential', {
    method: 'POST',
    body: { space },
    headers: { authorization: `Bearer ${token}`, dpop: proof },
  })
  return { credential, delegationToken: token }
}

/** A read performed with a space credential: `Authorization: DPoP` + bound proof. */
async function credentialedCall(nsid, { credential, key, params, method = 'GET', body }) {
  const url = new URL(`/xrpc/${nsid}`, PDS)
  const proof = await createDpopProof(key, { htm: method, htu: url.toString(), credential })
  return xrpc(nsid, {
    method,
    params,
    body,
    headers: { authorization: `DPoP ${credential}`, dpop: proof },
  })
}

// ------------------------------------------------------------------ constants

// NOTE: a space `type` must be a full NSID (>= 3 dot-separated segments), so the
// conceptual `freeschool.members` / `freeschool.feedback` become org.freeschool.*
const SPACE_TYPE = 'org.freeschool.members'
const SPACE_TYPE_FEEDBACK = 'org.freeschool.feedback'
const SKEY = 'v1'
const COLL_SKILL = 'freeschool.draft.skill'
const COLL_FEEDBACK = 'freeschool.draft.feedback'

const run = async () => {
  h1('Accounts (school authority, member, non-member)')
  const school = await ensureAccount('freeskool.test', 'freeskool-pass')
  const alice = await ensureAccount('alice.test', 'alice-pass')
  const carol = await ensureAccount('carol.test', 'carol-pass')

  h1('com.atproto.simplespace.createSpace — the school DID owns the space')
  const createSpace = async (type) => {
    const createBody = {
      type,
      skey: SKEY,
      readPolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
      writePolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' },
      appAccess: { $type: 'com.atproto.simplespace.defs#open' },
    }
    show('input.body', createBody)
    try {
      const res = await xrpc('com.atproto.simplespace.createSpace', {
        method: 'POST',
        body: createBody,
        headers: bearer(school.accessJwt),
      })
      show('output.uri', res.uri)
      return res.uri
    } catch (err) {
      if (err.error !== 'SpaceAlreadyExists') throw err
      const uri = `at://${school.did}/space/${type}/${SKEY}`
      console.log(`  SpaceAlreadyExists — reusing ${uri}`)
      return uri
    }
  }
  const space = await createSpace(SPACE_TYPE)
  h2('a SECOND, separate space for feedback (the isolation boundary is the space)')
  const feedbackSpace = await createSpace(SPACE_TYPE_FEEDBACK)

  h2('com.atproto.simplespace.getSpace (as the owner)')
  show(
    'space config',
    await xrpc('com.atproto.simplespace.getSpace', {
      params: { space },
      headers: bearer(school.accessJwt),
    }),
  )

  h1('com.atproto.simplespace.putMember — add alice, leave carol out')
  const putBody = { space, did: alice.did, read: true, write: true }
  show('input.body', putBody)
  await xrpc('com.atproto.simplespace.putMember', {
    method: 'POST',
    body: putBody,
    headers: bearer(school.accessJwt),
  })
  console.log('  putMember returned 200 with an empty body')

  h2('com.atproto.simplespace.listMembers (owner-only; a space credential is NOT enough)')
  show(
    'members',
    await xrpc('com.atproto.simplespace.listMembers', {
      params: { space },
      headers: bearer(school.accessJwt),
    }),
  )

  h1('com.atproto.space.createRecord — alice writes into HER OWN repo in the space')
  for (const [coll, record] of [
    [COLL_SKILL, { $type: COLL_SKILL, title: 'Sourdough starter basics', createdAt: new Date().toISOString() }],
    [COLL_FEEDBACK, { $type: COLL_FEEDBACK, text: 'loved the bread class', createdAt: new Date().toISOString() }],
  ]) {
    const body = { space, repo: alice.did, collection: coll, rkey: 'r1lab', record }
    show(`input.body (${coll})`, body)
    const res = await xrpc('com.atproto.space.putRecord', {
      method: 'POST',
      body,
      headers: bearer(alice.accessJwt),
    })
    show('  output', res)
  }

  h1('Read as the author with an ordinary account token (action: read_self)')
  show(
    'alice listRecords on her own repo',
    await xrpc('com.atproto.space.listRecords', {
      params: { space, repo: alice.did, limit: 50 },
      headers: bearer(alice.accessJwt),
    }),
  )

  h1('Read as a MEMBER via the delegation-token -> space-credential exchange')
  const aliceKey = await JoseKey.generate(['ES256'])
  console.log(`  DPoP key thumbprint (jkt): ${await dpopJktForKey(aliceKey)}`)
  const { credential } = await getSpaceCredential({ space, actor: alice, key: aliceKey })
  printJwt('  SPACE CREDENTIAL (issued by the school authority)', credential)

  h2('com.atproto.space.listRepos — the writer set (authority-maintained)')
  show('repos', await credentialedCall('com.atproto.space.listRepos', {
    credential, key: aliceKey, params: { space, limit: 50 },
  }))

  h2('com.atproto.space.listRecords with the credential — ALL collections, no filter')
  show('records', await credentialedCall('com.atproto.space.listRecords', {
    credential, key: aliceKey, params: { space, repo: alice.did, limit: 50 },
  }))

  h2('Same credential, narrowed to one collection (client-side choice, not a policy)')
  show('records', await credentialedCall('com.atproto.space.listRecords', {
    credential, key: aliceKey, params: { space, repo: alice.did, collection: COLL_FEEDBACK, limit: 50 },
  }))

  h1('Read as a NON-MEMBER (carol)')
  h2('carol CAN mint a delegation token from her own PDS (her PDS is not the gate)')
  const carolKey = await JoseKey.generate(['ES256'])
  await probe('carol exchanges her delegation token for a credential', () =>
    getSpaceCredential({ space, actor: carol, key: carolKey }),
  )

  h2("carol tries to read alice's repo with her own account token")
  await probe('carol listRecords on alice\'s repo (account token)', () =>
    xrpc('com.atproto.space.listRecords', {
      params: { space, repo: alice.did, limit: 50 },
      headers: bearer(carol.accessJwt),
    }),
  )

  h2('carol writes into her OWN repo in a space she is not a member of')
  await probe('carol putRecord into the space', () =>
    xrpc('com.atproto.space.putRecord', {
      method: 'POST',
      body: {
        space, repo: carol.did, collection: COLL_FEEDBACK, rkey: 'r1lab-carol',
        record: { $type: COLL_FEEDBACK, text: 'i am not a member', createdAt: new Date().toISOString() },
      },
      headers: bearer(carol.accessJwt),
    }),
  )

  h2('Did carol end up in the authority-maintained writer set?')
  show('repos after carol attempt', await credentialedCall('com.atproto.space.listRepos', {
    credential, key: aliceKey, params: { space, limit: 50 },
  }))

  h1('Can the AUTHORITY (the school) read a member\'s rows?')
  const schoolKey = await JoseKey.generate(['ES256'])
  const schoolCred = await probe('school mints itself a space credential', () =>
    getSpaceCredential({ space, actor: school, key: schoolKey }),
  )
  if (schoolCred.ok) {
    printJwt('  school\'s own space credential', schoolCred.out.credential)
    show("school reads alice's rows", await credentialedCall('com.atproto.space.listRecords', {
      credential: schoolCred.out.credential, key: schoolKey,
      params: { space, repo: alice.did, limit: 50 },
    }))
  }

  h1('The syncer / AppView read path (all with the same space credential)')
  h2('com.atproto.space.listRepoOps — per-author oplog + signed commit at head')
  show('ops', await credentialedCall('com.atproto.space.listRepoOps', {
    credential, key: aliceKey, params: { space, repo: alice.did, limit: 100 },
  }))

  h2('com.atproto.space.getRepo — whole-repo snapshot')
  await probe('getRepo for alice', () =>
    credentialedCall('com.atproto.space.getRepo', {
      credential, key: aliceKey, params: { space, repo: alice.did },
    }),
  )

  h2('com.atproto.space.registerNotify — subscribe a service to write notifications')
  await probe(`registerNotify service=${alice.did} (a bare DID resolves to its #atproto_pds)`, () =>
    credentialedCall('com.atproto.space.registerNotify', {
      credential, key: aliceKey, method: 'POST', body: { space, service: alice.did },
    }),
  )
  await probe('registerNotify with an unresolvable service', () =>
    credentialedCall('com.atproto.space.registerNotify', {
      credential, key: aliceKey, method: 'POST',
      body: { space, service: 'did:web:syncer.invalid#atproto_space_syncer' },
    }),
  )

  h1('Is a credential usable against a DIFFERENT space of the same owner?')
  await probe(
    `alice's ${SPACE_TYPE} credential used against ${SPACE_TYPE_FEEDBACK}`,
    () =>
      credentialedCall('com.atproto.space.listRecords', {
        credential, key: aliceKey, params: { space: feedbackSpace, repo: alice.did, limit: 50 },
      }),
  )

  h1('com.atproto.simplespace.removeMember — revoke alice')
  await xrpc('com.atproto.simplespace.removeMember', {
    method: 'POST',
    body: { space, did: alice.did },
    headers: bearer(school.accessJwt),
  })
  console.log('  removeMember returned 200')
  show('members now', await xrpc('com.atproto.simplespace.listMembers', {
    params: { space }, headers: bearer(school.accessJwt),
  }))

  h2('alice can no longer obtain a NEW credential')
  const aliceKey2 = await JoseKey.generate(['ES256'])
  await probe('alice re-exchanges after removal', () =>
    getSpaceCredential({ space, actor: alice, key: aliceKey2 }),
  )

  h2('but her ALREADY-ISSUED credential is still accepted until it expires')
  const stillWorks = await probe('alice reuses the old credential', () =>
    credentialedCall('com.atproto.space.listRecords', {
      credential, key: aliceKey, params: { space, repo: alice.did, limit: 50 },
    }),
  )
  if (stillWorks.ok) {
    const { payload } = decodeJwt(credential)
    console.log(
      `  >>> revocation lag: the credential stays valid for ${payload.exp - payload.iat}s from issuance ` +
      `(until ${new Date(payload.exp * 1000).toISOString()})`,
    )
  }

  h1('DPoP replay protection (same proof twice)')
  const replayUrl = new URL('/xrpc/com.atproto.space.listRepos', PDS).toString()
  const onceProof = await createDpopProof(aliceKey, { htm: 'GET', htu: replayUrl, credential })
  const hdrs = { authorization: `DPoP ${credential}`, dpop: onceProof }
  console.log('  first use:')
  await probe('listRepos with a fresh proof', () =>
    xrpc('com.atproto.space.listRepos', { params: { space, limit: 5 }, headers: hdrs }),
  )
  console.log('  second use of the SAME proof:')
  await probe('listRepos replaying that proof', () =>
    xrpc('com.atproto.space.listRepos', { params: { space, limit: 5 }, headers: hdrs }),
  )

  console.log('\n' + '='.repeat(78) + '\nLAB COMPLETE\n' + '='.repeat(78))
}

run().catch((err) => {
  console.error('\nLAB FAILED:', err)
  if (err instanceof XrpcError) console.error('body:', JSON.stringify(err.body, null, 2))
  process.exit(1)
})
