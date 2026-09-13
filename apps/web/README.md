# @freeschool/web

The Free School PWA — the front-end shell for a community free school's calendar,
skill taxonomy, needs board, and printable monthly zine.

Mock data only. Every server call is a stub against `/api/*` on the same origin
(the BFF described in `docs/00-stack-proposal.md`); nothing talks to a PDS or an
AppView yet.

## Run it

```sh
pnpm install                              # from the repo root
pnpm --filter @freeschool/web dev         # vite dev server
pnpm --filter @freeschool/web build       # production build + service worker
pnpm --filter @freeschool/web preview     # serve the build (needed to test the SW)
pnpm --filter @freeschool/web test        # vitest
pnpm --filter @freeschool/web typecheck   # tsc --noEmit
```

Service workers only register over HTTPS or on `localhost`, so install and
offline behaviour must be checked against `preview`, not `dev`.

`vite.config.ts` and `vitest.config.ts` both pin `root` to this directory. A
stray `vite.config.ts` lives in the home directory, and config discovery would
otherwise walk up and find it.

## Routes

| Path | What it is |
| --- | --- |
| `/` | Calendar: month strip, classes grouped by day |
| `/event/$eventId` | Class detail: RSVP, invite, `.ics`, share, gated reminders |
| `/skills` | Taxonomy, domain to area to skill |
| `/skills/$skillId` | Skill page: practitioners, upcoming classes, open requests, resources |
| `/requests` | Needs board with thresholds and a composer sheet |
| `/me` | Profile, skill claims, counts, badges, settings |
| `/signin` | Two doors: a new Free School identity, or an existing ATProto account |
| `/zine` | The printable monthly zine |

## Design notes

**The look: risograph on photocopy stock.** The ground is `#E7E5DB`, a grey-beige
copier stock rather than a warm cream; the type colour is `#15182B`, a blue-black
mimeograph ink; the accents are real Riso spot-ink values — fluorescent pink
`#FF4D8D`, blue `#0070C0`, green `#00A95C`, amber `#F0B100`. Display type is
Bricolage Grotesque, narrowed on its width axis at title sizes; body and UI type
is the Apple system stack, because this is an iOS-idiom app and the system face
is the right voice for running text.

The signature device is **plate misregistration**. A riso press offsets its
plates by a hair, so every raised surface here carries a hard-offset second plate
in an ink colour (`.plate`, `box-shadow: 3px 3px 0`) and there are no soft grey
shadows anywhere. Solid ink blocks are **halftone** fields (`.halftone`), the way
a photocopier renders a solid. Radius is 4px — cut paper, not a SaaS card —
except on sheets, where the platform idiom wins at 18px.

**What is iOS idiom.** Large titles that collapse into a frosted nav bar on
scroll; a fixed bottom tab bar (Calendar, Skills, Requests, Me); bottom sheets on
`<dialog>`; a 100dvh app frame; `touch-action: manipulation` on every tappable;
`env(safe-area-inset-*)` everywhere, always inside `max()`.

**What is zine.** The counts and the vocabulary, not just the ink. Reputation is
attestation counts ("12 people have vouched for this skill"), never a score.
Levels are three stamped squares, not a difficulty word. A request's threshold is
a filled rule, not a rounded progress pill. Badges are sentences about things
someone did. And `/zine` is a real photocopiable artefact: a stencilled masthead
with a misregistered pink plate, two columns of day blocks, and the footer
everybody's a teacher, everybody's a student.

## The iOS constraints this shell is built around

All of these come from the R8 research; the reasoning is in the comments at each
site.

- **`navigator.standalone` is the install signal**, not `display-mode`. WebKit
  reports `display-mode: fullscreen` inside an installed `display: standalone`
  web app (webkit.org/b/264218), so the media query is only a fallback.
  `src/lib/ios-install.ts` is copied verbatim from R8.
- **Push cannot be requested from a Safari tab.** The "Remind me" button is
  therefore *visibly* gated — it reads "add to Home Screen first" and opens the
  install sheet rather than failing silently.
- **The install nudge fires after the first successful RSVP**, never on arrival,
  with a 14-day cooldown and a three-show lifetime cap in `localStorage` (every
  read and write wrapped in try/catch, because private mode throws).
- **Auth is a BFF.** ATProto OAuth runs server-side, the session is a cookie, and
  cookies are the one thing iOS copies at Add to Home Screen. A browser-side
  OAuth client would log the user out at install, because its DPoP key is
  non-extractable and lives in the wrong storage partition.
- **Glass sits on an absolutely-positioned child** of each fixed bar, never on
  the bar itself: Safari 26's chrome-tinting sampler reads `backdrop-filter` on
  fixed edges, and any `opacity`/`filter` ancestor silently kills the blur.
- **Safari has no `prefers-reduced-transparency`**, so "Reduce blur" is an in-app
  setting under Me. It sets `data-reduce-blur` on `<html>`.
- **Document scroll is locked** (`html, body { overflow: hidden }`) with all
  scrolling in an inner `.app-scroll` — `overscroll-behavior` is a no-op on an
  element that does not itself overflow. Sheets lock that scroller manually,
  because `<dialog>` does not.
- **`.ics` is a plain navigation** (`target="_self"`, no `download`), so iOS hands
  it to Calendar.
- **`navigator.share` payloads are built before the call**, never after an
  `await` — WebKit consumes the user activation.
- **Print**: explicit `@page` dimensions (`size: portrait` keywords are
  unsupported on iOS), paper colour on a wrapper div because Safari never prints
  the `<body>` background, `page-break-inside: avoid` on class blocks because
  `break-before/after: avoid` are no-ops, and no animation in the print sheet.

## Known issue in the R8 detector

`detectSurface()` classifies **iOS Chrome as `ios-inapp`**, so `ios-other-browser`
is unreachable: CriOS sends `Safari/` with no `Version/`, which trips the in-app
check before the CriOS check is reached. The consequence is only that iOS Chrome
users get "open in Safari" instead of install steps — R8 calls that the safe
direction to be wrong in — but it should be fixed upstream by testing for
`CriOS|EdgiOS|FxiOS` before the `Version/` heuristic. `src/lib/ios-install.test.ts`
pins the current behaviour so the fix is a deliberate change.

## Offline

The app shell is precached. `/api/calendar*` uses NetworkFirst with a six-second
network timeout and 30-day expiration, so a cold launch on a bad connection still
renders the month. An offline banner says which state the user is in. The service
worker is `registerType: 'autoUpdate'` — no "reload?" toast.
