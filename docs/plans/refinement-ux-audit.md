# Refinement UX audit — 13 September 2026

Source: the screenshot audit (`apps/web/e2e/audit.spec.ts`, 128 captures at 430×932 and 1280×800 for a fresh member and for the steward persona) and the persona journeys (`apps/web/e2e/personas.spec.ts`) driven against the seeded dev stack. Severity: **P1** blocks or misleads a real member on a core path and is fixed in this pass; **P2** is a real friction fixed here if cheap, otherwise listed; **P3** is polish.

## Findings from the screenshot review (controller)

| # | Route · persona | What a real member hits | Sev | Fix |
|---|---|---|---|---|
| 1 | `/events/:id` · every seeded class | "The host hasn't added a public overview yet." on every demo class, because the seed wrote the old `description` (now attendee notes) and no `publicOverview`. A newcomer evaluating the school sees empty classes. | P1 (demo) | Seed gives every class a public overview and repairs existing ones (`seed-demo.ts`). |
| 2 | `/people` · member | Every member is labelled **Host**, including learners who never hosted, because the policy's `hostMinAttended` is 0 so the derived role ladder admits everyone. The label reads as an achievement and is meaningless here. | P2 | Show the role label only for Facilitator and Steward; for everyone else show what they did ("Hosted 2 classes") or only the skill count. Same on the member profile header. |
| 3 | `/me` · fresh member with no display name | The handle is printed twice (title and subtitle). | P2 | When there is no display name, show "Add a name" as the title's affordance and the handle once. |
| 4 | `/events/:id` · member | Raw routing tags (`skillshare`, `demo`) render as chips at the top of a class. They are machine tags for calendar exchange, not member-facing. | P3 | Hide tags that come from the school's routing set; keep any host-written tags. |
| 5 | `/requests` · member | Dev data carries duplicate e2e requests ("Fermenting without fear (ngs5m)", "(natql)", "Probe request…"). Not a product bug, but the board looks broken to anyone evaluating the demo. Product angle: two identical requests should collapse into one with a higher count. | P3 | e2e specs clean up or namespace their fixtures; consider "N people already asked for this" dedupe by skill. |
| 6 | `/admin/skills` · steward | Proposals created by e2e runs land in the real dev taxonomy ("Scythe sharpening ngs5m") and stay as deprecated rows forever. | P3 (dev) | e2e uses a recognisable prefix and the seed/e2e teardown deprecates them; nothing for members. |
| 7 | `/welcome` · newcomer | Reads well. "← Browse classes" at the top is the only escape and skips onboarding silently; acceptable, but the three cards are long on a phone. | P3 | Consider collapsing cards 2 and 3 behind "Next". |
| 8 | `/skills/:id` · member | Clear taxonomy navigation; the people section sits below classes, so on a phone a member has to scroll past every class to find who knows this. | P3 | Move "People with this skill" above the class list, or add a count chip near the title that jumps to it. |

## Status after the fix rounds (13 September 2026, late)

