# Holistic polish and original-vision reconciliation

Original prompt supplied September 13 asks for portable skills and profiles, peer learning, classes, requests, a wiki of contributed resources connected to skills/events/practitioners, federation, and community stewardship.

The subsequent PRD deliberately deferred the wiki adapter (§4.2); the resource lexicon and index exist, but resource publishing and browsing screens were missing at the start of this pass. The current account page is private and cannot be used as a public practitioner directory without explicit opt-in.

Current pass:
- [x] Generated mixed-format artwork and six local demo classes; adaptive card layout and class hero/zoom.
- [x] Public class overview, audience, access notes and materials before RSVP; retain legacy attendee/location redaction.
- [x] Day/week/month calendar modes alongside the image-led list; verify date boundaries and mobile navigation.
- [x] Measured multipage Letter/A4 zine; verify every event occurs once, no overflow, and printed page counts.
- [x] Knowledge foundation using existing `freeschool.draft.resource` records: attributed notes/links, skill links, contributor profiles, publishing, author editing/removal, and audited school moderation/restoration.
- [x] Explicitly opt-in public profiles and discovery through public skill claims. Never enumerate private membership, attendance, or school-only claims.
- [x] Skill-page composition: taxonomy, classes, requests, knowledge, and willing practitioners.
- [x] End-to-end verification and a clear remaining-feature/deployment report.

Further work beyond this pass: external wiki synchronization adapter, binary resource attachments, course/curriculum sequences, steward elections, one-click hosted-school onboarding, mature cross-school public-profile portability. These require their own data/privacy/operations design; do not present a link collection as a completed wiki integration.


## Verified September 13, 2026

- 205 frontend tests pass; 384 backend tests pass, one existing test skipped. Backend suite used only `freeschool_polish_test`.
- All workspace typechecks pass. Production web build succeeds. Route splitting reduced initial JavaScript from about 596 kB to 389 kB (about 35%); gzip from 183 kB to 123 kB. The large-chunk advisory is resolved. Total offline precache remains about 842 KiB because secondary routes are still available offline.
- The live MVP browser story passes: signup, returning identity, request/class publishing, public overview, image upload, RSVP, attendance, anonymous feedback, recurring materialization, zine, policy, resource publishing/editing, public profile and revocation.
- Four design browser tests pass: 80-class Letter/A4 PDFs, no footer overlap or omitted events, exact PDF/UI page counts, all calendar modes, phone month width, and date/view persistence after reload.
- Manual desktop/390px review: adaptive event artwork, tiny-source framing, public class details, complete month grid, knowledge cards/reading, skill-to-class/resource/practitioner navigation, illustrated profile.
- Online/hybrid class selection and attendee-only meeting links are now exposed in the class editor/detail. Skill depth and prerequisite notes are visible before RSVP; unsafe link protocols are never rendered.

## Scope and launch status

The shared notebook is an initial author-owned knowledge base of short notes and links, with stable skill references and optional links to the author's listed classes. Public profile display fields remain app-side; public skill claims and resources live in author repositories. This is not an external wiki sync adapter or collaborative revision-history editor.

Deployment files are prepared, but no production deployment has happened. The production domain/hosting account, production PDS, email delivery and operator-owned secrets are still required. A deployment-destination question was sent during this pass. See `docs/deployment.md` for launch verification.


## Continuation: contribution ownership and production checks

- My contributions is available from Me and the knowledge library. Authors can read/edit/remove notes hidden by school moderation or linked to unlisted classes. Public library/profile queries keep those notes hidden. Editing never clears moderation; author deletion uses a separate tombstone so a moderation restore cannot resurrect deleted notes.
- The resource editor supports up to eight linked skills, editable license, and detaching a class. Existing unlisted class associations can be preserved by their owner; new private associations are refused.
- Record lookup follows index cursors instead of incorrectly treating records beyond an author's first 100 as absent. Two regression tests cover later pages and repeated cursors.
- All workspace typechecks and the production build pass. The complete backend suite passes 384 tests (one existing live-source test skipped); frontend suite passes 205 tests.
- Five browser checks pass against the actual production build at a temporary local preview: both PDF sizes, calendar modes, phone navigation, and hidden-note editing/deletion. The real MVP account/class/feedback/resource journey also passes with multiple linked skills and preserved license. The temporary preview was stopped after verification; the development app remains available.
- Production Compose validates using placeholder host/password and no service env resolution. Docker image build could not reach the Node/Caddy base-image metadata on Docker Hub and failed with a registry deadline timeout. No deployment or production services were created. This is an external connectivity limitation, not a completed image verification.
