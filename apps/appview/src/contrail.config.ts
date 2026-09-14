/**
 * The projection config. Sidecar composition, expressed in contrail's vocabulary:
 *
 *  - every sidecar declares a `references.event` pointing at the `event` collection
 *    through the field that holds the borrowed event's URI, so contrail hydrates the
 *    event for us and we never have to denormalize;
 *  - `event` declares `relations` back, so counts (rsvps, skill levels, listings) are
 *    materialized columns instead of N+1 queries;
 *  - `relays` is our PEER REGISTRY: a list of PDS hosts, not a list of relays. See
 *    `src/index/peers.ts` and the README caveat about
 *    `com.atproto.sync.listReposByCollection`.
 *
 * Short names become both table suffixes (`records_<short>`) and XRPC path segments
 * (`<namespace>.<short>.listRecords`), so they are deliberately stable.
 */
import type { ContrailConfig } from '@atmo-dev/contrail'
import { NSID } from './lexicons/nsids.js'
import type { Config } from './config.js'

/** `event.uri` — sidecars point at the borrowed event via a com.atproto.repo.strongRef. */
const EVENT_REF = 'event.uri'

export interface BuildConfigInput {
  namespace: string
  /** PDS hosts to discover from (peer registry). */
  peers: string[]
  liveIngest: boolean
  orderedSourceEpoch: string
  allowedPrivateHosts: string[]
  logger?: ContrailConfig['logger']
}

export function buildContrailConfig(input: BuildConfigInput): ContrailConfig {
  return {
    namespace: input.namespace,

    // Peer registry. contrail calls `com.atproto.sync.listReposByCollection` on each.
    // The set is the UNION across every school this process hosts — one definition, in
    // `index/peers.ts#indexerPeerHosts`, so a steward's peer edit and the rebuild check
    // in `lib/peers.ts#reloadIndexerForPeers` can never disagree about what it is.
    relays: input.peers,

    // Bluesky's public Jetstream is useless for a private/peered deployment; live
    // ingest is opt-in and, where it is off, `PdsChangeSource` is the missing piece
    // (src/sync/README.md).
    jetstreams: ['wss://jetstream1.us-east.bsky.network'],
    orderedSource: { source: 'jetstream', epoch: input.orderedSourceEpoch },

    // Nothing in the Free School graph is a Bluesky social graph; no profiles, no feeds.
    profiles: [],
    constellation: false,

    networkOverrides: {
      additionalAllowedHosts: input.allowedPrivateHosts,
    },

    // Transactional outbox. `initial: 'future'` per the brief: we only care about
    // changes from the moment the consumer is registered, never a historical replay.
    changes: {
      consumers: {
        notify: {
          collections: [
            NSID.event,
            NSID.eventConfig,
            NSID.eventListing,
            NSID.series,
            NSID.occurrence,
            NSID.request,
            NSID.claim,
            NSID.school,
            NSID.policy,
            NSID.membership,
          ],
          phases: ['historical', 'live'],
          initial: 'future',
          requiredForActivation: false,
        },
      },
    },

    logger: input.logger,

    collections: {
      /* ── the borrowed records ─────────────────────────────────────────────── */
      event: {
        collection: NSID.event,
        queryable: { mode: {}, status: {}, startsAt: { type: 'range' }, endsAt: { type: 'range' } },
        searchable: ['name', 'description'],
        timeField: 'startsAt',
        relations: {
          rsvps: {
            collection: 'rsvp',
            field: 'subject.uri',
            groupBy: 'status',
            groups: {
              going: `${NSID.rsvp}#going`,
              interested: `${NSID.rsvp}#interested`,
              notgoing: `${NSID.rsvp}#notgoing`,
            },
          },
          skillLevels: { collection: 'skillLevel', field: EVENT_REF },
          listings: { collection: 'eventListing', field: EVENT_REF },
          configs: { collection: 'eventConfig', field: EVENT_REF },
          occurrences: { collection: 'occurrence', field: EVENT_REF },
        },
      },
      rsvp: {
        collection: NSID.rsvp,
        // RSVPs are app-side by default (R9); this collection only ever holds the
        // per-event opt-in public ones.
        queryable: { status: {} },
        references: { event: { collection: 'event', field: 'subject.uri' } },
      },

      /* ── our sidecars ─────────────────────────────────────────────────────── */
      skillLevel: {
        collection: NSID.skillLevel,
        queryable: { level: { type: 'range' }, skill: {} },
        references: {
          event: { collection: 'event', field: EVENT_REF },
          skill: { collection: 'skill', field: 'skill' },
        },
      },
      series: {
        collection: NSID.series,
        queryable: { freq: {} },
        references: { event: { collection: 'event', field: 'firstEvent.uri' } },
      },
      occurrence: {
        collection: NSID.occurrence,
        queryable: { originalStartsAt: { type: 'range' } },
        references: {
          event: { collection: 'event', field: EVENT_REF },
          series: { collection: 'series', field: 'series.uri' },
        },
      },
      request: {
        collection: NSID.request,
        queryable: { status: {}, skill: {}, threshold: { type: 'range' } },
        searchable: ['title', 'description'],
        relations: { claims: { collection: 'claim', field: 'request.uri' } },
        references: { skill: { collection: 'skill', field: 'skill' } },
      },
      claim: {
        collection: NSID.claim,
        references: {
          request: { collection: 'request', field: 'request.uri' },
          event: { collection: 'event', field: EVENT_REF },
        },
      },
      resource: {
        collection: NSID.resource,
        searchable: ['title', 'description'],
        references: { event: { collection: 'event', field: EVENT_REF } },
      },
      course: {
        collection: NSID.course,
        searchable: ['title', 'description'],
      },
      policy: {
        collection: NSID.policy,
        queryable: { version: {}, effectiveAt: { type: 'range' } },
      },
      /**
       * A PEER SCHOOL'S OWN DECLARATION. Indexing this from every peer host is what
       * `lib/peers.ts#peerSchools` (and `GET /api/schools/nearby`) reads: who else is out
       * there, their region, and the `tags` they route on — their record, never our row
       * about them, and never a count of anything they hold (ruling 7).
       */
      school: {
        collection: NSID.school,
        searchable: ['name', 'description'],
        queryable: { region: {} },
      },
      skill: {
        collection: NSID.skill,
        queryable: { status: {}, id: {} },
        searchable: ['label', 'description'],
        relations: { claims: { collection: 'skillClaim', field: 'skill' } },
      },
      skillClaim: {
        collection: NSID.skillClaim,
        queryable: { level: {}, skill: {} },
        references: { skill: { collection: 'skill', field: 'skill' } },
      },
      /** A positive-only peer attestation ("I vouch that they can do this"). See GET
       * /api/me/badges, which turns these into "Vouched for <skill> by N people". */
      skillAttestation: {
        collection: NSID.skillAttestation,
        queryable: { subject: {}, skill: {}, direction: {} },
        references: { skill: { collection: 'skill', field: 'skill' } },
      },

      /* ── cooperative events ───────────────────────────────────────────────── */
      eventConfig: {
        collection: NSID.eventConfig,
        queryable: { visibility: {}, school: {} },
        references: { event: { collection: 'event', field: EVENT_REF } },
      },
      eventListing: {
        collection: NSID.eventListing,
        queryable: { status: {}, school: {} },
        references: { event: { collection: 'event', field: EVENT_REF } },
      },
      membership: {
        collection: NSID.membership,
        queryable: { role: { type: 'range' }, school: {} },
        subjectField: 'subject',
      },
    },
  }
}
