# Free School — lexicon review packet for Lucian

*Benjamin Life (@omniharmonic) · 2026-09-12 · status: draft for Benjamin's approval before sending · all types under `freeschool.draft.*` (rename to your canonical namespace is a find-and-replace; nothing inside the documents encodes the namespace)*

## What this is

Seventeen draft record types plus three space-type declarations for the Free School app, composed on top of `community.lexicon.calendar.event` / `.rsvp`, `community.lexicon.location.*`, and your `coop.lexicon.*` sidecars. Every one follows the rule we settled on 2026-09-12: **never extend a borrowed record; attach a strongRef sidecar; placement follows audience.** Every JSON below validates against `@atproto/lexicon@0.7.14` with positive and negative record cases (`pnpm lexicons:validate` in the repo). The shapes of `coop.lexicon.event.config/detail/listing`, `membership`, `evaluation`, `invite/share` were read from `technefoundation/regenOS@c3e34d4`, not from the handoff note (one correction: the config field is `attendance`, not `attendanceMode`).

## Reuse before extend — what we did NOT draft

| Need | Reused type | Note |
|---|---|---|
| A class | `community.lexicon.calendar.event` | unchanged; `startsAt`/`endsAt` are optional in the base schema, so our write path requires them |
| RSVP (to an event **or a needs-board request**) | `community.lexicon.calendar.rsvp` | `subject` is a strongRef, so it can point at a `freeschool.draft.request`; note the base rsvp has **no `createdAt`** — waitlist ordering must come from the TID rkey |
| Capacity / approval / timezone | `coop.lexicon.event.config` | as-is |
| Exact address, door code | `coop.lexicon.event.detail` | as-is, placed in the event's detail space |
| "This school lists this class" (tag routing with COhere) | `coop.lexicon.event.listing` | as-is; the school DID is the author |
| Roles 10/20/30/40 | `coop.lexicon.membership` | as-is; our role ladder is a pure function over records that writes these claims |
| Vouches | `coop.lexicon.evaluation` (direction: positive) | we drafted `skillAttestation` only to ask whether evaluation should grow a `skill` field instead (Q2) |
| Invite link / vouch | `coop.lexicon.invite` / `.share` | as-is in shape; **v1 keeps them app-side** (R9: the invite graph is the organizing graph) |

## Extend-vs-sidecar reasoning, per type

| Type | Why a separate record (not a field) | Placement |
|---|---|---|
| `skill` | Taxonomy nodes must be forkable, mergeable, and referenceable from four other types; a string tag cannot be deduplicated across schools. rkey = slug (`key: any`). | Public, in the taxonomy authority's repo |
| `skillClaim` | Self-report lives in the **person's** repo so it travels between schools; a field on `coop.lexicon.profile` would couple it to one profile schema and lose per-claim placement. | Public by default for Tier A skills; member's own space for Tier B / private claims (R9) |
| `skillAttestation` | Third-party statement about a subject; cardinality N per subject. Candidate to fold into `coop.lexicon.evaluation` (Q2). | Public **only with double opt-in** (attester + subject); otherwise app-side/space |
| `skillLevel` | Event sidecar: a class can teach two skills; the borrowed event cannot carry our field. | Public with the event |
| `series` / `occurrence` | Calendar lexicon has no recurrence and will not gain one; occurrences are ordinary events so every consumer stays correct; the back-pointer is its own record to avoid rewriting the series on each materialization and to carry `originalStartsAt` (RFC 5545 RECURRENCE-ID). | Follows the event |
| `attendance` | Host-attested evidence that badges derive from. **R9 asks us to keep this app-side and never publish a record naming a DID the holder did not write**; the lexicon is kept for the school's space and for an attendee-written variant. | School's members space (Phase 2) / app-side (v1); never public |
| `hostFeedback` | Evaluation with 3 structured aspects and free text; negative must never route public. | Feedback space only; v1 app-side behind the Spaces-shaped interface, k-anonymous aggregates |
| `request` / `claim` | The needs board is the #1 entry point; a request is not an event (no time/place yet), so it cannot be a `calendar.event` with status planned without lying to every calendar consumer. `claim` is the host's sidecar that converts it. | Public |
| `resource` | Wiki input; skill pages are derived views over these. | Public |
| `course` | Grouping of sessions; distinct from `series` (no rule). | Public |
| `policy` | The school's rules and role thresholds are data, rendered on join, versioned. | Public, school repo |
| `moderationAction` / `approval` / `appeal` | Audit log written **as the school** through one chokepoint; approvals are records from each steward so a policy engine can verify the two-steward threshold (Arbiter review); appeals are the affected person's. **Written reasons are mandatory but, per R9, never public** — the public projection is a state + enum only. | Moderation space (Phase 2) / app-side (v1) |
| `school` | The scene's self-declaration: name, region, current policy, handle domain, **peer schools** (the peer-PDS registry as a record), routing tags. rkey `self`. | Public, school repo |

