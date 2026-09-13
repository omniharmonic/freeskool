# Class artwork design fixtures

Four AI-generated images made with the built-in `image_gen` tool, plus a deliberately compressed 240px derivative. These are fictional design-test assets, not photographs of real community events. The complete generation prompts are in [prompts.json](prompts.json); original PNGs and optimized WebPs are stored here, outside the production web bundle.

| Asset | Purpose |
| --- | --- |
| mushroom-flyer | 2:3 portrait poster with text close to the edges |
| repair-photo | 3:2 documentary-style photo with people and detailed tools |
| botanical-square | Square illustration with saturated color and tactile texture |
| rough-phone-photo | Wide, noisy, softly focused indoor snapshot |
| rough-phone-photo-240px | Actual 240px WebP at quality 22 to test small-source framing |
| No cover | Typographic fallback for a sixth demo class |

The local test calendar contains all six classes together. Each carries a `design-demo` tag and an explicit fictional-event description. Direct links are in [events.json](events.json).

To populate another **local** development school, load its existing AppView environment and run from the repository root:

```sh
ARTWORK_HOST_DID=<existing-local-test-host-did> pnpm --filter @freeschool/appview exec tsx scripts/seed-artwork.ts
```

The seed uses normal event creation and image normalization, records fixture IDs for repeat runs, and refuses production or non-local database/PDS/AppView services. Set `ARTWORK_REFRESH_DATES=1` to move these six existing fixtures to tomorrow for another review. Use a local custodial host with valid credentials; do not use a real community member.

The frontend preserves complete artwork, samples a subtle mat color, and limits enlargement of small sources. This improves composition, not the source image's missing detail. The enlarged viewer offers a separate natural-resolution zoom for reading posters.


Set `ARTWORK_REFRESH_DETAILS=1` to refresh the explicit public overview, audience, access and materials examples from `details.json`. Existing private descriptions are never automatically made public.

For the connected knowledge/profile preview, run `ARTWORK_HOST_DID=<existing-local-test-host-did> pnpm --filter @freeschool/appview exec tsx scripts/seed-knowledge.ts` with the same local environment. This explicitly opts the fictional test host into a public profile, sets the generated botanical avatar, publishes a public bicycle skill claim, links the bicycle class to that skill, and adds three CC0 demo notes. It is idempotent and refuses production services. Do not use it on a real member account.
