/**
 * An authenticated agent for the VIEWER's own repo.
 *
 * Two doors, one shape:
 *   - `oauth`     -> restore the stored OAuth session and wrap it in an `Agent`
 *   - `custodial` -> log in with the app-password we hold wrapped for them
 *
 * This is how a host's class ends up in the HOST's repo rather than the school's. It is
 * never used for the school DID — that is `src/lib/school-actor.ts` and only that.
 */
import { Agent, AtpAgent } from '@atproto/api'
import type { Viewer } from '../http/session.js'
import { oauthClient } from '../http/oauth.js'
import { custodialPassword } from './custody.js'
import { config } from '../config.js'

export class NoActorCredentialError extends Error {
  constructor(readonly did: string) {
    super('no usable credential for this actor')
    this.name = 'NoActorCredentialError'
  }
}

export async function actorAgent(viewer: Viewer): Promise<Agent> {
  if (viewer.kind === 'oauth') {
    const client = await oauthClient()
    const session = await client.restore(viewer.did)
    return new Agent(session)
  }
  const password = await custodialPassword(viewer.did)
  if (!password) throw new NoActorCredentialError(viewer.did)
  const agent = new AtpAgent({ service: config().PDS_URL })
  await agent.login({ identifier: viewer.did, password })
  return agent
}