## Space-type declarations (your model; alpha mapping noted)

The Spaces alpha lab (R1) found that **per-collection read policy is inexpressible**: one space credential reads every collection of every member repo in the space, and the scope grammar forbids pairing `collection` with `read`. So roster and feedback must be **two spaces**, not two collections. Space-type NSIDs also need three or more segments in the alpha (`org.freeschool.members`, not `freeschool.members`).

```
freeschool.draft.space.members            (skey = "v1"; authority = the school DID)
  collections: coop.lexicon.membership, freeschool.draft.attendance, freeschool.draft.skillClaim (private claims)
  read:   memberRole(authority, atLeast: 10)
  write:  authorityOnly                       # the app writes role claims as the school
  manage: memberRole(authority, atLeast: 40)

freeschool.draft.space.feedback           (skey = "v1")
  collections: freeschool.draft.hostFeedback
  read:   any[ authorityOnly, memberRole(authority, atLeast: 40) ]   # the aggregator + stewards; hosts (20/30) never read raw rows
  write:  memberRole(authority, atLeast: 10)   # eligibility (attended the referenced event) is an app-side check; the lexicon cannot express it
  manage: memberRole(authority, atLeast: 40)

freeschool.draft.space.moderation         (skey = "v1")
  collections: freeschool.draft.moderationAction, freeschool.draft.approval, freeschool.draft.appeal
  read:   any[ memberRole(authority, atLeast: 40), confirmedFor(this) ]   # stewards + the affected person for their own case
  write:  any[ authorityOnly, memberRole(authority, atLeast: 40), confirmedFor(this) ]
  manage: memberRole(authority, atLeast: 40)

per-event detail: reuse coop.lexicon.space.event.detail unchanged.
```

