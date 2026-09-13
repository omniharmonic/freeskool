---
author: "Benjamin Life (@omniharmonic)"
date: "2026-09-12"
status: "draft"
brief: "r8"
type: "research"
title: "R8 \u2014 PWA on iOS 2026 checklist"
projects: ["local-alternatives"]
visibility: "public"
parachute_path: "vault/projects/local-alternatives/free-school/research/r8_pwa-ios-checklist"
parachute_id: "2026-09-12-19-32-05-397242"
tags: ["free-school", "ios", "local-alternatives", "pwa", "research"]
---



*Benjamin Life (@omniharmonic) · 2026-09-12 · status: draft · brief R8*
# R8 — What our PWA can and cannot do on iPhone (Sep 2026)

## Version baseline (read this first)

**The shipping iOS browser today is Safari 26.6 / iOS 26.6 (released 2026‑07‑27).** Apple moved to year-based numbering at WWDC25: there is no iOS 19–25. Safari 26.0 shipped 2025‑09‑15, then 26.1 (Nov 2025), 26.2 (Dec 2025), 26.3 (Feb 2026), 26.4 (Mar 2026), 26.5 (May 2026), 26.6 (Jul 2026).

**Safari 27 / iOS 27 release notes are dated 2026‑09‑14 — two days from now** (build 20625.1.29; "available for iOS 27, iPadOS 27, visionOS 27, macOS 27, macOS 26, macOS Sequoia"). It was announced at WWDC26 (June 2026) with 1100+ fixes. Nothing in Safari 27 changes our PWA story: it has **no Web Apps / Home Screen Web Apps section and no manifest, push, notification, or badging entries at all.** Useful additions for us: the **Service Worker static routing API**, two **print** fixes, and **transform-aware anchor positioning**. One thing to watch: Safari 27 *reverses* HEIC auto-conversion on upload (see Camera below).

**Recommended baseline: iOS 26.2.** That floor buys unprefixed `backdrop-filter` (18.0), view transitions L1 + L2 (18.0 / 18.2), `@page` with margin descriptors (18.2), Wake-Lock-in-standalone (18.4), scroll-driven animations + anchor positioning (26.0), `position-visibility` (26.2), the Navigation API (26.2), **and** the 26.2 fix for *"incorrect clipping of `position: fixed` and `position: sticky` content during view transitions"* — precisely the bug that would wreck a fixed bottom tab bar mid-transition. iOS 26.4 additionally gets threaded scroll-driven animations.

Also note: **Safari 26 freezes the OS version in the user-agent string on iOS 26+.** UA-sniffing for an iOS version number is dead; feature-detect only.

---

## TL;DR

### What we can promise users
- **Install.** Every site can be a Home Screen web app on iOS 26+ — Apple removed *all* installability requirements. A manifest is no longer required; it still controls name/icon/scope/display, so we ship one.
- **Push reminders for RSVPed classes** — but *only after Add to Home Screen*, and only as **visible** notifications. Title + body only. No Apple Developer Program membership needed (standard VAPID Web Push).
- **Badge count on the icon** — `navigator.setAppBadge()`, Home-Screen-only, and the badge only becomes *visible* once notification permission is granted.
- **Offline 30 days of the home school's calendar.** Storage is no longer the constraint: since iOS 17 an origin gets up to **60% of total disk** in a browser app, no prompts, and the installed app gets the *same* quota. Installed web apps are also **exempt from ITP's 7-day script-storage deletion** — a browser-tab PWA is not.
- **Monthly print zine.** `window.print()` works; `@page` (incl. `size`) since iOS 18.2; `print-color-adjust` since 15.4.
- **Share sheet** via `navigator.share()` (iOS 12.2+, files since 15) — we can push *out* to iOS.
- **Add to calendar** via a served `.ics` (`text/calendar`) — see caveat on standalone downloads.
- **Camera for profile photos** via `<input type="file" accept="image/*" capture>` (iOS 10+) and `getUserMedia` (works in standalone since iOS 13.4).
- **Passkeys / WebAuthn** work in a Home Screen web app (iOS 13+), and passkeys live in iCloud Keychain keyed by RP ID, so they survive the Safari→installed-app boundary.

