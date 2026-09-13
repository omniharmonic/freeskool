# Whole-product frontend design pass

## Direction

A neighbourhood infoshop with a useful workshop attached. User content carries the colour and personality; the interface provides quiet, legible tools. The calendar is the noticeboard, the skill library is a field guide, class pages are invitations, the account is a personal notebook, and stewardship is the back room where the school is cared for.

Palette: paper #f7f8f5, graphite #26332d, fern #315d49, pale lichen #e8ed79, lavender #ebe3f0, blue paper #dce7ec. Bricolage Grotesque makes headings human and mechanical; system sans carries instructions and controls. No decorative labels, rankings, fabricated community content or repeated ornamental heroes.

Layout choices:

```
Discovery      [title / short invitation] [search]
               [file-card category] [file-card category]
Class detail   [large title and image]
               [description / supplies] [date / place / RSVP]
Forms          [purpose and local section links]
               [well-spaced labelled sections] [publish summary]
Account        [personal identity and activity]
               [skills notebook] [preferences / account controls]
Stewardship    [section navigation] [focused work area]
Sign-in        [return link / school mark]
               [short explanation / bounded form / recovery]
```

All layouts are left aligned. Forms remain readable rather than expanding across a desktop. Lists, panels, chips, buttons and callouts have different jobs and different treatments. Dialogs become centred work surfaces on desktop and bottom sheets on phones. Error/loading/empty/success/access states are designed as part of each flow.

## Review against the brief

Keep the geodesic mark in the identity and cover fallbacks, rather than repeating it in every section. The first pass's global styles made unrelated elements round and coloured, and reused one vertical stack for too many purposes. Replace these with explicit page-layout and component classes. Rich cards belong in discovery; compact rows belong in settings and attendance; plain prose belongs in policy explanations. Preserve the existing privacy and public-record consent copy.

## Coverage ledger

- Calendar: discovery, range/search, empty/loading/retry, event cards and image fallback.
- Skills: searchable full tree, categories and nested links; individual skill description, ancestry, subskills, related classes and requests.
- Requests: browsing, interest, teaching offer, composing sheet, posted state, scheduled class and recovery.
- Classes: public/private detail, venue call, cancelled/past state, host actions, RSVP/waitlist/withdrawal, reminders, sharing/invites and public-record confirmation.
- Class editor: creation, edit, skill/level, date/time, venue/privacy, materials, tags, recurrence, validation and publishing feedback.
- Attendance: roster, walk-ins, saved state and failed-save recovery.
- Feedback: eligibility, anonymous ballot, duplicate/success state, sealed/released summary.
- Account: profile/avatar editing, skill claims, visibility confirmation, badges, appearance, reminders, ownership and sign-out.
- Notifications: category routing, device setup, newsletter and mutation feedback.
- Identity: sign-in, email confirmation, verification failure, OAuth consent/unavailable, invite redemption and ownership reveal.
- Stewardship: overview, policy, moderation queue/actions, peers, newsletter draft/confirmation, handoff and acceptance/access states.
- Print: zine month/size controls, loading/error, paper preview, printed output; how-it-works prose and printing.
- Shared: navigation, keyboard focus, dialog dismissal, responsive overflow, dark/reduced-motion, missing routes and recoverable errors.

Verification results and any limits will be appended after implementation and browser inspection.

## Implemented and checked — 13 September 2026

Reviewed all 27 registered routes, including the legacy event redirect, with explicit layouts for discovery, detail, publishing, account, reading, stewardship and identity. The shared components are in `apps/web/src/components`; the second-pass layout rules are in `apps/web/src/interface.css`.

| Area | What changed | Browser inspection |
| --- | --- | --- |
| Calendar | Preserved the image/poster-led cards and quiet drafting-table frame; shared keyboard navigation and controls improved. | Desktop and phone calendar, scrolling, content cards. |
| Skill library | Search covers nested skills, descriptions and ancestry; category folders have line drawings, clear expand/collapse and real links. | Desktop/phone, search for bicycle, nested results, skill detail and subskills. |
| Requests | Notes have expressive titles, restrained colour edges and readable status/action hierarchy. Status labels move above titles on narrow phones. | Desktop/phone board; desktop modal and phone sheet; Escape restores opener focus. |
| Class detail | Invitation/story column beside date, location and RSVP; separate host tools; phone shortcut to practical details. | Real uploaded cover, venue-needed state, host controls, desktop and mobile layouts. |
| Class publishing | Sectioned editorial form, local section navigation, grouped dates and location, image picker, readable levels, materials/tags and publish panel. | New and existing class forms, full-page scroll, mobile section jumps, 360px checkbox and overflow checks. |
| Attendance | Compact private checklist, walk-in form, visible saving/failure states that keep selections. | Populated host checklist on phone; full journey saves attendance. |
| Feedback | Large labelled ballot choices; distinct confirmation and sealed/released summary states. | Phone ballot and released summary; complete journey submits three ballots and verifies the anonymous aggregate. |
| Account | Profile/avatar card, skills notebook, badges, separate settings rail and steward entry point; loading errors prevent editing an incomplete notebook. | Desktop/phone, profile editor, light/dark appearance, narrow-phone overflow. |
| Notifications | Clear category rows and route choices, human label for waitlist promotion, query and mutation recovery. | Desktop/phone preferences and device setup affordance. |
| Stewardship | Dedicated workbench with stable navigation, accurate current-section indication, readable forms and overview cards. | Overview, policy including lower sections, empty moderation queue and proposal form, peers, newsletter draft/confirmation, handoff form and acceptance page. |
| Identity | Bounded sign-in/OAuth/invite/verification frames, clear return links and invalid-link recovery. | Email sign-in and returning sign-in, OAuth consent, missing verification token, invalid invite and ownership links. |
| Print and reading | Quiet print-studio controls, single-column phone preview and two-column printed zine; readable shared agreements. | Loaded zine on phone, month/size controls, how-it-works on phone; zine content also verified in the full journey. |

