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

## Findings from the persona journeys (e2e agent)

_Appended from the Task 15 report once it lands._
