# Final product and design pass

The member story is discover a class → read its details → join privately → attend → leave anonymous feedback. Hosts post classes and respond to learning requests. Stewards maintain the school without code. Verification covers the browser, API, identity server, database, reminders, print and deployment boundaries.

## Design direction

A community noticeboard on a drafting table. The photographs, handmade posters, class titles and personal descriptions are the expressive layer. Keep the surrounding interface calm, useful and readable.

- Paper #f7f8f5, sheet #ffffff, graphite #26332d, secondary #59665e, fern #315d49, annotation #e8ed79. Content fallbacks may use lavender, apricot and blue paper.
- Bricolage Grotesque for friendly, slightly mechanical headlines; system sans for reading and controls. Self-host the display font to avoid third-party requests.
- Left-aligned content; a modest geodesic mark; generous cards; a useful month navigator and search. Desktop has a narrow local-school rail and a three-column calendar. Mobile has a two-column hero and single-column content with familiar bottom navigation.

```
[school mark / identity]                         [print] [post a class]
[learn together introduction]                     [geodesic diagram]
[month < >]                             [search classes]
[local school / day index]  [image card] [poster card] [image card]
```

Reviewed against the brief: remove the original repeated halftone bars, hard colored shadows and oversized phone cards. Keep the drafting geometry only in the school mark and quiet empty-image posters. Images must be actual member uploads; do not disguise stock content as local activity. No public member directory, ratings, popularity rankings or invented activity.

## Required changes and evidence

- Calendar month navigation, search, retry/loading states, visible class creation, real school identity.
- Image upload for class covers and personal avatars; server-side image decoding/re-encoding and metadata stripping. App-side storage, with the same access rules as the associated object, without changing borrowed AT Protocol records.
- Venue-needed state must survive a supplied neighborhood; invalid event dates must be rejected.
- Public offline calendar must not retain private addresses across sign-out.
- Responsive layout, readable contrast, keyboard focus, reduced motion and print.
- Full test/type/build/lexicon checks; live browser member journey and targeted upload checks.
- Container deployment and documented launch configuration. Production requires a server, HTTPS hostnames, SMTP, custody keys and an operational backup plan; a frontend-only deployment is not the product.


## Review outcome — 13 September 2026

The core learning loop works against the real local PDS and Postgres: email identity → request → offer to teach → illustrated class → private RSVP → attendance → anonymous feedback → threshold-released summary. Recurrence, printable calendars and steward policy changes also pass the browser acceptance story. The implementation supports the MVP vision of a local learning commons; deployment and external interoperability still need live acceptance.

### Changes made

- Rebuilt the calendar as a responsive noticeboard with a real month range, title/tag/neighbourhood search, loading/retry/empty states, a local-school identity from its records, and direct posting/request actions. Card imagery is actual uploaded content; classes without images get typographic posters.
- Added cover images and private personal avatars. The browser downsizes originals before upload; the server decodes and re-encodes them, limits dimensions and strips metadata. Private class images follow the class's access rules. Calendar metadata queries exclude stored image bytes.
- Preserved venue calls even when the host supplies a suggested neighbourhood. Enforced end-after-start validation. Connected teaching offers to the published class, exposed the resulting link, and made retrying that connection avoid duplicate classes or duplicate teacher offers.
- Made the offline calendar always use its public projection. Other API responses explicitly prohibit browser caching. Sign-out cancels and clears private query data; failed sign-out reports the error.
- Copied presentation and materials into newly materialized recurring dates, corrected recurring-event inclusion in the zine, and replaced the silent calendar limit of 100 with a larger bounded limit and an explicit truncation message.
- Added self-hosted typography, geodesic geometry, quiet paper/graphite/fern framing, responsive forms and navigation, accessible status colors, focus states and reduced-motion handling. School bootstrap accepts the actual city/name through environment values.
- Added production Docker/Compose/Caddy configuration, secret/context exclusions, HTTPS routing, internal-only database/API networking, health checks, and a launch/backup/rollback runbook.

### Verification evidence

| Check | Result |
| --- | --- |
| AppView regression suite | 370 passed against a separate `freeschool_polish_test` database |
| Web regression suite | 181 passed |
| Shared / school actor / spaces packages | 25 passed |
| Workspace TypeScript checks and production application build | Passed |
| Lexicon validation | All 17 valid, including negative fixtures |
| Real Chromium acceptance | Passed: signup, request, teaching offer, image upload, venue call with neighbourhood, request linkage, three RSVPs, attendance, anonymous ballots, k=3 suppression/release, recurrence, zine, policy, avatar save/reload and sign-out |
| Responsive visual inspection | Calendar, signed-out posting entry and sign-in inspected at mobile and desktop sizes |
| Image-specific checks | Real decoder tests confirm dimension limits/metadata removal; HTTP checks confirm unlisted-image and avatar access restrictions |
| Production Compose configuration | Validated with non-secret placeholders |
| Production container build | Not verified: Docker registry metadata timed out; a subsequent base-image pull stalled and was stopped |
| Public-record privacy audit | Fails on the same three legacy moderation records documented in README; no additional violations after the new browser journeys |

### Remaining launch work and scope limits

No production deployment has been made. Supply the target server/access, web domain, neutral PDS hostname, SMTP transport, fresh production secrets and the school's second rotation-key holder. Provision and validate those, then execute `docs/deployment.md` using a fresh production school; never copy the old development identities or legacy moderation records.

Production OAuth, real email/push delivery, installed-device offline behavior, live COhere exchange and a backup restore drill are not established by the local browser suite. They remain explicit acceptance steps. Container execution also remains unverified until registry access works.

Images live app-side in this MVP: they are backed up with Postgres and are not portable AT Protocol blobs or federated image records. Profile images remain private, consistent with the no-public-directory constraint. Full internationalization, multiple schools in a single AppView, school-DID migration, double-consent skill vouches, and generalized user-defined card types remain outside v1. A busy calendar is bounded to 500 indexed candidates by default (maximum 1,000 through the API), with a truncation notice; search only covers the fetched month. The application build emits a non-blocking large-chunk warning (approximately 171 KB compressed for the main JavaScript bundle).