Additional functional corrections found during inspection:

- A returning email member previously hit PDS account creation again and failed. The email door now sends a fresh one-time link for the existing custodial identity. Reclaimed accounts continue through the AT Protocol door. Two backend regression tests cover both cases; the full browser journey signs out and returns to the same DID.
- Same-device email verification now remembers an invitation for 30 minutes. Only validated invite paths can be returned to; external URLs, unrelated routes and stale values are rejected. The ordinary onboarding destination remains Requests.
- RSVP, invite sharing, attendance and notification actions surface failures. Summary errors no longer masquerade as an empty or sealed result. Public class pages explain that full details require an RSVP, instead of falsely claiming the host omitted a description.
- Newsletter preview is read-only and matches the stored draft that will be sent. Edits can no longer appear to be accepted and then silently disappear.
- Peer reachability can be checked repeatedly; previously the second click did nothing.
- Form controls have accessible labels, shared touch targets, visible focus, corrected narrow-screen sizing, and section links that clear the fixed header. Pages have meaningful browser titles and a skip-to-content link.

### Validation

- Web: **193 tests passing**, 29 test files.
- API: **372 tests passing**, 34 test files, using the isolated `freeschool_polish_test` database.
- Workspace typecheck and production build: passed.
- Real local PDS/browser MVP journey: passed in **2.3 minutes**, including returning sign-in, request → class, image upload, RSVP, attendance, feedback, recurring instances, zine, policy and profile image editing.
- `git diff --check`: passed.
- Visual inspection at 1280×900, 390×844 and 360×800. The publishing form and account layout have no horizontal overflow at 360px. Native-dialog Escape dismissal restored focus to the request opener.

### Limits and deployment

The browser review used the existing local school and its real test records. Those records include many E2E titles and test images; they are not invented community activity or launch content. Live OAuth, SMTP delivery and installed iPhone push still need the production integrations. No newsletter was sent and no stewardship or ownership transfer was performed during visual inspection. Physical printer output and every browser/device combination were not tested; the print layout and zine contract remain covered by code review and existing tests.

The production build still reports the existing large-JavaScript-chunk advisory (approximately 782 KiB total precache, before transfer compression); it does not prevent building. Route splitting is a future performance improvement.

This pass is ready for review locally. Production hosting, domains, PDS credentials and SMTP remain the deployment dependencies described in `docs/deployment.md`; this pass did not publish a production instance.

## Class artwork follow-up — September 13, 2026

- Added shared `ClassArtwork` and a full-width `ClassHero`: preserve whole posters and photos, keep status labels outside the artwork, prioritize hero loading, and recover gracefully from failed/replaced images.
- Added image-derived mat colors and restrained framed presentation for images below 720px wide. A 240px input is displayed at 360px on desktop instead of being stretched to the 1104px hero width. Small sources remain small on the server; larger cover uploads retain up to 2400px.
- Added an accessible full-image dialog with fit/zoom controls, Escape dismissal and existing modal focus/scroll handling. Zoomed poster scrolling stays inside the image container.
- Added adaptive calendar grid sizing that responds to image loads, font/viewport changes and filtering, while retaining the original DOM/keyboard order. Browsers without ResizeObserver retain the regular grid.
- Created four original AI test artworks plus a 240px compressed derivative; populated six local `design-demo` events including the no-cover fallback. Assets, exact prompts, local links and repeatable seed instructions live in `fixtures/artwork/`.
- Verification: 196 frontend tests and 4 image-processing tests passed; web/API type checks and the production web build passed. Browser review covered the populated desktop calendar, portrait hero, low-resolution hero, mobile framing, and natural-resolution flyer zoom.