### What we cannot promise
- **No reminders before install.** Push permission cannot even be *requested* in a Safari tab on iOS. This is the single hard constraint that shapes onboarding.
- **No silent/background push.** Every push must show a notification or Safari **revokes the subscription**. There is no background refresh channel.
- **No Background Sync, no Periodic Background Sync, no Background Fetch.** None exist; WebKit has recorded *no position* on two of them and has no entry at all for Periodic Background Sync. The 30-day cache refreshes on app open or on a (visible) push — nothing else.
- **No locally scheduled notifications.** Notification Triggers never shipped outside a Chrome origin trial. Every reminder must be a server-timed push.
- **No notification actions, images, or custom badge masks.** Fold the CTA into the body copy.
- **No `share_target`** — we cannot appear *in* the iOS share sheet. No `file_handlers`, no `launch_handler`, no `protocol_handlers`, no `display_override`, no `shortcuts`, no `background_color` on iOS.
- **No haptics we can trigger.** `navigator.vibrate` is `false` everywhere in Safari and WebKit's formal standards position is **oppose**. The *one* real haptic on the platform is the native tick on `<input type="checkbox" switch>` (attribute since 17.4, haptic since iOS 18) — and the JS trick that abused it was **closed in iOS 26.5**. Use real switch controls for real toggles; build no haptic layer.
- **No `prefers-reduced-transparency`.** Safari does not implement it (WebKit #175497 open since 2017; WebKit position: "Concerns"), despite iOS having the Reduce Transparency setting — we need our own in-app "reduce blur" toggle.
- **No element fullscreen on iPhone** (iPad only, since 16.4, with an undismissable overlay button).
- **No `screen.orientation.lock()`** (reading `screen.orientation` works from 16.4). Manifest `orientation` is ignored. Design for both orientations.
- **`display-mode: standalone` lies on iOS.** In an installed `display: standalone` web app, WebKit reports `display-mode: standalone` as **false** and `display-mode: fullscreen` as **true** (WebKit #264218). Detect install with `navigator.standalone`, never with the media query alone.
- **No reliable QR scanning via `BarcodeDetector`** — flag-gated on iOS and broken since iOS 18 (WebKit #281848). Ship a WASM decoder.
- **Storage does not cross the Safari↔installed boundary.** Only **cookies** are copied, **once, at install** (Safari 17.2+). localStorage / IndexedDB / Cache API / SW registrations do not. This is what breaks ATProto OAuth — see below.

---

## Checklist

Legend — **HS-only?** = works only in a Home Screen web app. Verdicts: **use** / **degrade** (ship with a fallback) / **skip**.

### Install & identity

| Feature | Safari/WebKit status | HS-only? | Our use | Verdict | Source |
|---|---|---|---|---|---|
| Home Screen install | iOS 26: **zero installability requirements** — "every website added to the Home Screen opens as a web app"; user can opt out via an **Open as Web App** toggle. Manifest optional since 26.0; before that needed `display: standalone\|fullscreen` or `apple-touch-icon`. No `beforeinstallprompt`, no programmatic install — ever. | n/a | The whole gate for push + badging | **use** (and nudge manually) | WebKit 26.0 blog; Apple Support "Turn a website into an app" |
| `display` | iOS **11.3**; only `standalone` and `browser` recorded as supported. `minimal-ui` unsupported. `display: fullscreen` is a **source conflict**: MDN BCD says unsupported, but WebKit's push blog says a manifest "with its `display` member set to `standalone` **or `fullscreen`**" makes the site a web app — likely it triggers web-app mode without true fullscreen. | no | `standalone` | **use** | MDN BCD; WebKit 13878 |
| `display-mode` media query | iOS **12.2**, but **wrong in installed apps**: with `display: standalone`, `display-mode: standalone` is **false** and `display-mode: fullscreen` is **true** (WebKit #264218). `minimal-ui` is never true; in tabs `browser` is always true even under the Fullscreen API. | — | Do **not** use for install detection on iOS | **degrade** — `navigator.standalone` first | MDN BCD `css.at-rules.media.display-mode`; webkit.org/b/264218 |
| `display_override` | **Not supported on iOS** (`false`). So it is *not* available as an OAuth mitigation. | — | — | **skip** | MDN BCD |
| `name` / `short_name` / `start_url` / `scope` | iOS **11.3** | no | App name, launch URL, scope | **use** | MDN BCD |
| `id` | iOS **16.4** | no | Stable app identity | **use** | MDN BCD |
| `icons` | iOS **15.4**, with a sharp caveat: manifest icons are **"only used when no `apple-touch-icon` is present"**, and only when `purpose` is `any` or unset — so **`maskable` icons are ignored**. Safari 26.0 added **SVG icons** ("Added support for SVG icons. (113567909)") and **`data:` URL icons** ("(143967312)"). | no | Ship `apple-touch-icon` *and* manifest icons; never rely on `maskable` | **use** | MDN BCD; Safari 26.0 release notes; WebKit 26.0 blog |
| `categories`, `screenshots`, `handle_links` | **Not tracked in MDN BCD**; no evidence Safari uses them and iOS has no install UI to show screenshots. | — | Harmless; assume ignored | **skip** (keep for Android) | MDN BCD (absent) |
| `theme_color` | iOS **15**. **But in Safari 26 on iOS the chrome-tinting algorithm no longer reads `theme-color`** — it samples `background-color`/`backdrop-filter` from fixed/sticky elements near the viewport edges. Give `html`/`body` an explicit `background-color` or you get white/black bars. | no | Keep it for Android/other; rely on CSS for iOS | **degrade** | MDN BCD; 1ar.io Safari 26 Liquid Glass teardown (2026‑05‑13) — community-verified, not Apple-documented |
| `background_color`, `orientation`, `shortcuts`, `related_applications`, `prefer_related_applications`, `protocol_handlers`, `scope_extensions`, `file_handlers`, `launch_handler`, `share_target` | **All `false` on iOS.** (`shortcuts` is macOS 17.4 only.) | — | — | **skip** | MDN BCD `manifests.webapp.*` |
| `apple-mobile-web-app-capable` etc. | Still honored; no longer *required* on iOS 26+. `apple-mobile-web-app-title` overrides the icon label; `apple-mobile-web-app-status-bar-style: black-translucent` is how you get content under the status bar (pair with `viewport-fit=cover` + `env(safe-area-inset-top)`). | no | Keep all three for pre-26 devices | **use** | Apple "Configuring Web Applications" (archive); WebKit 16.4 blog |
| Splash screen | iOS **does not** generate one from the manifest. web.dev, verbatim: *"Android creates splash screens automatically based on the manifest's values. That's not the case for iOS and iPadOS"*; *"the startup image must have the exact window size that your PWA will have on opening"*; *"If you don't provide a startup image… a white screen will appear instead in the opening animation."* `background_color` is unsupported so it cannot even tint it. | yes | Generate `apple-touch-startup-image` for current iPhone sizes (portrait + landscape media queries), or accept a white flash and make first paint instant | **degrade** | web.dev Learn PWA — Enhancements; MDN BCD |

### Notifications

| Feature | Safari/WebKit status | HS-only? | Our use | Verdict | Source |
|---|---|---|---|---|---|
| Web Push | iOS **16.4**. caniuse marks every iOS row 16.4→26.6 partial, note: *"Requires website to first be added to the Home Screen."* iOS 26's "every site can be a web app" **lowered the bar to become a web app; it did not move push into tabs.** Standard VAPID — **no Apple Developer Program membership required.** Server must reach `https://*.push.apple.com`, TLS **with SNI**. | **yes** | RSVP reminders | **use**, gated behind install | caniuse `push-api`; Apple "Sending web push notifications…"; WebKit 16.4 blog |
| Permission prompt | Must be called **immediately from a user-gesture event handler**: *"When the user completes the gesture, call the push subscription method immediately from the gesture's event handler code."* | yes | "Remind me" button | **use** | Apple docs; WebKit 13878 |
| Payload limit | **4 KB** (HTTP 413 = "payload size is over the limit of 4 KB") | yes | Keep payloads to ids + short strings | **use** | Apple docs |
| Silent push | **Prohibited.** *"Safari doesn't support invisible push notifications… If you don't [show one], Safari revokes the push notification permission for your site."* Community reporting puts the tolerance at ~3 violations before the subscription is cancelled. | yes | Never push without showing | **use (carefully)** | Apple docs; WebKit 12945; Progressier (2023‑06‑30) |
| **Declarative Web Push** | iOS/iPadOS **18.4** (macOS 15.5). JSON payload `{"web_push": 8030, "notification": {title, body, navigate, app_badge, mutable}}`. No service worker required. With `"mutable": true` the SW still gets a `PushEvent` and may replace the notification — and critically **there is no penalty if the SW fails to show one**, because the declarative payload is the fallback. | yes | **Use this as the primary transport.** It removes the revocation risk *and* gives us a free hook to refresh the calendar cache in the SW. | **use** | WebKit "Meet Declarative Web Push"; WebKit explainer |
| Notification actions / `image` / `badge` / `requireInteraction` | **All `false`** on iOS. `silent` is macOS-only. | — | Fold CTA into body text | **skip** | MDN BCD `api.Notification.*` |
| Locally scheduled notifications (Notification Triggers, `showTrigger`) | **Never shipped in Safari**; Chrome origin trial only. | — | — | **skip** — all reminder timing lives server-side | Chrome for Developers; MDN |
| Badging API | iOS **16.4**, Home-Screen-only ("Badging is supported for web apps saved to the home screen"). `setAppBadge(0)` **clears** rather than showing a dot. You may call it in foreground or from a push handler even before permission; the badge only *renders* once notification permission is granted, and users manage it under Notifications settings. Document badges not implemented. | **yes** | Unread count of upcoming RSVPs | **use** | MDN BCD; WebKit "Badging for Home Screen Web Apps" |
| Subscription durability | No `expirationTime` exposed; endpoints can silently go dead (community reports of 1–2 weeks of inactivity). Push responses can look successful against a dead subscription. | yes | Re-subscribe on every launch and reconcile server-side; treat push as best-effort, always show reminders in-app too | **degrade** | Apple dev forums; community reporting — **not Apple-documented** |

### Background work & storage

| Feature | Safari/WebKit status | HS-only? | Our use | Verdict | Source |
|---|---|---|---|---|---|
| Service workers | iOS **11.3**. Safari 27 adds the **static routing API**. 26.x/27 fixed several SW registration robustness bugs. | no | Offline shell + calendar cache | **use** | caniuse `serviceworkers`; Safari 27 notes |
| Cache API | iOS **11.3**. Inside the quota regime. A cached `200` does **not** satisfy a media element's `Range` request — synthesize `206` yourself if we ever cache audio/video. | no | 30-day calendar + app shell | **use** | MDN; web.dev sw-range-requests |
| IndexedDB | iOS **8**; the most-patched area in 26.x (26.5 fixed *"connections could become permanently broken until the page was reloaded"*; 27 fixes three more). | no | RSVP queue, skill records | **use**, but wrap every txn in retry-on-reload | Safari 26.5 / 27 release notes |
| Storage quota | **Per-origin up to 60% of total disk** in a browser app (15% in WKWebView-hosted apps); overall 80%/20%; cross-origin frames 10% of the main origin's. **No prompts since Safari 17.** `navigator.storage.estimate()` since iOS 17 (`usageDetails` unsupported). **Installed app gets the same quota as the tab.** | no | 30 days of calendar is nothing | **use** | WebKit "Updates to Storage Policy" (2023‑08‑10) — still WebKit's current statement |
| ITP 7-day script-storage deletion | **Still in effect** for browsing: ITP deletes all script-writable storage (localStorage, IndexedDB, sessionStorage, **SW registrations and cache**) after 7 days of *Safari use* without interaction. **Home Screen web apps are exempt**: *"The first-party domain of home screen web applications is exempt from ITP's 7-day cap on all script-writable storage."* | **exemption is HS-only** | Another reason to get users installed | **use** | webkit.org/tracking-prevention; WebKit "Full Third-Party Cookie Blocking and More" |
| `navigator.storage.persist()` | iOS **15.2**. WebKit: *"grants a request based on heuristics like whether the website is opened as a Home Screen Web App."* | heuristic favours HS | Call it once after install | **use** (don't depend on the return value) | WebKit storage-policy post; MDN BCD |
| Background Sync (one-shot) | **Not supported**, any version. WebKit standards-position #14: **no position recorded**, concerns `privacy`, `power`. | — | — | **skip** — flush the RSVP queue on next launch / on push | caniuse; WebKit/standards-positions#14 |
| Periodic Background Sync | **Not supported.** WebKit's standards-positions has **zero entries** matching "periodic" — the oft-cited "Apple opposes it" line is *Mozilla's* position, not WebKit's. | — | — | **skip** | MDN; WebKit standards-positions summary.json |
| Background Fetch | **Not supported.** WebKit position #149: no position, concerns `privacy`, `maintenance`. | — | — | **skip** | WebKit/standards-positions#149 |
| Push-triggered cache update | The SW may do arbitrary work (incl. Cache API writes) in `push`, but must show a notification in the same event — **unless** the push is declarative+mutable, which removes the penalty. No documented time budget. | yes | Piggyback a calendar delta-refresh on each reminder push | **use** | WebKit declarative-push explainer; Apple docs |
| Safari ↔ installed storage partition | **Separate partitions.** WebKit (bug 181849): *"Home Screen apps are created as isolated entities without shared state with the browser."* The one relaxation (Safari **17.2**): on add-to-Home-Screen **cookies are copied over, including login state** — *"After a user adds a web app to the Home Screen or Dock, no other website data is shared."* One-time copy, cookies only. iOS 26 did not change this. | — | Dictates the whole auth design | **design around it** | WebKit bug 181849; WebKit 17.2 blog |

### Sharing, files, print, calendar

| Feature | Safari/WebKit status | HS-only? | Our use | Verdict | Source |
|---|---|---|---|---|---|
| Web Share API (`navigator.share`) | iOS **12.2**; `canShare()` and the **`files` member** iOS **14** (BCD mirrors these from macOS 14 rather than stating them for iOS — flagged). Spec-mandated: *"If global does not have transient activation, return a promise rejected with a NotAllowedError"* then *"Consume user activation"* — so **one share per gesture, and no `await fetch(...)` before calling it** (WebKit #197779). Rejects `AbortError` on cancel. | no | Share a class, a skill, an invite QR, the zine PDF | **use** — **build the `File` objects before the tap** | caniuse `web-share`; W3C Web Share spec; MDN BCD |
| `share_target` (be a share target) | **Not supported on iOS or macOS**, never shipped in any Safari. WebKit standards-position **#11 = `neutral`, closed**; #62 duplicate/not planned. An installed iOS web app **cannot appear in the iOS share sheet.** Only a native App Store app with a Share Extension can. | — | — | **skip** | MDN BCD; WebKit standards-positions #11 |
| `<a download>` | iOS **13** (WebKit #167341, "enabled in the iOS 13 Developer beta 1, along with true downloads support in MobileSafari"). Works for same-origin, `blob:` and `data:`. **Downloads do work in standalone** and Apple has actively fixed that path (18.5 "Fixed Service Worker downloads being prematurely interrupted"; 26.2 "Fixed an issue where service worker downloads are not being saved to Downloads folder"). Two hard-won rules: **use `target="_self"`** (`_blank` + `download` trips the popup blocker and loses the filename, WebKit #190351), and **serve a correct `Content-Type` plus `Content-Disposition: attachment; filename=`** — Safari 26.5 fixed two bugs where the extension came from the URL path rather than the header. | no | Zine PDF, `.ics` | **use** with those two rules; keep a Share fallback | WebKit #167341, #190351; Safari 26.5 / 26.2 / 18.5 release notes |
| File System Access (`showOpenFilePicker`) | **Not supported.** `FileSystemHandle`/OPFS exists (iOS 15.2) but origin-private only; `queryPermission`/`requestPermission`/`remove` all `false`. | — | — | **skip** | MDN BCD |
| `window.print()` | iOS **1**; `@media print` iOS 1. Prints via the iOS print sheet (from which the user can save as PDF). | no | Zine | **use** | MDN BCD |
| `@page` | iOS **18.2**, including **margin descriptors** — Apple: *"Added support for `@page` margin descriptors. (118773100)"*, plus `jis-b4`/`jis-b5` sizes. `size` with explicit dimensions or named sizes works; **`size: landscape` / `portrait` keywords are NOT supported.** `@page :first`/`:left`/`:right`/`:blank` and margin boxes (`@top-center`) are unsupported / untracked. | no | Zine trim size + margins; use explicit dimensions, not keywords | **use** | Safari 18.2 release notes; MDN BCD |
| Page breaks | `page-break-before/after/inside` iOS **1.3**; modern `break-*` iOS 10 but **`break-before: avoid` / `break-after: avoid` are recognised and have no effect** (WebKit #294559), and `break-inside: avoid-page` is `false`. caniuse also notes `left`/`right` are treated like `always`. | no | **Use `page-break-inside: avoid`** on class blocks; never rely on `avoid` for before/after | **degrade** | MDN BCD; caniuse `css-page-break`; webkit.org/b/294559 |
| `print-color-adjust` | iOS **15.4** (prefixed since iOS 6). **Caveat: Safari does not print the `<body>` element's background** — setting `exact` on `<body>` applies only to descendants. | no | Put the zine's paper colour on a wrapper div, not `body` | **use** | MDN BCD note |
| Print + animation | Safari 27: *"Fixed an issue where animations were ignored during print, causing missing content on animated pages. (36901701)"* | no | Keep the zine print stylesheet free of entry animations, or require 27 | **degrade** | Safari 27 release notes |
| `.ics` / Add to Calendar | **Apple documents link-tapping**: "You can also subscribe to an iCalendar (.ics) calendar by tapping a link to it." That's for *subscriptions*; single-`VEVENT` import showing a Calendar preview is forum-level evidence only. **`data:` URL `.ics` will not work** — top-level navigation to `data:` is blocked in all modern browsers, and Safari 27 tightened `data:` redirects further. **`webcal://` link handling in iOS Safari is NOT confirmed by any Apple/WebKit source** (Apple documents the scheme only for AppleScript). | no | Per-class: plain `<a href="https://…/event.ics">` served as `text/calendar`, `target="_self"`, **no** `download` attribute, so iOS does a real navigation and hands off to Calendar. School-wide: offer a `webcal://` subscribe link **with an `https://…ics` fallback beside it.** | **use** (with fallback) | Apple Support iph3d1110d4; MDN `data:` URLs; Safari 27 release notes |

### Camera, codes, sensors

| Feature | Safari/WebKit status | HS-only? | Our use | Verdict | Source |
|---|---|---|---|---|---|
| `getUserMedia` | iOS **11**; **works in standalone Home Screen web apps since iOS 13.4** (caniuse's "does not work in installed PWAs" note is attached only to iOS 11.0–13.3; WebKit #185448). HTTPS + user gesture. Recent fixes: 26.1 spurious `devicechange` events on iOS; 27 wrong frame orientation after transient rotation. `facingMode: 'environment'` is a **hint** — enumerate devices and offer a flip control. | no | Live QR scanning | **use** | caniuse `stream`; WebKit #185448; Safari 26.1 / 27 notes |
| `<input type="file" accept="image/*" capture>` | iOS **10** (macOS ignores it). `capture` is a **hint** — recent iPhones often still show the Photo Library / Take Photo sheet. Must open from a real gesture in the same event stack; Safari can refuse a `display: none` input. **⚠️ HEIC behaviour changed in Safari 27**: *"Fixed an issue where HEIC images were incorrectly converted to JPEG when uploaded via drag-and-drop or file input. (173206598)"* — so iOS 27 clients may hand us genuine `image/heic` where iOS 26 handed us JPEG. | no | Profile photos — **prefer this over `getUserMedia`** (simpler, no permission dance) | **use**, but: list explicit types (`accept="image/jpeg,image/png,image/webp"`), decode or reject HEIC server-side, and **test an iOS 27 device against an iOS 26 one** | MDN BCD; Safari 27 release notes |
| `BarcodeDetector` / Shape Detection | **Flag-gated and off by default on iOS** — MDN BCD records iOS 17 behind a `preference` named "Shape Detection API"; also **broken since iOS 18** (WebKit #281848). WebKit's standards position is actually `support` (#174) yet it is still unshipped and unmentioned in Safari 27. `FaceDetector`/`TextDetector` have no BCD entry at all. | — | — | **skip**; feature-detect, never assume | MDN BCD; WebKit #281848; WebKit standards-positions #174 |
| QR scanning (practical) | `getUserMedia` + a WASM decoder (`zxing-wasm` or `jsQR`) on a `<canvas>`/`ImageBitmap` loop. No native WebKit path exists (iOS's own QR scanning is Camera.app / Vision, native-only). | no | Invite links, check-in | **use** (WASM lib) | — |
| QR scanning fallback | `<input type="file" accept="image/*" capture="environment">` → decode the still with the same WASM decoder. No camera-stream permission needed. | no | Covers denied/blocked camera | **use** | — |
| QR generation | Pure JS/SVG, no platform API needed. | no | Invite links | **use** | — |
| Screen Wake Lock | Safari **16.4** in tabs, but BCD records iOS 16.4 as **partial — "Does not work in standalone Home Screen Web Apps"** — fixed in **18.4**. Apple, Home Screen Web Apps → Resolved Issues: *"Fixed Wake Lock API for Home Screen Web Apps. (108573133)"*. Sentinel auto-releases on visibility loss → re-acquire on `visibilitychange`. | the *fix* matters only in standalone | Keep screen on during a class / check-in | **use** (floor ≥ 18.4) | MDN BCD; Safari 18.4 release notes; WebKit #254545 |
| Contact Picker | BCD records iOS 14.5 **behind a feature flag named "Contact Picker API", off by default**; macOS `false`. No shippable version, no WebKit standards position. | — | — | **skip** — use `<input accept=".vcf">` or manual entry | MDN BCD; BCD issue #14648 |
| Geolocation | iOS **3.2**, HTTPS only. `permissions.query({name:'geolocation'})` from iOS 16 (query only — `request()`/`revoke()` are `false`). **⚠️ The permission model inside a Home Screen web app is undocumented by Apple.** Forum reports (2023–24): in `display: standalone` the location alert sometimes does not appear in the web app and surfaces in Safari instead; a page refresh can re-prompt. | likely differs — unverified | "classes near me" | **degrade**: call `getCurrentPosition()` only from a gesture, never gate startup on a cached grant, always have an error path + manual location entry | caniuse; MDN BCD; Apple forums 694999 / 740270 (secondary) |
| Screen Orientation | `screen.orientation` readable from iOS **16.4**; **`lock()` is `false`** on Safari and iOS. Manifest `orientation` ignored. | no | — | **skip** lock; design for both orientations | MDN BCD |
| Haptics / Vibration | **`navigator.vibrate` is `false` in Safari on every platform**, and WebKit's standards position is **`oppose`** (#267, concerns: annoyance, device independence, portability, power). `Gamepad.vibrationActuator` is macOS-only. Zero occurrences of "haptic"/"Taptic"/"Vibration" in any 26.0–26.6 or 27 release note. **The one real haptic**: WebKit shipped native haptic feedback for `<input type="checkbox" switch>` in **iOS 18** (the `switch` attribute itself in Safari 17.4). The library trick that drove that tick programmatically from JS worked 17.4→26.4 and **Apple closed every programmatic re-tick path in iOS 26.5** (third-party report, not Apple-documented). | no | — | **skip** any haptic layer. Use a real `<input type=checkbox switch>` for genuine toggles and get the native tick for free. | MDN BCD; WebKit standards-positions #267; WebKit 18.0 blog; WebKit "An HTML Switch Control" |

### UI / CSS for the native feel

| Feature | Safari/WebKit status | HS-only? | Our use | Verdict | Source |
|---|---|---|---|---|---|
| `backdrop-filter` | `-webkit-backdrop-filter` since iOS **9**; **unprefixed since iOS 18**. Two traps: (a) the **backdrop root** — any ancestor with `opacity < 1`, a `filter`, or certain `will-change` values silently kills the blur, so keep the frosted bar a **direct child of `<body>`**, never inside an animated/faded wrapper; (b) Safari 26's chrome-tinting sampler reads `backdrop-filter` on fixed/sticky edges, so move the glass onto an **absolutely-positioned child** of the fixed bar. Don't animate the blur value; animate `opacity`. | no | Frosted tab bar + headers | **use** (both prefixes) | MDN `backdrop-filter`; WebKit #98538; 1ar.io teardown |
| `env(safe-area-inset-*)` + `viewport-fit=cover` | `env()` iOS **11.3** (the `constant()` spelling in 11.0–11.2 was removed); `viewport-fit=cover` iOS **11.0** and **required** — without it the page is auto-inset and the insets resolve to 0. Use `max()` per WebKit's own advice. **Standalone vs tab differs materially**: in a Home Screen app `safe-area-inset-bottom` is the stable home-indicator inset; in a Safari tab it tracks Safari's collapsing toolbar and **changes during scroll** → layout thrash on a bottom bar. Nothing new for safe areas in 26.x or 27. iPadOS 26 windowed mode reportedly ignores window controls. | **yes, behaviour differs** | Tab bar + large-title header padding | **use**, with `max(12px, env(...))` so tab-mode collapse can't reflow the bar | WebKit "Designing Websites for iPhone X"; MDN `env`; Apple forums 716552 / 699415 |
| `env(safe-area-max-inset-*)` | **Not supported in Safari** — Chromium-only (CSSWG #11019). This is exactly the variable that would fix the tab-mode thrash above, and we don't get it. | — | — | **skip**; write `env(safe-area-max-inset-bottom, env(safe-area-inset-bottom, 0px))` so it upgrades for free | MDN `env`; w3c/csswg-drafts#11019 |
| `env(keyboard-inset-*)` | **Not supported in Safari** (`false`). | — | — | **skip** | MDN `env` |
| Dynamic Island env var | **Does not exist** in any spec or implementation. The island is covered by `safe-area-inset-top` like any sensor housing. | — | — | n/a | MDN `env` (complete inventory) |
| `prefers-reduced-transparency` | **Not supported in Safari** (`false`, still "experimental"). WebKit **#175497** open since 2017‑08‑11, status NEW; a 2023 comment records WebKit's standards position as **"Concerns"**. Zero mentions in 26.x/27. | — | — | **skip** → ship our own "Reduce blur" setting | MDN BCD; webkit.org/b/175497 |
| `prefers-reduced-motion` | iOS **10.3** — WebKit shipped it first of any engine. | no | Disable sheet/tab transitions; **gate view transitions manually**, the interaction is not documented | **use** | MDN |
| View Transitions (same-doc) | iOS **18.0**; `document.activeViewTransition` in 26.2. **26.2 also fixed "incorrect clipping of `position: fixed` and `position: sticky` content during view transitions" (154886047)** — the tab-bar bug. 26.2 fixed flickering of slow-painting content; 26.0 fixed `<canvas>` disappearing for one frame; 27 fixed two more. Element-scoped/nested transitions not yet in Safari. | no | Tab + push/pop transitions | **use**, floor **≥ 26.2**, and give the tab bar an explicit `view-transition-name` | Safari 26.0/26.2/27 release notes; WebKit 18.0 blog |
| Cross-document View Transitions (`@view-transition`) | iOS **18.2** (with `view-transition-class` and `view-transition-name: auto`). Same-origin only; ~4 s render timeout degrades silently to a plain navigation; names must exist on both pages. | **unverified in standalone** | Only if we go MPA | **use if MPA** — but test in standalone first | WebKit 18.2 blog; Chrome docs |
| `dvh` / `svh` / `lvh` (+ `vi`/`vb`) | iOS **15.4**. `vh` = *large* viewport, which is the old `100vh` bug. **`dvh` jitter during scroll is specified behaviour, not a bug** — it tracks the collapsing toolbar, so it will not be "fixed". | no | `100dvh` for the outer app frame; `100svh` for heroes; **never `dvh` as an animation endpoint** | **use** | MDN `length` |
| `interactive-widget` viewport property | **Not supported on iOS** (`false`, all three values). Harmless to include; does nothing. | — | — | **skip** |  MDN BCD |
| Keyboard avoidance for the bottom tab bar | No `navigator.virtualKeyboard`, no `virtualkeyboardpolicy`, no `env(keyboard-inset-*)` — all Chromium-only. On iOS the **layout viewport does not resize**; the visual viewport shrinks and the page is offset, so a `position: fixed; bottom: 0` bar ends up behind/below the keyboard. `window.visualViewport` iOS **13** (`scrollend` on it is unsupported). Workaround: position from the **top** — `bar.style.top = (vv.height + vv.offsetTop) + 'px'; transform: translateY(-100%)` — re-pinned on `resize`/`scroll`, **and also on `blur`/`focusout`**, because `offsetTop` does not always reset to 0 on dismissal. | no | Tab bar + comment/RSVP inputs | **degrade**: a `visualViewport` controller, or simply hide the tab bar while an input is focused | MDN `VisualViewport`, `VirtualKeyboard`, `env`; Apple forums 705793 / 800125 |
| `<dialog>` / `popover` | `<dialog>` iOS **15.4**, `:modal` 15.6, `requestClose()` 18.4, `toggle` event 26.0, `:open` 26.5. `popover` Safari **17.0** (fuller set ~18.3); Safari 27 fixed nested `position: absolute` children of popovers failing to render and a `display`-transition bug when closing. **`closedby` unsupported on iOS; `CloseWatcher` unsupported in Safari** — no declarative Esc/back integration. Background scroll-lock behind a modal is still manual. | no | Sheets, menus | **use**, with a manual dismiss handler and scroll lock | MDN BCD; Safari 27 release notes |
| `@starting-style` / `transition-behavior: allow-discrete` | `@starting-style` Safari **17.5** (26.4 fixed it only applying on the first transition, notably with anchor positioning); `allow-discrete` **17.4**. | no | Sheet enter/exit with `display`/`overlay` | **use** | MDN; Safari 26.4 release notes |
| Anchor positioning | iOS **26.0**; `position-try` memory 26.1; `position-visibility` + `safe` with `anchor-center`/`flip-*` **26.2**; 3+-deep chains fixed 26.5; transform-aware anchoring in **27**. `position-anchor` had a wrong initial value in 26 (WebKit #308981/#311941), corrected in 27. | no | Menus/tooltips | **degrade** — progressive enhancement only; floor **≥ 26.2** | MDN; Safari 26.x/27 release notes |
| Scroll-driven animations | iOS **26.0** on by default; **26.4 added threaded scroll-driven animations** ("(168027635)"); 26.5 fixed the `scroll` range name and `animation-play-state: paused`. | no | Large-title collapse on scroll | **use**, floor ≥ 26.4 for no jank | Safari 26.0/26.4/26.5 release notes |
| `overscroll-behavior` | iOS **16**, but **partial**: *"no effect on scroll containers that have no scrollable overflow"* — which is why `overscroll-behavior: none` on `html`/`body` often fails to stop document rubber-banding. `chain` unsupported. The old "Apple refuses to implement it" claim is outdated (WebKit #176454 fixed, default-on in 15.1). Safari 27 fixed `passive: false` wheel listeners + `contain` blocking scroll. | no | Stop rubber-band bleed-through on sheets | **use** via the **app-shell pattern**: lock the document (`html,body{height:100%;overflow:hidden;overscroll-behavior:none}`) and put all scrolling in an inner `overflow-y:auto` with `overscroll-behavior: contain` | MDN BCD; WebKit #176454; Safari 27 release notes |
| Touch behaviour | `-webkit-touch-callout: none` (iOS 2, non-standard) is still the only way to kill the long-press callout — apply to chrome only, not globally. **`user-select` is recorded for Safari only under the `-webkit-` prefix** → ship both declarations. `touch-action: manipulation` iOS **9.3** removes double-tap zoom and the ~300 ms tap delay — put it on buttons and tab items. | no | Tab bar, buttons, cards | **use** | MDN BCD |
| Element fullscreen | macOS Safari 16.4. On iOS, BCD records 16.4 **partial** with the note *"Only available on iPad, not on iPhone"*; webstatus.dev reports `safari_ios: None` outright. Even on iPad it *"shows an overlay button which can not be disabled"* and swipe-down exits. Nothing changed in 17/18/26/27. iPhone full-screen video goes through the native player (`webkitEnterFullscreen`). | — | — | **skip** on iPhone; build a full-bleed in-page zine view and rely on standalone mode for chromelessness | MDN BCD; webstatus.dev; caniuse `fullscreen` note #5 |
| Navigation API | iOS **26.2** — intercepts link clicks, form submissions, back/forward, and programmatic changes. | no | SPA routing with proper intercepts | **use** (with a fallback router) | WebKit 26.2 blog |
| WebAuthn / passkeys | iOS **13** (`PublicKeyCredential`). Works in a Home Screen web app. Passkeys live in iCloud Keychain keyed by **RP ID**, not by storage partition, so one created in Safari is usable in the installed app. | no | Optional second factor / account recovery | **use** | MDN BCD; passkeys.dev |

---

## The OAuth-in-standalone problem (and how we beat it)

### What breaks

ATProto OAuth is a browser-redirect flow: PAR → redirect to the user's PDS/entryway → consent → redirect back to `redirect_uri`, with **PKCE mandatory** and **DPoP mandatory** (the client holds a per-session DPoP keypair).

Three iOS facts collide with that:

1. **Out-of-scope navigation leaves the standalone window.** When a Home Screen web app navigates to a third-party origin (the authorization server), iOS hands it to an in-app browser overlay (and historically, to Safari proper). When the authorization server redirects back to a URL **inside our `scope`**, iOS generally closes the overlay and resumes in the standalone window — but this has been fragile across versions, and if the chain lands outside scope the user is stranded in a browser, looking at our app, in a *different storage partition*.
2. **The installed app is a separate storage partition.** WebKit is explicit: *"Home Screen apps are created as isolated entities without shared state with the browser."* Since Safari 17.2, adding to the Home Screen **copies cookies once** — *"no other website data is shared."* So `localStorage`, `IndexedDB`, `sessionStorage`, Cache API, and SW registrations do **not** cross.
3. **`@atproto/oauth-client-browser` stores its sessions — and its DPoP keys — in IndexedDB.** Its own docs: tokens "will be saved in the session store (in the browser's indexed DB)." A DPoP key is a `CryptoKey`; even if we wanted to hand-copy it through a cookie we could not, because it is non-extractable by design.

Net effect of the naïve build: user signs in **in Safari**, installs the app, taps the icon, and is **signed out** — and there is no way to migrate the session, because the useful part of it is a non-extractable key in the wrong partition. This is not hypothetical; it is the exact bug a real PWA shipped a fix for on 2026‑09‑11 (Cleffy PR #37: *"iOS Home Screen apps do not share Safari's localStorage, so tapping the icon after Add to Home Screen launched a fresh partition with no session."* Their fix was a compact refresh-token **cookie**.)

### Mitigations, ranked

**1. Use a BFF (backend-for-frontend) and keep the session in a cookie. — our recommendation.**
Bluesky's own guidance: *"When a backend server is available, it is recommended to use `@atproto/oauth-client-node`… more secure than managing OAuth sessions from the front-end directly."* Run the ATProto OAuth dance server-side as a **confidential client**; the DPoP key and tokens never touch the browser; the browser holds only a `HttpOnly; Secure; SameSite=Lax` session cookie on *our* origin. Three wins at once:
- The `redirect_uri` is on **our origin and inside our `scope`**, so the overlay/Safari hop always lands back in the standalone window.
- The session **survives install**, because cookies are exactly what iOS copies at add-to-Home-Screen time.
- No PKCE verifier or DPoP key needs to survive a partition hop, because they live on the server.

**2. Authenticate *before* install, then nudge install.** Complements (1) rather than replacing it: because the cookie copy happens at install, a signed-in Safari session becomes a signed-in app. This is also the right order for onboarding anyway (see below) — the user RSVPs first, then installs for reminders.

**3. Keep every auth URL inside `scope`.** `scope: "/"`, and make the callback a first-party route (`/oauth/callback`). Never bounce through a third-party auth subdomain we could have kept first-party.

**4. Re-auth is cheap, so make it graceful.** On a cold standalone launch with no session, route straight to `/login?next=<intended route>` — not to the marketing page. Keep the login screen inside the safe area (`padding-top: max(…, env(safe-area-inset-top))`) because `black-translucent` puts content under the status bar.

### Mitigations that do **not** work on iOS

- **`display_override`** — unsupported on iOS (`false`). Cannot be used to opt a route into browser display.
- **`display: browser`** — technically available, but it surrenders the entire point: no standalone chrome and, critically, **no web push and no badging**. Never ship it for the main app.
- **`ASWebAuthenticationSession`** — a native Swift/ObjC API. Not reachable from web content. No equivalent exists.
- **Popup OAuth (`window.open` + `postMessage`)** — unreliable in standalone: the popup may open as an overlay or a Safari tab, may be in a different partition, and the opener relationship is not dependable. Do not build on it.
- **Copying the session through a cookie by hand** — works for a refresh token (as Cleffy did), but **not** for ATProto, because the DPoP key is non-extractable. This is the decisive reason to go BFF.

---

## The install-nudge pattern

### Principles

1. **Never promise reminders before install.** On iOS the "Remind me" affordance must be *visibly gated*, not silently broken.
2. **Ask after value, not on arrival.** Trigger on the **first successful RSVP**, when the user has just demonstrated they care about a specific class at a specific time.
3. **Ask once, remember the answer.** Max one prompt per 14 days, max three lifetime, cleared on install.
4. **Detect the dead ends.** In-app browsers (Instagram, Facebook, Telegram, Slack) cannot Add to Home Screen at all. Don't show install steps there — show "Open in Safari."
5. **Don't hardcode the tap path.** Apple moved Add to Home Screen in **iOS 26** (hidden behind `⋯` in the new default Compact toolbar) and **moved it again in iOS 27**. Write copy that names the outcome and the menu, not a specific icon position, and include a short "can't find it?" escape hatch.

### Flow

```
RSVP succeeds
  └─ standalone?            → yes → offer "Remind me" (push permission on tap)
  └─ in-app browser?        → yes → sheet: "Open in Safari to get reminders"  [Copy link]
  └─ iOS Safari, not installed → sheet: "Add Free School to your Home Screen"
                                  (appears once; dismissible; 14-day cooldown)
  └─ non-iOS                → standard prompt / beforeinstallprompt
```

After install, on first standalone launch: a one-line banner — *"You're in. Turn on reminders?"* — with the button that calls `subscribe()` **inside the tap handler**.

### Copy

**Sheet — iOS Safari, not installed** (title / body / steps / buttons)

> **Get a reminder before class**
> iPhone only sends reminders from apps on your Home Screen. Add Free School — it takes about ten seconds, and it works offline.
>
> 1. Tap the **⋯** or **Share** button in Safari's toolbar
> 2. Choose **Add to Home Screen**
> 3. Keep **Open as Web App** on, then tap **Add**
>
> [ Show me ]  [ Not now ]

`Show me` expands a 3-frame illustration rather than linking out (we cannot open the share sheet programmatically). `Not now` sets the 14-day cooldown.

**Sheet — in-app browser**

> **Open in Safari first**
> You're in Instagram's browser, which can't add apps to your Home Screen. Open this page in Safari and we'll pick up where you left off.
>
> [ Copy link ]  [ Not now ]

(`Copy link` via `navigator.clipboard.writeText`. As of Aug 2026 neither `x-safari-https://` nor `intent`-style escapes reliably open Safari from iOS in-app browsers — do **not** ship one as the primary path.)

**Gated "Remind me" button — not installed**

> 🔔 Remind me — *Add to Home Screen first*

Tapping it opens the install sheet rather than failing. Never call `Notification.requestPermission()` in a tab on iOS.

**Post-install banner**

> Reminders are on the house. **Turn on reminders** for *Intro to Sourdough* and everything else you RSVP to.
> [ Turn on ]  [ Maybe later ]

**After permission denied**

> No reminders, no problem. You'll still see everything you RSVPed to on the Calendar tab. You can turn reminders on later in **Settings → Notifications → Free School**.

### Detection (TypeScript)

```ts
// src/lib/ios-install.ts
// Detection for the iOS install nudge. Verified against Safari 26.6 (iOS 26.6), 2026-09-12.

export type Surface =
  | 'installed'        // running as a Home Screen web app — push is available
  | 'ios-safari'       // real Safari on iOS — can install
  | 'ios-inapp'        // Instagram/FB/Telegram/etc. webview — cannot install
  | 'ios-other-browser'// Chrome/Edge/Firefox on iOS — can install, worse flow
  | 'other';           // not iOS

interface SafariNavigator extends Navigator {
  /** Non-standard, WebKit-only. true in a Home Screen web app. */
  standalone?: boolean;
}

/**
 * True when launched from the Home Screen (iOS) or any standalone display mode.
 *
 * IMPORTANT iOS QUIRK: `(display-mode: standalone)` is FALSE in an installed iOS
 * web app even when the manifest says `display: standalone` — WebKit reports
 * `display-mode: fullscreen` instead (webkit.org/b/264218). So on iOS we trust
 * `navigator.standalone`, and we accept `fullscreen` in the media-query fallback.
 * `navigator.standalone` is also the only signal that works for a web app
 * installed with no manifest at all, which iOS 26 permits.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as SafariNavigator;
  if (typeof nav.standalone === 'boolean') return nav.standalone;
  const mm = window.matchMedia;
  if (!mm) return false;
  return mm('(display-mode: standalone)').matches
    || mm('(display-mode: fullscreen)').matches
    || mm('(display-mode: minimal-ui)').matches;
}

/**
 * iOS or iPadOS, including iPad's desktop-class user agent.
 * Note: Safari 26+ FREEZES the OS version in the UA string, so never try to
 * parse an iOS version number out of it — feature-detect instead.
 */
export function isIOS(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as Macintosh; touch points disambiguate.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/**
 * Best-effort in-app-browser detection. Deliberately conservative: a false
 * negative shows install steps that don't work; a false positive only shows
 * an unnecessary "open in Safari" hint. Since iOS 26 some Facebook builds ship
 * no FBAV/FBAN token at all, so UA sniffing alone is not sufficient — we also
 * probe for injected globals.
 */
export function isInAppBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const w = window as unknown as Record<string, unknown>;

  if ('TelegramWebviewProxy' in w || 'Telegram' in w) return true;
  if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|LinkedInApp|Twitter|Snapchat|Pinterest|GSA\//i.test(ua)) {
    return true;
  }
  // Real iOS Safari always reports "Safari/" and "Version/". Most WKWebView
  // hosts keep "Safari/" but drop "Version/".
  if (isIOS() && /Safari\//.test(ua) && !/Version\//.test(ua)) return true;
  return false;
}

export function detectSurface(): Surface {
  if (isStandalone()) return 'installed';
  if (!isIOS()) return 'other';
  if (isInAppBrowser()) return 'ios-inapp';
  // CriOS = Chrome, EdgiOS = Edge, FxiOS = Firefox — all WebKit, all can install.
  if (/CriOS|EdgiOS|FxiOS|OPT\//.test(navigator.userAgent)) return 'ios-other-browser';
  return 'ios-safari';
}

/** Push can only be requested from an installed app on iOS. */
export function canRequestPush(): boolean {
  if (typeof window === 'undefined') return false;
  const supported = 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
  if (!supported) return false;
  return isIOS() ? isStandalone() : true;
}

// ---- nudge eligibility -------------------------------------------------------

const KEY = 'fs.installNudge.v1';
const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SHOWS = 3;

type NudgeState = { shows: number; lastShownAt: number };

function readState(): NudgeState {
  try {
    return { shows: 0, lastShownAt: 0, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { shows: 0, lastShownAt: 0 }; // private mode / blocked storage
  }
}

/** Call after a successful RSVP — not on first load. */
export function shouldShowInstallNudge(): boolean {
  const surface = detectSurface();
  if (surface !== 'ios-safari' && surface !== 'ios-inapp') return false;
  const { shows, lastShownAt } = readState();
  return shows < MAX_SHOWS && Date.now() - lastShownAt > COOLDOWN_MS;
}

export function recordInstallNudgeShown(): void {
  try {
    const { shows } = readState();
    localStorage.setItem(KEY, JSON.stringify({ shows: shows + 1, lastShownAt: Date.now() }));
  } catch { /* non-fatal */ }
}

/**
 * Subscribe to push. MUST be called synchronously from a user-gesture handler:
 * Apple requires the subscription call to happen "immediately from the gesture's
 * event handler code".
 */
export async function enableReminders(vapidPublicKey: string): Promise<PushSubscription | null> {
  if (!canRequestPush()) return null;
  const permission = await Notification.requestPermission(); // prompt must originate in the gesture
  if (permission !== 'granted') return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true, // required by WebKit; silent push is prohibited
    applicationServerKey: vapidPublicKey,
  });
  // iOS exposes no expirationTime and dead endpoints can look healthy:
  // re-register on every launch and reconcile server-side.
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub),
  });
  void navigator.storage?.persist?.(); // heuristically granted for installed apps
  return sub;
}
```

---

## Manifest example

```json
{
  "id": "/?source=pwa",
  "name": "Free School Boulder",
  "short_name": "Free School",
  "description": "Classes, skills and requests from your neighbours.",
  "start_url": "/?source=pwa",
  "scope": "/",
  "display": "standalone",
  "theme_color": "#F7F4EC",
  "background_color": "#F7F4EC",
  "orientation": "portrait",
  "lang": "en-US",
  "dir": "ltr",
  "categories": ["education", "social", "lifestyle"],
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "screenshots": [
    { "src": "/screens/calendar.png", "sizes": "1170x2532", "type": "image/png", "form_factor": "narrow" }
  ]
}
```

Notes on the iOS-specific parts:
- `background_color`, `orientation`, `shortcuts`, `description`, `share_target`, `file_handlers`, `launch_handler`, `protocol_handlers`, `scope_extensions`, `display_override`, and (untracked, assume ignored) `categories` / `screenshots` / `handle_links` are **all ignored on iOS**. They are here for Android/desktop, not for us.
- **`purpose: "any"` matters**: Safari only uses a manifest icon when `purpose` is `any` or unset, so a `maskable`-only set gives iOS nothing — and `apple-touch-icon` in the HTML beats the manifest entirely.
- The `icon.svg` entry is there because Safari **26.0** added SVG icons (and `data:` URL icons); keep PNGs for everything older.
- Keep `display: "standalone"`, not `"fullscreen"` — BCD records `fullscreen` as unsupported while WebKit's push blog implies it triggers web-app mode. `standalone` is the unambiguous value.

Required `<head>` on iOS (the manifest alone is not enough):

```html
<link rel="manifest" href="/manifest.webmanifest" />

<!-- Safari prefers this over manifest icons. Ship it. -->
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />

<!-- Pre-iOS-26 installability + the label under the icon -->
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="Free School" />

<!-- Content under the status bar; pair with viewport-fit + env() padding -->
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />

<!-- viewport-fit=cover is required for a transparent bottom bar in Safari 26 -->
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />

<!-- Safari 26 tints chrome by sampling CSS, not theme-color. Keep both. -->
<meta name="theme-color" content="#F7F4EC" />
```

```css
/* Safari 26 samples html/body background for chrome tinting; a transparent
   root yields white or black bars. Always paint it. */
html, body { background-color: #F7F4EC; }

/* App-shell scroll lock. overscroll-behavior on html/body is a no-op unless the
   element actually overflows, so put the scrolling in an inner element. */
html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
.app-scroll { height: 100%; overflow-y: auto; overscroll-behavior: contain; }

.tab-bar {
  position: fixed;
  inset-inline: 0;
  bottom: 0;
  /* max() so Safari-tab toolbar collapse (inset changes mid-scroll) can't
     reflow the bar. safe-area-max-inset-* is Chromium-only; the nested env()
     upgrades for free if WebKit ever ships it. */
  padding-bottom: max(10px, env(safe-area-max-inset-bottom, env(safe-area-inset-bottom, 0px)));
  -webkit-touch-callout: none;
  -webkit-user-select: none;          /* Safari only supports the prefixed form */
          user-select: none;
  touch-action: manipulation;          /* kills double-tap zoom + 300ms delay */
}
/* Glass on a CHILD, not the fixed element: (a) Safari 26's chrome-tinting
   sampler reads backdrop-filter on fixed/sticky edges, (b) keeps the bar itself
   free of anything that would make it a backdrop root. */
.tab-bar::before { content: ""; position: absolute; inset: 0; z-index: -1;
  background: rgb(247 244 236 / 0.72);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
          backdrop-filter: saturate(180%) blur(20px); }

.large-title-header { padding-top: max(12px, env(safe-area-inset-top)); }

/* No prefers-reduced-transparency in Safari — expose our own setting. */
:root[data-reduce-blur="true"] .tab-bar::before {
  -webkit-backdrop-filter: none; backdrop-filter: none;
  background: #F7F4EC;
}

/* Zine print sheet */
@page { size: 5.5in 8.5in; margin: 0.5in; }   /* margin descriptors: iOS 18.2+ */
@media print {
  /* Safari never prints the <body> background — put paper colour on a wrapper. */
  .zine-page { background: #FBF8F0; print-color-adjust: exact; }
  /* page-break-inside: avoid works; break-before/after: avoid are no-ops. */
  .zine-class { page-break-inside: avoid; }
  .tab-bar, .app-chrome { display: none; }
}
```

---

## EU DMA: does it matter for a Boulder app?

**Short answer: no, with one thing to watch.**

- Apple briefly removed Home Screen web apps in the EU (Feb 2024), then reversed: since **iOS 17.4** EU users get Home Screen web apps, **built on WebKit**, with push and badging intact. EU users are therefore *not* a degraded case for us.
- Alternative engines are a dead letter in practice. Apple shipped **BrowserEngineKit** in 2024, but as of mid‑2026 **zero browsers on iOS use a non-WebKit engine** — the contractual terms (a separate EU-only app, abandoning existing users) make it commercially unviable. Open Web Advocacy's 2025‑07‑14 assessment also notes third-party engines, if they ever ship, **cannot install web apps or deliver web push** under Apple's current rules.
- The EC has open specification proceedings on Apple's Article 6(7) interoperability compliance, and Apple's EU business terms were revised 2026‑08‑18 with further changes effective **2026‑10‑01**. None of it touches PWA capability.
- **One conflicting secondary claim to be aware of:** at least one 2026 PWA-limitations roundup asserts that EU standalone web apps are degraded (opening in Safari tabs, no push). That contradicts the 17.4 reinstatement and I found **no Apple source supporting it** — I am treating it as stale reporting of the Feb 2024 removal. If EU users ever matter commercially, confirm on an EU device before relying on push there.
- **Practical consequence for us: none.** We are WebKit-only on iOS in every jurisdiction, so there is one code path. The only second-order thing worth tracking: if engine choice ever becomes real *and* extends beyond the EU, a Chromium iOS build would give us Background Sync and `share_target` — a bonus, never a dependency.

---

## Sources

All read **2026‑09‑12** unless noted.

**Apple / WebKit (primary)**
- Safari release notes index — https://developer.apple.com/documentation/safari-release-notes
- Safari 26.6 release notes (dated 2026‑07‑27) — https://developer.apple.com/documentation/safari-release-notes/safari-26_6-release-notes
- Safari 27 release notes (dated 2026‑09‑14) — https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes
- Safari 26.5 release notes — https://developer.apple.com/documentation/safari-release-notes/safari-26_5-release-notes
- News from WWDC26: WebKit in Safari 27 beta — https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/
- WebKit Features in Safari 26.0 ("every site can be a web app"; SVG icons; zero installability requirements) — https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- WebKit Features for Safari 26.2 (Navigation API; `document.activeViewTransition`; declarative-push `mutable` parsing fix) — https://webkit.org/blog/17640/webkit-features-for-safari-26-2/
- WebKit Features for Safari 26.5 — https://webkit.org/blog/17938/webkit-features-for-safari-26-5/
- Web Push for Web Apps on iOS and iPadOS (16.4; Home Screen requirement; user-gesture requirement; Badging) — https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Meet Web Push (`userVisibleOnly`; "not an invitation for silent background runtime") — https://webkit.org/blog/12945/meet-web-push/
- Meet Declarative Web Push — https://webkit.org/blog/16535/meet-declarative-web-push/
- Declarative Web Push explainer (mutable vs immutable; no penalty for a SW that doesn't display) — https://github.com/WebKit/explainers/blob/main/DeclarativeWebPush/README.md
- Badging for Home Screen Web Apps — https://webkit.org/blog/14112/badging-for-home-screen-web-apps/
- WebKit Features in Safari 17.2 (cookies copied on add-to-Home-Screen; "no other website data is shared") — https://webkit.org/blog/14787/webkit-features-in-safari-17-2/
- WebKit Features in Safari 17.0 (same statement for macOS Dock web apps) — https://webkit.org/blog/14445/webkit-features-in-safari-17-0/
- WebKit Features in Safari 18.4 (Wake Lock now works in Home Screen web apps) — https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- Updates to Storage Policy (2023‑08‑10; 60%/15% origin quota; eviction; `persist()` heuristics; standalone = same quota) — https://webkit.org/blog/14403/updates-to-storage-policy/
- Tracking Prevention (7-day script-writable storage cap; Home-Screen first-party exemption) — https://webkit.org/tracking-prevention/
- Full Third-Party Cookie Blocking and More — https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- Sending web push notifications in web apps and browsers (4 KB limit; gesture requirement; silent-push revocation; `*.push.apple.com` + SNI) — https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- Configuring Web Applications (legacy `apple-*` meta tags) — https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
- Turn a website into an app in Safari on iPhone ("Open as Web App") — https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios
- Safari 26.0 release notes ("Added support for any website to become a web app on iOS or iPadOS. (113034903)"; SVG icons; `data:` URL icons) — https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes
- Safari 26.2 release notes (view-transition `position: fixed`/`sticky` clipping fix 154886047; service-worker download fix 154501503; declarative-push `mutable` parsing fix) — https://developer.apple.com/documentation/safari-release-notes/safari-26_2-release-notes
- Safari 26.4 release notes (threaded scroll-driven animations 168027635; `@starting-style` fix 163928932) — https://developer.apple.com/documentation/safari-release-notes/safari-26_4-release-notes
- Safari 18.4 release notes (Home Screen Web Apps → "Fixed Wake Lock API for Home Screen Web Apps. (108573133)") — https://developer.apple.com/documentation/safari-release-notes/safari-18_4-release-notes
- Safari 18.2 release notes ("Added support for `@page` margin descriptors. (118773100)") — https://developer.apple.com/documentation/safari-release-notes/safari-18_2-release-notes
- WebKit Features in Safari 18.0 (view transitions L1; haptic feedback for `<input type=checkbox switch>`) — https://webkit.org/blog/15865/webkit-features-in-safari-18-0/
- WebKit Features in Safari 18.2 (cross-document view transitions) — https://webkit.org/blog/16301/webkit-features-in-safari-18-2/
- WebKit — An HTML Switch Control — https://webkit.org/blog/15054/an-html-switch-control/
- WebKit — Designing Websites for iPhone X (`viewport-fit=cover`, `env()`, `max()`) — https://webkit.org/blog/7929/designing-websites-for-iphone-x/
- WWDC23 — What's new in web apps (session 10120, `scope` and `id` behaviour) — https://developer.apple.com/videos/play/wwdc2023/10120/
- Apple Support — Set up multiple calendars on iPhone ("You can also subscribe to an iCalendar (.ics) calendar by tapping a link to it.") — https://support.apple.com/guide/iphone/use-multiple-calendars-iph3d1110d4/ios
- WebKit Feature Status page (retired; redirects to MDN/caniuse) — https://webkit.org/status/
- WebKit bug 181849 — "'Add to homescreen' apps don't share storage with Safari" ("isolated entities without shared state") — https://bugs.webkit.org/show_bug.cgi?id=181849
- WebKit bug 264218 — `display-mode: standalone` is false / `fullscreen` true in installed iOS web apps — https://webkit.org/b/264218
- WebKit bug 254545 — Wake Lock in Home Screen web apps (comment 65: "now works … on iOS and iPadOS 18.4") — https://bugs.webkit.org/show_bug.cgi?id=254545
- WebKit bug 281848 — Shape Detection API doesn't work on iOS — https://bugs.webkit.org/show_bug.cgi?id=281848
- WebKit bug 185448 — getUserMedia not working in standalone Home Screen apps (fixed iOS 14.3) — https://bugs.webkit.org/show_bug.cgi?id=185448
- WebKit bug 175497 — `prefers-reduced-transparency` not implemented (status NEW since 2017) — https://bugs.webkit.org/show_bug.cgi?id=175497
- WebKit bug 167341 — `<a download>` on iOS (iOS 13) — https://bugs.webkit.org/show_bug.cgi?id=167341
- WebKit bug 190351 — blob URL download regressions / `target="_blank"` workaround — https://bugs.webkit.org/show_bug.cgi?id=190351
- WebKit bug 294559 — `break-before`/`break-after: avoid` recognised but no effect — https://webkit.org/b/294559
- WebKit bug 176454 — `overscroll-behavior` (fixed, default-on 15.1) — https://bugs.webkit.org/show_bug.cgi?id=176454
- WebKit bug 98538 — `overflow: hidden` + `border-radius` clipping with transformed children — https://bugs.webkit.org/show_bug.cgi?id=98538
- WebKit bug 197779 — share after fetch — https://bugs.webkit.org/show_bug.cgi?id=197779
- WebKit standards-positions #14 (Background Sync, no position) — https://github.com/WebKit/standards-positions/issues/14
- WebKit standards-positions #149 (Background Fetch, no position) — https://github.com/WebKit/standards-positions/issues/149
- WebKit standards-positions #267 (Vibration API, **position: oppose**) — https://github.com/WebKit/standards-positions/issues/267
- WebKit standards-positions #11 (Web Share Target, position: neutral, closed) — https://github.com/WebKit/standards-positions/issues/11
- WebKit standards-positions #174 (Shape Detection, position: support — still unshipped) — https://github.com/WebKit/standards-positions/issues/174
- WebKit standards-positions summary — https://raw.githubusercontent.com/WebKit/standards-positions/main/summary.json
- W3C Web Share API (transient-activation requirement) — https://www.w3.org/TR/web-share/
- CSSWG drafts #11019 — `safe-area-max-inset-*` ("Maximum safe area inset values to allow sliding bottom bar") — https://github.com/w3c/csswg-drafts/issues/11019
- webstatus.dev (W3C WebDX) baseline data — https://api.webstatus.dev/v1/features
- web.dev — Learn PWA: Enhancements (iOS does not generate splash screens) — https://web.dev/learn/pwa/enhancements
- MDN — `env()` (complete env-variable inventory: no `safe-area-max-inset-*`, no `keyboard-inset-*`, no Dynamic Island var in Safari) — https://developer.mozilla.org/en-US/docs/Web/CSS/env

**Compat data**
- caniuse dataset (`ios_saf` latest = 26.6) — https://raw.githubusercontent.com/Fyrd/caniuse/main/data.json
- caniuse `push-api` (note #7 "Requires website to first be added to the Home Screen") — https://caniuse.com/push-api
- caniuse `stream` (notes #3/#4, standalone-PWA getUserMedia) — https://caniuse.com/stream
- caniuse `fullscreen` (note #5, iPad only) — https://caniuse.com/fullscreen
- caniuse `vibration`, `background-sync`, `wake-lock`, `web-share`, `view-transitions`, `css-anchor-positioning`, `css-env-function`, `viewport-unit-variants`, `dialog`, `indexeddb`, `webauthn`, `geolocation`, `download`
- MDN browser-compat-data v8.1.1 (`manifests.webapp.*`, `api.Navigator.*`, `api.Notification.*`, `css.at-rules.page`, `api.VisualViewport`, `html.elements.input.capture`) — https://registry.npmjs.org/@mdn/browser-compat-data/-/browser-compat-data-8.1.1.tgz
- MDN Web Share API / Navigator.share — https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share
- MDN Badging API — https://developer.mozilla.org/en-US/docs/Web/API/Badging_API
- MDN Web Periodic Background Synchronization API — https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Synchronization_API
- MDN `display-mode` — https://developer.mozilla.org/docs/Web/CSS/@media/display-mode
- web.dev — PWA Detection (`navigator.standalone`) — https://web.dev/learn/pwa/detection
- web.dev — Serving cached audio and video (Range/206) — https://web.dev/articles/sw-range-requests
- Chrome for Developers — Notification Triggers API (never shipped beyond origin trial) — https://developer.chrome.com/docs/web-platform/notification-triggers

**ATProto / auth**
- AT Protocol OAuth spec (PAR, PKCE, DPoP mandatory; web vs native `redirect_uri` rules) — https://atproto.com/specs/oauth
- `@atproto/oauth-client-browser` README (sessions in IndexedDB; "when a backend server is available, it is recommended to use `@atproto/oauth-client-node`") — https://raw.githubusercontent.com/bluesky-social/atproto/main/packages/oauth/oauth-client-browser/README.md
- Bluesky OAuth client implementation guide — https://docs.bsky.app/docs/advanced-guides/oauth-client
- passkeys.dev — iOS & iPadOS — https://passkeys.dev/docs/reference/ios/

**EU DMA**
- Apple — Changes for apps in the European Union — https://developer.apple.com/support/dma-and-apps-in-the-eu/
- Apple Newsroom — Changes to iOS, Safari, and the App Store in the EU (Jan 2024) — https://www.apple.com/newsroom/2024/01/apple-announces-changes-to-ios-safari-and-the-app-store-in-the-european-union/
- Open Web Advocacy — Apple's Browser Engine Ban Persists, Even Under the DMA (2025‑07‑14) — https://open-web-advocacy.org/blog/apples-browser-engine-ban-persists-even-under-the-dma/
- Apple DMA Compliance Report, non-confidential summary, 2026‑03‑07 — https://www.apple.com/legal/dma/NCS-March-2026.pdf (not read — exceeds fetch size limit)
- European Commission — DMA specification proceedings on Apple interoperability — https://digital-markets-act.ec.europa.eu/commission-starts-first-proceedings-specify-apples-interoperability-obligations-under-digital-2024-09-19_en

**Community / secondary (clearly flagged as such in the text)**
- Cleffy PR #37 — iOS Home Screen session loss + cookie restore fix, merged 2026‑09‑11 — https://github.com/maxharris1/Cleffy/pull/37
- Progressier — iOS push subscriptions terminated after 3 silent pushes (2023‑06‑30) — https://dev.to/progressier/how-to-fix-ios-push-subscriptions-being-terminated-after-3-notifications-39a7
- 1ar.io — Safari 26 Liquid Glass: toolbar tinting, white bars, viewport bugs (2026‑05‑13) — https://1ar.io/updates/safari-26-liquid-glass-web/
- dev.to — PWA in iPadOS 26 (safe-area insets in windowed mode) (2025‑09‑19) — https://dev.to/reinhart1010/pwa-in-ipados-26-is-a-joke-38g1
- MacRumors — iOS 26: Add Web App or Bookmark to Home Screen (Share behind `⋯` in Compact) — https://www.macrumors.com/how-to/save-safari-bookmark-web-app-iphone-home-screen/
- MacStories Weekly 517 — "Safari for iOS 27: Where's the Share Button?" (2026‑06‑14, paywalled; confirms another relocation) — https://www.macstories.net/club/macstories-weekly-issue-517/safari-for-ios-27-wheres-the-share-button/
- plugwith.me — What actually escapes Instagram's in-app browser in 2026 — https://plugwith.me/blog/what-escapes-instagram-in-app-browser-in-2026/
- MDN BCD issue #14648 — `api.ContactsManager` iOS data is flag-gated — https://github.com/mdn/browser-compat-data/issues/14648
- ios-haptics library + compatibility notes (claims Apple closed every programmatic switch re-tick path in iOS 26.5) — https://haptics.kushagragolash.dev/ and https://github.com/tijnjh/ios-haptics
- Apple Developer Forums (secondary, user-reported): geolocation in standalone 694999 / 740270; `.ics` preview behaviour 105849 / 726941; keyboard + `position: fixed` 705793 / 800125; safe-area insets in tabs 716552 / 699415
- MagicBell — PWA iOS limitations 2026 (source of the unsupported "EU PWAs are degraded" claim) — https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide
- Cross-document view transitions limits (same-origin, ~4 s render timeout) — https://developer.chrome.com/docs/web-platform/view-transitions/cross-document

---

## Confidence / not verified

**High confidence (primary source, version-pinned)**
Safari 26.6 is the shipping iOS version and 27 lands 2026‑09‑14; Safari 27 has no Web Apps / manifest / push / badging entries at all; iOS 26 removed installability requirements; push is Home-Screen-only with a 4 KB payload, user-gesture requirement, and silent-push revocation; Declarative Web Push semantics incl. mutable-with-no-penalty; Badging from 16.4 Home-Screen-only and `setAppBadge(0)` clears; Background Sync / Periodic Background Sync / Background Fetch all absent (WebKit: no position on two, no entry for the third); storage quota = 60% of disk per origin with no prompt and no standalone penalty; ITP 7-day cap with a Home-Screen first-party exemption; cookies-only one-time copy at install; the full manifest support matrix (`display_override`, `share_target`, `file_handlers`, `launch_handler`, `background_color`, `orientation`, `shortcuts`, `description`, `protocol_handlers`, `scope_extensions` all unsupported on iOS); **`display-mode: standalone` is false in an installed iOS web app (WebKit #264218)**; iOS generates no splash from the manifest; `navigator.vibrate` false with WebKit position **oppose**; `prefers-reduced-transparency` unsupported (WebKit #175497 open since 2017); `screen.orientation.lock()` unsupported; element fullscreen iPad-only; `@page` + margin descriptors from 18.2 and `size: landscape/portrait` keywords unsupported; `break-before/after: avoid` no-ops (WebKit #294559); Safari doesn't print `<body>` backgrounds; Wake Lock fixed for Home Screen apps in 18.4; `<a download>` from iOS 13 with the `target="_self"` + `Content-Disposition` rules; `safe-area-max-inset-*` and `env(keyboard-inset-*)` and `interactive-widget` and `CloseWatcher` all absent from Safari; BarcodeDetector and Contact Picker both flag-gated off by default; Safari 26+ freezes the OS version in the UA; ATProto OAuth requires PAR+PKCE+DPoP and Bluesky recommends the node/BFF client.

**Medium confidence (credible secondary, or inference clearly labelled)**
- **Safari 26 ignores `theme-color`** for chrome tinting and samples CSS instead — one detailed teardown (1ar.io, 2026‑05‑13), not Apple-documented. The mitigation (explicit `html`/`body` background, glass on a child element) is harmless either way, so ship it.
- **Out-of-scope → in-app overlay → redirect back into the standalone window.** Well-reported behaviour and consistent with `scope` semantics, but **I found no Apple or WebKit statement describing it**, and no 2026-dated confirmation. The BFF design makes us insensitive to it; verify on device before trusting it.
- **Cookie copy on iOS specifically.** WebKit documents it for macOS Dock web apps (17.0) and as general web-app behaviour (17.2); the Cleffy fix (2026‑09‑11) is independent field confirmation on iOS. Not an Apple statement *about iOS*.
- **Push subscriptions silently expiring after weeks of inactivity** — consistent developer-forum reporting, no Apple documentation.
- **The "3 silent pushes" threshold** — a 2023 community figure. Apple documents only *that* revocation happens, never a count. Treat the count as folklore; treat the rule as real.
- **iOS download behaviour in standalone mode** (`<a download>`, `.ics`, webcal) — behavioural, version-sensitive, not specified anywhere. The `.ics`-vs-`webcal` recommendation is reasoned, not measured.
- **Passkey portability across the Safari/installed boundary** — inference from passkeys being iCloud-Keychain-resident and keyed by RP ID, not from a statement about PWAs.
- **iOS 27's Add-to-Home-Screen location.** Confirmed it moved again (Firtman, 2026‑06‑08; MacStories 2026‑06‑14) but the new tap path is behind a paywall / not documented. This is exactly why the copy names the menu and the outcome rather than an icon.

**Source conflicts to be aware of**
- **`display: fullscreen`** — MDN BCD records it unsupported on iOS; WebKit's own push blog says a manifest with `display` set to `standalone` *or `fullscreen`* makes the site a web app. We use `standalone`, so it doesn't bite us.
- **`break-*` vs `page-break-*`** — caniuse says Safari supports only the `page-break-*` aliases; BCD says `break-*` landed in Safari 10 with `avoid` inert. Both agree `page-break-inside: avoid` works, which is what we use.
- **`display-mode`** — BCD records iOS 12.2 support; webstatus.dev reports `safari_ios: None`. Combined with WebKit #264218 this is a feature to detect, never to trust.
- **Wake Lock** — caniuse says iOS 16.4 plain-supported; BCD records 16.4 as partial ("does not work in standalone Home Screen Web Apps") until 18.4. BCD plus Apple's 18.4 release note is the accurate reading.
- **Safari 27's HEIC change** — the release-note wording ("Fixed an issue where HEIC images were incorrectly converted to JPEG when uploaded via… file input") reads as *stopping* a conversion we previously relied on, but Apple doesn't say which `accept` configurations are affected. Treat as uncertain and test.

**Not verified — test on device before shipping**
1. Whether the **ITP 7-day exemption** applies to sites auto-installed under iOS 26's "every site is a web app" (no WebKit statement either way). If it doesn't, a user who installs without our manifest could lose cached data.
2. Whether MDN BCD's claim that the `Notification` constructor needs a **non-default manifest `display` value** still holds on iOS 26+, now that installability has no requirements.
3. What `navigator.storage.persist()` actually returns in a tab vs. an installed app on iOS 26.
4. Whether `setAppBadge` does anything when notification permission is **denied** (spec defines no permission; Apple routes the control through Notifications settings).
5. Whether a notification `icon` renders at all on iOS (BCD says `image` and `badge` are false; `icon` is undocumented for iOS).
6. Any **time budget** for work in the `push` handler, and any numeric silent-push strike count — no primary source exists.
7. iOS-specific **service-worker termination** timings (the old backgrounding-freeze bug 211018 is fixed; no documented budget replaces it). Don't design around any specific number.
8. `display-mode: standalone` reporting for a **manifest-less** iOS 26 auto-installed web app — this is why the detection code checks `navigator.standalone` **first**.
9. `navigator.share({files})` and `canShare()` iOS versions — BCD **mirrors** these from macOS Safari 14 rather than stating them for iOS.
10. **Cross-document view transitions inside `display: standalone`** — no source either way. Load-bearing if we go MPA.
11. **Whether standalone mode alone suppresses pull-to-refresh** — widely assumed (no Safari chrome to host it), unsourced. The app-shell scroll lock makes us insensitive either way.
12. **`.ics` and `webcal://` behaviour inside a standalone web app** — the weakest item in the checklist. Apple documents link-tapping for *subscriptions* only; single-`VEVENT` preview behaviour is forum-level; `webcal://` link handling in Safari has no Apple/WebKit confirmation at all.
13. **Geolocation permission model in a Home Screen web app** — second weakest. Separate permission store, re-prompting, and persistence across relaunch are all unsourced; forum reports say the prompt can surface in Safari rather than the web app.
14. `<a download>`'s destination inside a standalone app (Files vs Quick Look vs the Downloads manager).
15. `apple-mobile-web-app-title` vs manifest `short_name`/`name` precedence — undocumented.
16. Whether `permissions.query({name:'camera'})` is an accepted descriptor on Safari (wrap in try/catch), and whether a camera grant persists across launches in standalone.
17. Whether the Shape Detection and Contact Picker feature flags are still off by default in **iOS 27** specifically.
18. `backdrop-filter` on `position: fixed` and inside scrollers, and all iOS blur-performance budgets — practitioner heuristics only, no WebKit guidance exists.
19. Print-to-PDF from inside a standalone web app — `window.print()` is the only entry point (no Safari share sheet); untested.