Fixed on the branch: controller findings 1 (seed public overviews, `aff9b4d`), 2–4 (`88cead5`); journey findings 1–2 (`56a083b`, `f8b5900`), 3 (multi-skill class editor, `be944e2`), 4 (`aff9b4d`), 5 (cancel a class, `e48d644`), 6, 8, 9, 11, 16 (`7d5ee49`), 10 (`88cead5`), 18 (ruling: a brand-new member lands on `/welcome`, then the needs board; `mvp.spec.ts` updated). Still open, listed for the next pass: controller 5–8; journey 7 (welcome cards could collapse), 12 (explain what a vouch is inline), 13 (a way to reach a person from their profile), 14–15 (admin vocabulary and newsletter preview), 17 (persona runs leave a class behind — by design of the journey; the seed's demo tags make them easy to spot).

## Findings from the persona journeys (e2e agent)

Numbered for the audit document. Only 1 and 2 are fixed; the rest are recorded, not touched.

1. **`/events/$id` — the class did not say who was teaching it.** *(fixed, `56a083b`)* A learner
   could read a whole class page and never learn the host's name, let alone reach their profile.
2. **`/people/$did` — a console error on every view.** *(fixed, `f8b5900`)*
3. **`/events/new`, `/events/$id/edit` — the class form takes exactly one skill.** Spec §4.4
   called for `SkillMultiPicker` here; the record and `POST /api/events` carry many, and the form
   even preserves `existing.skills.slice(1)` untouched while refusing to show or edit them. A
   host teaching sourdough *and* fermentation can file the class under only one, and skill pages
   lose the other. This is the one thing in §4.6 that cannot be driven as written.
4. **`/events/$id` — "The host hasn't added a public overview yet."** shows on every seeded
   class, while the calendar card and the school's listing show that same class's description.
   The page reads only `publicOverview.description`; the legacy `description` input (which the
   seed and any pre-19c class use) lands in attendee notes. A real member sees an apparently
   empty class page for a class that has a description.
5. **No way to cancel a class.** `EventEditScreen` tells a host "to reshape a series, cancel it
   and post a new one", `EventScreen` renders a "This class has been cancelled" banner — and
   there is no cancel or delete control anywhere in the UI, nor a client method for one. A host
   who posts the wrong thing can only edit it forever.
6. **`/event/$eventId` (the old short-id link) dead-ends.** `EventRedirect` forwards the raw
   last path segment to `/events/$id`, which needs the full AT-URI, so an old link lands on
   "Class not found" rather than the class. (The audit passes the full URI to get a picture.)
7. **`/welcome` — "Step 1 of 3" over three cards that are all visible and editable at once.**
   The counter reads like a wizard, gates nothing, and only moves when you act; on a phone it is
   unclear whether the lower cards are "later" or already available.
8. **`/welcome` — revisiting it after onboarding offers the whole flow again, with empty
   fields.** "Save and continue" then writes an empty display name and bio over the real ones.
   There is no "you have already done this" state; the only ways out are Finish and the tab bar.
9. **`/welcome` — a failed handle save shows the raw server sentence.** During the stack trouble
   below, the card read "Unsupported state or unable to authenticate data" under the member's
   typed handle. Internal messages reach the member unmapped; `HandleChooser.saveErrorMessage`
   only translates the codes it knows.
10. **`/me` — a member who skipped the profile card sees their generated handle printed twice**
    (once as their name, once as their handle), with no nudge to add a name and no visible route
    to the handle chooser from the card itself.
11. **`/events/$id/attendance` — "Add someone who came without RSVPing" wants a raw DID**, typed
    by hand, and answers "That doesn't look like a DID — it starts with 'did:'". No member can
    do this. A handle field with resolution is the obvious want; the screen's own doc comment
    already records the deviation.
12. **`/people/$did` — the Vouch button is unexplained.** Nothing says what a vouch is, that the
    count is visible to the whole school, or that it can be withdrawn. The one explanatory line
    ("Counts, never scores") is about the numbers, not the act.
13. **`/people/$did` is the end of the road.** No way to contact the person, ask them to teach
    something, or see what they have asked for — the profile links out only to their classes and
    notes.
14. **`/admin/newsletter` — "Preview" only exists after "Compose draft"**, and nothing on the
    screen says a draft will be generated from the month rather than written by hand.
15. **`/admin/moderation` and `/admin/policy` assume the vocabulary.** "Open an item", "Queue",
    "Role ladder", "Thresholds" — no line saying what an item is, or what moving a threshold
    does to a member who is already on the ladder.
16. **A member opening `/admin` logs a 403 as a console error** ("Failed to load resource…"),
    as does a non-host opening an attendance page. Harmless, but it is what any error-reporting
    tool will collect first. (`audit.spec.ts` filters 4xx explicitly and judges 5xx absolutely.)
17. **Every persona run leaves a class behind.** The host journey posts "Bike clinic (stamp)"
    into the demo school and, with no cancel control (5), the demo calendar and the bicycle
    skill page accumulate them. A cheap fix would be a `demo`/`e2e` tag the seed can sweep.
18. **A brand-new member no longer lands on the needs board.** Task 11 sends them to `/welcome`
    first, which contradicts PRD §13 constraint 2 as written *and* is what breaks `mvp.spec.ts`'s
    `signUp()` helper (it asserts the Requests heading immediately after the magic link). Somebody
    should decide which is right and update the other; the fix in the spec is one line.