Alpha caveats we designed around: the authority can always read everything in its own space (so "the school can see who said what" is the protocol default — anonymity is our app's construction); `writePolicy` only gates whether a write is *tracked*, not whether it succeeds, so the writer set, never row existence, is the source of truth; issued credentials live 7200 s after `removeMember`.

## The five §14 questions, plus what the research added

1. **Extend-vs-sidecar rule, in writing.** We proceeded on sidecar everywhere (table above). Does the rule as we applied it match yours? Specific edge: should `exdates` live on `series` (atomic with the rule, our draft) or in a separate exception record (lets a co-organizer cancel an occurrence without write access to the series)? This interacts with app custody.
2. **`skillAttestation` vs `coop.lexicon.evaluation`.** Would you accept an optional `skill` (at-uri) on `evaluation`, or prefer our sidecar? Related: we reference skills by **at-uri, not strongRef** everywhere (taxonomy nodes are edited in place; a version-pinned ref would go stale on relabel) — sidecars to *events* keep strongRefs. OK?
3. **Sandbox PDS.** Is yours the `pds-spaces-alpha` image? We ran it locally (amd64-only, needs `PDS_DEV_MODE=1` and `PDS_DISABLE_SSRF_PROTECTION=1`, and a `pnpm.overrides` block for the `@atproto/lex-data@0.0.0` packaging bug). If yours is the reference PDS without spaces, v1 is unaffected: feedback/roster/moderation are app-side behind the Spaces-shaped interface either way.
4. **School DID custody long-term.** The Arbiter repo was totally rewritten in September: no membership API, no role model, no license, single instance, plaintext steward credentials. Recommendation: we custody in v1 behind a `SchoolActorPort` (one write primitive mirroring the arbiter proxy body, scope required, arbiter-shaped result envelope, approvals as records) so the Arbiter or your Syntropic harness can be swapped in without call-site changes. Would the harness expose a write-as-scene primitive with that shape?
5. **Series/recurrence sidecar.** Drafted as `series` + `occurrence` (below), RRULE string normative with denormalized `freq/interval/byDay/until/count`. Nobody upstream has solved this (atmo writes a `recurringEventOf` that is never read; OpenMeet materializes lazily and loses cancellations). Should we propose it to lexicon.community together?

Added by the research: (6) **Smoke Signal is sunset** — its published lexicons are now historical; (7) `community.lexicon.calendar.rsvp` has no `createdAt`; (8) the privacy review (R9) recommends that **no public record name a DID its holder did not write** — this is consistent with your spaces placement but means `coop.lexicon.membership` claims should never be public-placed for this community.

## Lexicon JSON (17 records; all validate)

### `freeschool.draft.appeal`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.appeal",
  "defs": {
    "main": {
      "type": "record",
      "description": "An appeal of a moderation action by the affected person. SPACE-ONLY (freeschool.moderation).",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "action",
          "text",
          "createdAt"
        ],
        "properties": {
          "action": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef"
          },
          "text": {
            "type": "string",
            "maxLength": 40000,
            "maxGraphemes": 4000
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.approval`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.approval",
  "defs": {
    "main": {
      "type": "record",
      "description": "A steward's signed approval of a proposed destructive moderation action. Written by the steward in their OWN repo (or the school's moderation space), so the two-steward threshold is verifiable from records rather than from app process state (R3 invariant 10: a policy engine can read a record; it cannot read our memory). The school's freeschool.draft.moderationAction then lists the approving stewards and points at the proposal.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "proposal",
          "action",
          "createdAt"
        ],
        "properties": {
          "proposal": {
            "type": "string",
            "format": "at-uri",
            "description": "AT-URI of the proposed action (a freeschool.draft.moderationAction with status proposed, or an app-side proposal id expressed as an at-uri under the school DID)."
          },
          "action": {
            "type": "string",
            "knownValues": [
              "remove-listing",
              "restore-listing",
              "suspend-role",
              "restore-role",
              "require-approval",
              "close-request",
              "void-attendance",
              "write-policy",
              "other"
            ]
          },
          "subjectRecord": {
            "type": "string",
            "format": "at-uri"
          },
          "subjectDid": {
            "type": "string",
            "format": "did"
          },
          "reason": {
            "type": "string",
            "maxLength": 20000,
            "maxGraphemes": 2000
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.attendance`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.attendance",
  "defs": {
    "main": {
      "type": "record",
      "description": "Host-attested attendance at a class. Written by the host (or by the school via the app-held credential). Sidecar to community.lexicon.calendar.event. The evidence that badges and roles are derived from.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "event",
          "attendee",
          "participated",
          "createdAt"
        ],
        "properties": {
          "event": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef"
          },
          "attendee": {
            "type": "string",
            "format": "did"
          },
          "participated": {
            "type": "boolean"
          },
          "role": {
            "type": "string",
            "knownValues": [
              "attendee",
              "assistant",
              "co-host"
            ]
          },
          "level": {
            "type": "integer",
            "minimum": 1,
            "maximum": 3,
            "description": "Level of the session attended, copied from the event's skillLevel sidecar at attestation time."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.claim`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.claim",
  "defs": {
    "main": {
      "type": "record",
      "description": "A host's claim on a request, converting it toward an event. Sidecar to freeschool.draft.request.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "request",
          "createdAt"
        ],
        "properties": {
          "request": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef"
          },
          "event": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "Set once the class is scheduled."
          },
          "note": {
            "type": "string",
            "maxLength": 6000,
            "maxGraphemes": 600
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.course`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.course",
  "defs": {
    "main": {
      "type": "record",
      "description": "A multi-session grouping of events.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "title",
          "sessions",
          "createdAt"
        ],
        "properties": {
          "title": {
            "type": "string",
            "maxLength": 1600,
            "maxGraphemes": 160
          },
          "description": {
            "type": "string",
            "maxLength": 20000,
            "maxGraphemes": 2000
          },
          "sessions": {
            "type": "array",
            "items": {
              "type": "ref",
              "ref": "com.atproto.repo.strongRef"
            },
            "minLength": 1,
            "maxLength": 64
          },
          "skills": {
            "type": "array",
            "items": {
              "type": "string",
              "format": "at-uri"
            },
            "maxLength": 8
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.hostFeedback`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.hostFeedback",
  "defs": {
    "main": {
      "type": "record",
      "description": "Anonymous structured feedback about a host for one event. SPACE-ONLY (freeschool.feedback). Never public; the AppView releases only k-anonymous aggregates (k>=3). In v1 this shape is stored app-side behind a Spaces-shaped interface.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "event",
          "host",
          "direction",
          "createdAt"
        ],
        "properties": {
          "event": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef"
          },
          "host": {
            "type": "string",
            "format": "did"
          },
          "direction": {
            "type": "string",
            "knownValues": [
              "positive",
              "negative"
            ]
          },
          "aspects": {
            "type": "ref",
            "ref": "#aspects"
          },
          "text": {
            "type": "string",
            "maxLength": 10000,
            "maxGraphemes": 1000
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    },
    "aspects": {
      "type": "object",
      "description": "Optional 3-point ratings, aggregated only.",
      "properties": {
        "knowledge": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "teaching": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "experience": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        }
      }
    }
  }
}
```

### `freeschool.draft.moderationAction`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.moderationAction",
  "defs": {
    "main": {
      "type": "record",
      "description": "An audit-logged moderation action written as the school by the app. A written reason is mandatory. Never edits another repo; it controls the school's own listing/roles.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "action",
          "reason",
          "actors",
          "createdAt"
        ],
        "properties": {
          "subjectRecord": {
            "type": "string",
            "format": "at-uri",
            "description": "The record acted on (e.g. an event listing), if any."
          },
          "subjectDid": {
            "type": "string",
            "format": "did",
            "description": "The account acted on, if any."
          },
          "action": {
            "type": "string",
            "knownValues": [
              "remove-listing",
              "restore-listing",
              "suspend-role",
              "restore-role",
              "require-approval",
              "close-request",
              "void-attendance",
              "other"
            ]
          },
          "reason": {
            "type": "string",
            "maxLength": 20000,
            "maxGraphemes": 2000,
            "minLength": 1
          },
          "policyRef": {
            "type": "string",
            "format": "at-uri"
          },
          "actors": {
            "type": "array",
            "description": "Stewards who approved. Destructive actions require the policy threshold.",
            "items": {
              "type": "string",
              "format": "did"
            },
            "minLength": 1,
            "maxLength": 5
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.occurrence`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.occurrence",
  "description": "Back-pointer sidecar binding one materialized community.lexicon.calendar.event to the freeschool.draft.series that generated it. Chosen over an occurrences[] array on the series record because (a) appending to an array rewrites the series record on every materialization, turning the series into a write-conflict hotspot that grows without bound, (b) an array forces the series author to also be the author of every occurrence, where a separate record lets a scene's materializer write occurrences the series author did not, and (c) RFC 5545 RECURRENCE-ID semantics need per-occurrence state (originalStartsAt) that has nowhere to live on the series. Placement: follows its event.",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "event",
          "series",
          "originalStartsAt",
          "createdAt"
        ],
        "properties": {
          "event": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "Strong reference to the materialized occurrence event."
          },
          "series": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "Strong reference to the freeschool.draft.series that generated it."
          },
          "originalStartsAt": {
            "type": "string",
            "format": "datetime",
            "description": "The start instant the recurrence rule PRODUCED for this occurrence \u2014 the RFC 5545 RECURRENCE-ID. Stays fixed when the event's own startsAt is edited, which is what lets a materializer recognise an already-materialized slot instead of creating a duplicate, and lets a reader say 'moved from Tuesday to Wednesday this week'."
          },
          "sequence": {
            "type": "integer",
            "minimum": 1,
            "description": "Optional 1-based index of this occurrence within the series ('week 3 of 8'), for display only; never used to locate an occurrence."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.policy`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.policy",
  "defs": {
    "main": {
      "type": "record",
      "description": "A school's public rules and role-ladder thresholds. Written by the school DID. Versioned; the app renders the current one on join.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "title",
          "text",
          "version",
          "effectiveAt",
          "createdAt"
        ],
        "properties": {
          "title": {
            "type": "string",
            "maxLength": 1200,
            "maxGraphemes": 120
          },
          "text": {
            "type": "string",
            "maxLength": 200000,
            "maxGraphemes": 20000
          },
          "version": {
            "type": "string",
            "maxLength": 20
          },
          "effectiveAt": {
            "type": "string",
            "format": "datetime"
          },
          "thresholds": {
            "type": "ref",
            "ref": "#thresholds"
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    },
    "thresholds": {
      "type": "object",
      "description": "Role-ladder parameters. Defaults follow Lex: hosting open on day one.",
      "properties": {
        "memberRequires": {
          "type": "string",
          "knownValues": [
            "none",
            "invite-or-vouch",
            "attended-one"
          ]
        },
        "hostMinAttended": {
          "type": "integer",
          "minimum": 0,
          "maximum": 20
        },
        "facilitatorMinHosted": {
          "type": "integer",
          "minimum": 0,
          "maximum": 50
        },
        "firstEventApproval": {
          "type": "boolean"
        },
        "feedbackK": {
          "type": "integer",
          "minimum": 2,
          "maximum": 10
        },
        "destructiveActionStewards": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5
        }
      }
    }
  }
}
```

### `freeschool.draft.request`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.request",
  "defs": {
    "main": {
      "type": "record",
      "description": "A needs-board post: \"I want to learn X\". community.lexicon.calendar.rsvp records may point at it (status going = \"I want this too\"). When RSVPs reach the threshold, a host may claim it.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "title",
          "status",
          "createdAt"
        ],
        "properties": {
          "skill": {
            "type": "string",
            "format": "at-uri"
          },
          "title": {
            "type": "string",
            "maxLength": 1200,
            "maxGraphemes": 120
          },
          "description": {
            "type": "string",
            "maxLength": 20000,
            "maxGraphemes": 2000
          },
          "threshold": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500,
            "description": "RSVP count that unlocks \"claim to host\"."
          },
          "status": {
            "type": "string",
            "knownValues": [
              "open",
              "claimed",
              "scheduled",
              "closed"
            ]
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.resource`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.resource",
  "defs": {
    "main": {
      "type": "record",
      "description": "A learning resource (link or file) attached to a skill and optionally an event. Input to derived skill pages.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "title",
          "skills",
          "createdAt"
        ],
        "properties": {
          "title": {
            "type": "string",
            "maxLength": 1600,
            "maxGraphemes": 160
          },
          "description": {
            "type": "string",
            "maxLength": 10000,
            "maxGraphemes": 1000
          },
          "skills": {
            "type": "array",
            "items": {
              "type": "string",
              "format": "at-uri"
            },
            "minLength": 1,
            "maxLength": 8
          },
          "uri": {
            "type": "string",
            "format": "uri"
          },
          "file": {
            "type": "blob",
            "maxSize": 20000000
          },
          "license": {
            "type": "string",
            "description": "SPDX identifier; default CC-BY-SA-4.0",
            "maxLength": 40
          },
          "event": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef"
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.school`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.school",
  "defs": {
    "main": {
      "type": "record",
      "description": "The school's public declaration (one per school DID, rkey \"self\"): name, region, current policy, handle domain, and the peer schools whose PDS hosts this school's AppView follows. The peer registry as a record.",
      "key": "literal:self",
      "record": {
        "type": "object",
        "required": [
          "name",
          "createdAt"
        ],
        "properties": {
          "name": {
            "type": "string",
            "maxLength": 1200,
            "maxGraphemes": 120
          },
          "description": {
            "type": "string",
            "maxLength": 20000,
            "maxGraphemes": 2000
          },
          "region": {
            "type": "string",
            "maxLength": 1200,
            "maxGraphemes": 120
          },
          "policy": {
            "type": "string",
            "format": "at-uri",
            "description": "Current freeschool.draft.policy record."
          },
          "handleDomain": {
            "type": "string",
            "format": "handle"
          },
          "website": {
            "type": "string",
            "format": "uri"
          },
          "peers": {
            "type": "array",
            "description": "DIDs of peer schools this school federates with (their PDS hosts are followed directly).",
            "items": {
              "type": "string",
              "format": "did"
            },
            "maxLength": 100
          },
          "tags": {
            "type": "array",
            "description": "Tags this school routes on for event.listing exchange (e.g. skillshare, free-school).",
            "items": {
              "type": "string",
              "maxLength": 400,
              "maxGraphemes": 40
            },
            "maxLength": 20
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.series`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.series",
  "description": "Recurrence sidecar to a community.lexicon.calendar.event. The community calendar lexicon has NO recurrence field and will not gain one; a series is therefore a separate record that points at its first occurrence and states the rule by which further occurrences are generated. Occurrences are materialized as ORDINARY community.lexicon.calendar.event records, each carrying a freeschool.draft.occurrence sidecar pointing back here \u2014 so every occurrence is independently viewable, RSVP-able, cancellable and borrowable by any consumer that has never heard of this lexicon. Placement: PUBLIC alongside the first event when the series is public; in the event's invite space when the series is permissioned (a recurrence rule otherwise discloses the cadence of a private gathering).",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "firstEvent",
          "rrule",
          "freq",
          "timezone",
          "createdAt"
        ],
        "properties": {
          "firstEvent": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "Strong reference to the first occurrence, which doubles as the series template: its name, description, locations, mode and duration are copied to each materialized occurrence. Anchoring on a real first event rather than on a dedicated template record means no phantom, dateless pseudo-event reaches the firehose, and a consumer that ignores this lexicon still sees a correct single event."
          },
          "rrule": {
            "type": "string",
            "maxLength": 1024,
            "description": "The NORMATIVE recurrence rule as an RFC 5545 RRULE value, without the 'RRULE:' prefix \u2014 e.g. 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;COUNT=8'. This is the field of record: where the structured fields below disagree with it, rrule wins. Kept as a string so the series round-trips through iCalendar and through every existing RRULE library unchanged."
          },
          "freq": {
            "type": "string",
            "knownValues": [
              "daily",
              "weekly",
              "monthly",
              "yearly"
            ],
            "description": "Denormalized FREQ, required so that any calendar UI can render 'weekly' without shipping an RRULE parser. Must agree with rrule."
          },
          "interval": {
            "type": "integer",
            "minimum": 1,
            "default": 1,
            "description": "Denormalized INTERVAL: every Nth freq period. Must agree with rrule."
          },
          "byDay": {
            "type": "array",
            "maxLength": 7,
            "description": "Denormalized BYDAY, as RFC 5545 two-letter weekday codes. Must agree with rrule.",
            "items": {
              "type": "string",
              "knownValues": [
                "MO",
                "TU",
                "WE",
                "TH",
                "FR",
                "SA",
                "SU"
              ]
            }
          },
          "until": {
            "type": "string",
            "format": "datetime",
            "description": "Denormalized UNTIL: the series generates no occurrence starting after this instant. Mutually exclusive with `count` \u2014 RFC 5545 forbids both in one rule, an invariant the lexicon cannot express and the write path must enforce."
          },
          "count": {
            "type": "integer",
            "minimum": 1,
            "description": "Denormalized COUNT: total number of occurrences the series ever generates. Mutually exclusive with `until`."
          },
          "exdates": {
            "type": "array",
            "maxLength": 200,
            "description": "EXDATE list: start instants the rule would produce but which must NEVER be materialized (holiday skips). Distinct from cancelling an occurrence \u2014 a cancelled occurrence already exists as an event and uses the base lexicon's own community.lexicon.calendar.event#cancelled status, which is why this sidecar needs no cancellation field.",
            "items": {
              "type": "string",
              "format": "datetime"
            }
          },
          "timezone": {
            "type": "string",
            "maxLength": 128,
            "description": "IANA timezone name, e.g. America/Denver. Required, and load-bearing rather than cosmetic: 'every Tuesday at 6pm' must survive a DST transition, which is only expressible by expanding the rule in a named zone. Matches the timezone field on coop.lexicon.event.config."
          },
          "materializeAhead": {
            "type": "integer",
            "minimum": 1,
            "maximum": 730,
            "default": 90,
            "description": "How many days ahead of now the materializer should keep occurrence events created. Bounded rather than infinite so an open-ended weekly series does not write unbounded records; the materializer re-runs and extends the window."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.skill`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.skill",
  "defs": {
    "main": {
      "type": "record",
      "description": "A node in the shared skill taxonomy. Authored by a taxonomy authority (a school or the co-op). rkey is the stable slug. Forkable: any school may publish proposed nodes in its own repo.",
      "key": "any",
      "record": {
        "type": "object",
        "required": [
          "id",
          "label",
          "status",
          "createdAt"
        ],
        "properties": {
          "id": {
            "type": "string",
            "description": "Stable kebab-case slug; equals the rkey.",
            "maxLength": 64
          },
          "label": {
            "type": "string",
            "maxLength": 800,
            "maxGraphemes": 80
          },
          "description": {
            "type": "string",
            "maxLength": 6000,
            "maxGraphemes": 600
          },
          "broader": {
            "type": "array",
            "description": "AT-URIs of parent skill records (is-a / part-of). Multi-parent allowed. Weak refs by identity, not version, because taxonomy nodes are edited in place.",
            "items": {
              "type": "string",
              "format": "at-uri"
            },
            "maxLength": 8
          },
          "prerequisites": {
            "type": "array",
            "items": {
              "type": "string",
              "format": "at-uri"
            },
            "maxLength": 16
          },
          "externalIds": {
            "type": "ref",
            "ref": "#externalIds"
          },
          "status": {
            "type": "string",
            "knownValues": [
              "canonical",
              "proposed",
              "deprecated"
            ]
          },
          "replacedBy": {
            "type": "string",
            "format": "at-uri",
            "description": "When deprecated, the node that supersedes this one."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    },
    "externalIds": {
      "type": "object",
      "properties": {
        "esco": {
          "type": "string",
          "format": "uri"
        },
        "wikidata": {
          "type": "string",
          "description": "Wikidata QID, e.g. Q123",
          "maxLength": 32
        },
        "onet": {
          "type": "string",
          "maxLength": 32
        }
      }
    }
  }
}
```

### `freeschool.draft.skillAttestation`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.skillAttestation",
  "defs": {
    "main": {
      "type": "record",
      "description": "A positive-only peer attestation that a subject has a skill. Candidate for replacement by coop.lexicon.evaluation (subject strongRef + direction) \u2014 see review packet.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "subject",
          "skill",
          "direction",
          "createdAt"
        ],
        "properties": {
          "subject": {
            "type": "string",
            "format": "did",
            "description": "DID of the person being attested."
          },
          "skill": {
            "type": "string",
            "format": "at-uri"
          },
          "direction": {
            "type": "string",
            "knownValues": [
              "positive"
            ],
            "description": "Only positive attestations are public records."
          },
          "context": {
            "type": "string",
            "format": "at-uri",
            "description": "Optional AT-URI of the event where this was observed."
          },
          "note": {
            "type": "string",
            "maxLength": 3000,
            "maxGraphemes": 300
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.skillClaim`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.skillClaim",
  "defs": {
    "main": {
      "type": "record",
      "description": "A self-reported skill. Lives in the person's own repo so it travels with them between schools.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "skill",
          "level",
          "createdAt"
        ],
        "properties": {
          "skill": {
            "type": "string",
            "format": "at-uri",
            "description": "AT-URI of a freeschool.draft.skill record."
          },
          "level": {
            "type": "string",
            "knownValues": [
              "learning",
              "practicing",
              "proficient",
              "teaching"
            ]
          },
          "note": {
            "type": "string",
            "maxLength": 3000,
            "maxGraphemes": 300
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `freeschool.draft.skillLevel`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.skillLevel",
  "description": "Sidecar to a community.lexicon.calendar.event: declares WHICH skill a class teaches and at WHAT depth. Composition over extension \u2014 the borrowed community.lexicon.calendar.event is never modified and never gains a field. One class may carry several skillLevel sidecars (a class that teaches two skills, or one skill at a spanning level). Placement: PUBLIC alongside the event by default (a class's subject and depth are the discovery surface \u2014 this is what a learner browses and searches); it rides into a scene's space only when the event itself is permissioned, in which case it is placed in the event's invite space so that the class's existence is not leaked by its subject tag.",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": [
          "event",
          "skill",
          "level",
          "createdAt"
        ],
        "properties": {
          "event": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "Strong reference to the community.lexicon.calendar.event this describes."
          },
          "skill": {
            "type": "string",
            "format": "at-uri",
            "description": "AT-URI of the freeschool.draft.skill record naming the subject taught. A URI (identity) rather than a strongRef (version) because taxonomy nodes are edited in place \u2014 a relabelled skill must not orphan every class that referenced it. Consistent with skillClaim, skillAttestation, request and resource. Two scenes teaching the same skill resolve to the SAME record, which is what makes cross-scene skill discovery possible."
          },
          "level": {
            "type": "integer",
            "minimum": 1,
            "maximum": 3,
            "description": "Depth index, ORDERED so that policies and queries can ask `atLeast`/`atMost`: 1=introductory (no prior exposure assumed), 2=intermediate (assumes working familiarity), 3=advanced (assumes practice). An integer rather than an enum because the only question anyone asks of it is a comparison ('classes at or below my depth'), and because widening the maximum is a backward-compatible lexicon change whereas re-ordering an enum's knownValues is not. Mirrors the open-registry integer used by coop.lexicon.membership#role."
          },
          "prerequisites": {
            "type": "string",
            "maxLength": 2560,
            "maxGraphemes": 256,
            "description": "Optional free-form note on what a learner should already have (tools, prior classes, physical requirements). Deliberately prose, not a ref list: most real prerequisites ('bring closed-toe shoes', 'can you already cast on?') are not other classes."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

## Sources

- Repo: `freeskool` (Benjamin Life), `packages/lexicons/` — validation via `@atproto/lexicon@0.7.14`.
- R1 Spaces alpha lab, R2 lexicon inventory, R3 Arbiter review, R6 prior-art review, R9 privacy threat model (Parachute, `vault/projects/local-alternatives/free-school/research/`).
- `technefoundation/regenOS@c3e34d4f` (coop.lexicon.*), `tangled.org/lexicon.community/lexicons@c8552ebb` (community.lexicon.*).
