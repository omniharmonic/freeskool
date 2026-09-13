---
author: "Benjamin Life (@omniharmonic)"
date: "2026-09-12"
status: "draft"
brief: "r5"
type: "research"
title: "R5 \u2014 Skill taxonomy seed"
projects: ["local-alternatives"]
visibility: "public"
parachute_path: "vault/projects/local-alternatives/free-school/research/r5_skills-seed"
parachute_id: "2026-09-12-20-00-23-232252"
tags: ["free-school", "local-alternatives", "research", "skills", "taxonomy"]
---

# R5 — Skill taxonomy seed

*Benjamin Life (@omniharmonic) · 2026-09-12 · status: draft · brief R5*


## TL;DR

- **525 nodes** shipped in `skills-seed.jsonl` as `freeschool.draft.skill` records: **8 domains → 52 areas → 465 leaf skills**, covering trades, food, land, repair, care, arts, organizing and tech/digital.
- **159 leaf skills (34%) carry a verified ESCO URI.** Every one is either an exact label match (53) or a mapping I read and approved by hand against ESCO's own candidates (106). Nothing was accepted on a similarity score alone — an early fuzzy-match pass happily mapped "apply oxy-fuel cutting techniques" to ESCO's *"apply hair cutting techniques"*, which is why the pipeline ends in a human review step.
- **417 nodes (79%) carry a Wikidata QID**; 88% of leaf skills do. **87 QIDs were verified by hand** against `wbgetentities`: a 20-node random sample (seed 20260912, all 20 correct), 37 hand-picked sense corrections, and a targeted sweep of the 30 most ambiguous remaining picks — none of which turned out to be a wrong sense.
- **306 nodes are `status: proposed`** — community-extension nodes ESCO has no equivalent for. This is derived from the API, not asserted: I pre-flagged 257 leaves as "ESCO probably lacks this", and the API disagreed with me **both ways** — it *did* have 34 of them, and it *lacked* 83 I expected it to have.
- **ESCO returns literally zero results** for `permaculture`, `beekeeping`, `squatting`, `doula`, `naloxone`, `tincture`, `alleycat`, `copwatch`, `unschooling`, `flintknapping`, `greywater`, `biochar`. The gap is not cosmetic: ESCO is a labour-market classification, so the free-school curriculum's whole care/organizing/subsistence half is missing by design.
- **The hierarchy is Free School's own**, deliberately. ESCO's top level is `A` attitudes / `S` skills / `K` knowledge / `L` language, and below that it is cut by industrial sector — bike repair lands under "working with machinery and specialised equipment", honey harvesting under the same. Using ESCO's broader relations as the live tree would scatter every free-school area. Instead **each ESCO-matched node records ESCO's real `broaderHierarchyConcept` chain, walked to the root**, in its provenance block — so the alignment is inspectable and machine-checkable without being load-bearing.
- **The gap list was checked against real catalogs, not just my priors.** ~122 verbatim class titles from four Free Skool Santa Cruz sessions, plus verified archived catalogs from EXCO Twin Cities, the Montreal Anarchist Bookfair (2002–2017), Bloomington Free Skool and Firestorm Asheville. That confirmed squatting, street medicine, earth ovens, know-your-rights, transformative justice, prison books, radical mental health, harm reduction and deschooling as genuinely taught. It also **failed to confirm nine of my favourites** — hide tanning, flintknapping, compost toilets, cob/straw-bale by name, death doula, DIY gynaecology, dumpster diving and alley cat races appeared in no catalog I read. They stay in as `proposed`; prune them first.
- **A third of what free schools actually run are not skills at all** — reading groups, affinity socials, open shop hours, rituals, free markets. Events need a format axis and should tolerate zero skill references, and a separate `topic` vocabulary (Wikidata QIDs alone would carry it) is probably needed for the political-education seam.
- **One correctness caveat worth reading before you use the QIDs:** a Wikidata QID here is a *topic anchor*, not a claim of identity. "Repair a flat tire" anchors to Q771452 *bicycle tire*. Only 15 of 417 have a label identical to ours. Generated descriptions say which they are, verbatim.

---

## Method

### APIs, verified live on 2026-09-12

**ESCO** — `https://ec.europa.eu/esco/api`, current release **ESCO v1.2.1 (last update 10/12/2025), API release v5.7.0**.

| Endpoint | Use |
|---|---|
| `GET /search?text=<q>&type=skill&language=en&limit=20&full=false&viewObsolete=false` | candidate retrieval; returns `total`, `preferredLabel` (all EU languages), `hasSkillType`, `hasReuseLevel`, `broaderHierarchyConcept` |
| `GET /resource/skill?uri=<uri>&language=en` | resolve a concept or skill group; gives `_links.broaderConcept` / `narrowerSkill` |
| `GET /resource/taxonomy?uri=http://data.europa.eu/esco/concept-scheme/skills&language=en` | scheme root — `hasTopConcept` = `skill/A` attitudes and values, `skill/S` skills, `skill/K` knowledge, `skill/L` language skills and knowledge |

Two notes for whoever maintains this next. `type=concept-scheme` is **not** a valid `/resource` type (returns `BadInputException`), and there is no `/version` endpoint (404) — the version is only on the portal. And `/search` is loose full-text: `text=consensus decision making` returns `total: 1371` led by "decision support systems". Treat `total` as a recall signal, never as evidence of a match.

**Wikidata** — two passes, because `wbsearchentities` relevance ranking is not trustworthy enough to mint an external id from:

1. **SPARQL exact-label pass** (`https://query.wikidata.org/sparql`, batches of 40 labels): `VALUES ?lab { "…"@en … }` then `{ ?item rdfs:label ?lab } UNION { ?item skos:altLabel ?lab }`, pulling `schema:description` in the same hop. **374 of 516 labels** resolved this way.
2. **`wbsearchentities` fallback** for the remaining 142 (`action=wbsearchentities&language=en&limit=7&type=item`), which found 31 more.
3. **`wbgetentities`** (`props=labels|descriptions|claims`) for the verification pass.

Wikidata rate-limits hard at roughly 10 unthrottled requests; the scripts back off and sleep.

### Pipeline (all scripts in `r5_skills/`, each independently rerunnable)

```
taxonomy.py              hand-authored domain → area → skill skeleton in a compact DSL
prune.py                 one-shot prune that took the first draft from 685 → 500 nodes
                         (25 catalog-grounded nodes + 1 area were added back later, → 525)
nodes.py                 parse the DSL, derive slugs, assert slug uniqueness
fetch_esco.py            cache ESCO /search candidates — 3 query shapes per node
esco_match.py            strict token-subset matcher (see below); ≥0.95 auto-accepts
make_review.py           emit review.txt — the whole sub-0.95 band, for human reading
esco_decisions.tsv       ← my hand-review verdicts (slug → exact ESCO preferredLabel)
resolve_decisions.py     resolve those labels to real ESCO URIs via the live API
fetch_wikidata.py        SPARQL exact-label pass, then wbsearchentities fallback
wd_pick.py               sense disambiguation from the English description
wikidata_overrides.tsv   ← my hand corrections to the pick
verify_wikidata.py       wbgetentities check of overrides + a seeded 20-node sample
build_seed.py            emit skills-seed.jsonl, provenance.json, stats.json
esco_gap_probes.json     direct ESCO probes for the 41 gap claims in this report
```

### Why matching needed a human in the loop

Three query shapes go to ESCO per node — my guess at the ESCO label, our own label, and the two longest bare keyword nouns. The bare nouns matter: ESCO only surfaces a concept when the wording is close, so `"brake"` is what actually retrieves `repair vehicle brakes`. Candidates are pooled across all three queries and then scored **against the node's own names**, not against the keyword that surfaced them.

The scorer (`esco_match.py`) accepts only on a token-**subset** relation, which is what "same skill, different wording or one level of generality" actually looks like: identical normalised strings (1.00), identical token multiset (0.95), every content token of ours inside ESCO's label (0.88), every content token of ESCO's inside ours (0.85), or Jaccard ≥ 0.6 (0.75). A plain `difflib` ratio, which I tried first, produced *"sew by hand" → "sell second-hand merchandise"* and *"analyse soil samples" → "analyse blood samples"*. Even the subset rule mis-fires (*"build and fire a bread oven" → "build a fire"*), so:

- **≥ 0.95 auto-accepts** — 53 nodes in the final build. (`make_review.py` cleared 54 under a marginally looser shortlist score, so 387 rather than 388 went to review; the one-node discrepancy is that node getting re-tested and rejected by the final matcher.)
- **everything else went into `review.txt`** — 387 nodes with their top candidates — which I read in full, plus ~40 extra targeted probes (`poultry farming`, `beekeeping`, `sewing`, `meat cutting`, `food preservation`, `install roof covering`, …) to catch false negatives. Those probes are what found `roofing techniques`, `process harvested honey`, `use manual sewing techniques`, `apply preservation treatments` and `attend to children's basic physical needs`, none of which the automatic pass had surfaced. Verdicts are in `esco_decisions.tsv`; **106 accepted, 281 rejected**, and all 106 resolved to real URIs.

`status` is then *derived*: a leaf with a verified ESCO concept is `canonical`, a leaf without one is `proposed`.

### Descriptions

400 descriptions reuse Wikidata's English description, which is **CC0** and therefore shippable verbatim. Where the Wikidata item's label differs from ours — the common case, 402 of 417 — the description is phrased so the reader can see it: *"Repair a flat tire — linked concept "bicycle tire": a tire that fits on the wheel of a bicycle. Taught under bicycle mechanics."* 60 are authored (all domains and areas), 16 are ESCO-aligned templates, and **49 are explicit placeholders** reading "description to be written by the community that proposes it" — those are honest TODOs, not content.

---

## Taxonomy overview

525 nodes. Columns: leaf skills in the area, how many carry an ESCO URI, how many carry a QID, how many are `status: proposed`.

### Practical trades (`practical-trades`) — 9 areas, 92 skills, 55 ESCO (54%)

| Area | id | skills | esco | wikidata | proposed |
|---|---|--:|--:|--:|--:|
| Construction and building | `construction-building` | 14 | 7 | 11 | 7 |
| Plumbing and water systems | `plumbing-water` | 11 | 7 | 9 | 4 |
| Electrical and off-grid power | `electrical` | 11 | 7 | 10 | 4 |
| Metalwork and welding | `metalwork-welding` | 9 | 8 | 9 | 1 |
| Woodworking and carpentry | `woodworking-carpentry` | 10 | 7 | 10 | 3 |
| Auto and vehicle mechanics | `vehicle-mechanics` | 8 | 5 | 8 | 3 |
| Bicycle mechanics | `bicycle-mechanics` | 10 | 3 | 10 | 7 |
| Masonry, plaster and finishes | `masonry-finishes` | 12 | 6 | 9 | 6 |
| Tools, shop practice and safety | `tools-safety` | 7 | 5 | 7 | 2 |

### Food (`food`) — 6 areas, 53 skills, 12 ESCO (20%)

| Area | id | skills | esco | wikidata | proposed |
|---|---|--:|--:|--:|--:|
| Cooking | `cooking` | 12 | 3 | 11 | 9 |
| Fermentation | `fermentation` | 10 | 1 | 9 | 9 |
| Preserving and storing | `preserving` | 8 | 2 | 6 | 6 |
| Baking and milling | `baking` | 4 | 2 | 4 | 2 |
| Butchery and animal processing | `butchery` | 10 | 3 | 7 | 7 |
| Foraging and wild food | `foraging` | 9 | 1 | 7 | 8 |

### Land and growing (`land`) — 6 areas, 53 skills, 17 ESCO (28%)

| Area | id | skills | esco | wikidata | proposed |
|---|---|--:|--:|--:|--:|
| Gardening and horticulture | `gardening` | 12 | 6 | 12 | 6 |
| Permaculture and agroecology | `permaculture` | 10 | 2 | 9 | 8 |
| Soil and composting | `soil-compost` | 8 | 1 | 6 | 7 |
| Animals and husbandry | `animals` | 9 | 7 | 9 | 2 |
| Beekeeping and pollinators | `beekeeping` | 7 | 1 | 6 | 6 |
| Seeds and plant stewardship | `seeds` | 7 | 0 | 7 | 7 |

### Repair and reuse (`repair`) — 5 areas, 38 skills, 11 ESCO (25%)

| Area | id | skills | esco | wikidata | proposed |
|---|---|--:|--:|--:|--:|
| Electronics repair | `electronics-repair` | 7 | 4 | 7 | 3 |
| Appliance and machine repair | `appliance-repair` | 5 | 1 | 5 | 4 |
| Textiles, sewing and mending | `textiles` | 14 | 4 | 10 | 10 |
| Leather and shoe repair | `leather-shoes` | 4 | 2 | 4 | 2 |
| Reuse, salvage and waste | `reuse` | 8 | 0 | 7 | 8 |

### Care and health (`care`) — 8 areas, 66 skills, 20 ESCO (27%)

| Area | id | skills | esco | wikidata | proposed |
|---|---|--:|--:|--:|--:|
| First aid and emergency care | `first-aid` | 11 | 4 | 10 | 7 |
| Herbalism and plant medicine | `herbalism` | 9 | 1 | 9 | 8 |
| Childcare and child-centred work | `childcare` | 5 | 4 | 3 | 1 |
| Pedagogy, literacy and language | `pedagogy-and-literacy` | 7 | 0 | 7 | 7 |
| Elder care and disability support | `elder-disability` | 5 | 3 | 4 | 2 |
| Mental health and peer support | `mental-health` | 10 | 2 | 8 | 8 |
| Conflict, consent and accountability | `conflict` | 10 | 4 | 10 | 6 |
| Bodies, sex and reproductive care | `bodies` | 9 | 2 | 8 | 7 |

### Arts and media making (`arts`) — 6 areas, 59 skills, 20 ESCO (30%)

| Area | id | skills | esco | wikidata | proposed |
|---|---|--:|--:|--:|--:|
| Printmaking and screen printing | `printmaking` | 8 | 1 | 8 | 7 |
| Zines, books and publishing | `publishing` | 10 | 2 | 10 | 8 |
| Music and sound | `music-sound` | 8 | 4 | 8 | 4 |
| Photography, film and image | `image` | 8 | 5 | 7 | 3 |
| Craft and material arts | `craft` | 15 | 4 | 14 | 11 |
| Performance and storytelling | `performance` | 10 | 4 | 10 | 6 |

### Organizing and governance (`organizing`) — 7 areas, 66 skills, 11 ESCO (15%)

| Area | id | skills | esco | wikidata | proposed |
|---|---|--:|--:|--:|--:|
| Facilitation and meetings | `facilitation` | 10 | 1 | 8 | 9 |
| Mutual aid and solidarity | `mutual-aid` | 12 | 2 | 9 | 10 |
| Campaigns and direct action | `campaigns` | 15 | 2 | 12 | 13 |
| Legal and rights work | `legal` | 7 | 1 | 5 | 6 |
| Money, resources and fundraising | `resources` | 7 | 2 | 7 | 5 |
| Cooperative governance | `governance` | 8 | 0 | 8 | 8 |
| Media and communications | `media` | 7 | 3 | 7 | 4 |

### Technology and digital autonomy (`tech-digital`) — 5 areas, 38 skills, 13 ESCO (30%)

| Area | id | skills | esco | wikidata | proposed |
|---|---|--:|--:|--:|--:|
| Computer and device basics | `computer-basics` | 5 | 2 | 5 | 3 |
| Privacy and digital security | `privacy-security` | 10 | 2 | 7 | 8 |
| Radio and off-grid networks | `radio-mesh` | 8 | 3 | 6 | 5 |
| Code, web and making | `making-code` | 7 | 3 | 6 | 4 |
| Preparedness and low-tech resilience | `resilience` | 8 | 3 | 6 | 5 |

**The coverage gradient is the finding.** ESCO covers 54% of the trades and 15% of organizing. The closer a skill is to waged employment, the better ESCO knows it; the closer it is to surviving together outside waged employment, the less it exists. Which is exactly the half a free school is for.

### Where ESCO's own hierarchy put our matched nodes

Recorded per node, not used as the tree. The top-level `S*`/`K*` groups hit:

| ESCO group | code | nodes |
|---|---|--:|
| handling and moving | `S6` | 34 |
| working with machinery and specialised equipment | `S8` | 26 |
| constructing | `S7` | 24 |
| assisting and caring | `S3` | 21 |
| communication, collaboration and creativity | `S1` | 20 |
| engineering, manufacturing and construction | `K/07` | 7 |
| working with computers | `S5` | 7 |
| information skills | `S2` | 5 |
| health and welfare | `K/09` | 3 |
| arts and humanities | `K/02` | 3 |
| other (9 further groups) | | 9 |

Note `S6 handling and moving` as the single largest bucket — ESCO files much of hands-on craft under materials handling. That is a perfectly coherent way to cut the world for labour-market statistics and a useless one for a class schedule.

---

## Sample records

Ten real lines from `skills-seed.jsonl` (ESCO broader chains truncated here with `"…"` for width; the file carries the full chain to the root). `_provenance` is an annotation block, **not** part of the lexicon — strip it, or add it as an optional lexicon field, before publishing records.

```json
{"$type":"freeschool.draft.skill","id":"land","label":"Land and growing","description":"Soil, plants, animals and water at the scale of a garden, a lot or a small farm.","broader":[],"externalIds":{},"status":"canonical","createdAt":"2026-09-12T00:00:00.000Z","_provenance":{"level":"domain","domain":"land","broaderSource":"freeschool-grouping","expectedMissingFromEsco":false,"descriptionSource":"authored"}}
{"$type":"freeschool.draft.skill","id":"beekeeping","label":"Beekeeping and pollinators","description":"Bees, hives and the insects that make the garden work.","broader":["land"],"externalIds":{},"status":"canonical","createdAt":"2026-09-12T00:00:00.000Z","_provenance":{"level":"area","domain":"land","broaderSource":"freeschool-grouping","expectedMissingFromEsco":false,"descriptionSource":"authored"}}
{"$type":"freeschool.draft.skill","id":"keep-bees","label":"Keep bees","description":"Keep bees — linked concept “beekeeping”: care and breeding of honey bees. Taught under beekeeping and pollinators.","broader":["beekeeping"],"externalIds":{"wikidata":"Q176353"},"status":"proposed","createdAt":"2026-09-12T00:00:00.000Z","_provenance":{"level":"skill","domain":"land","broaderSource":"freeschool-grouping","expectedMissingFromEsco":false,"wikidata":{"wdLabel":"beekeeping","wdDescription":"care and breeding of honey bees","method":"sparql-exact-label","handVerified":false,"ambiguity":1,"relation":"topic-anchor"},"descriptionSource":"wikidata-cc0"}}
{"$type":"freeschool.draft.skill","id":"harvest-honey","label":"Harvest honey","description":"Harvest honey — linked concept “honey extraction”: process in beekeeping of removing honey from the honeycomb. Taught under beekeeping and pollinators.","broader":["beekeeping"],"externalIds":{"esco":"http://data.europa.eu/esco/skill/e4a3c9af-8a5d-49cc-95bb-b77e41588746","wikidata":"Q12411235"},"status":"canonical","createdAt":"2026-09-12T00:00:00.000Z","_provenance":{"level":"skill","domain":"land","broaderSource":"freeschool-grouping","expectedMissingFromEsco":false,"esco":{"label":"process harvested honey","method":"hand-reviewed","skillType":["skill"],"reuseLevel":["sector-specific"],"escoBroaderHierarchy":[{"uri":"http://data.europa.eu/esco/skill/S","title":"skills"},{"uri":"http://data.europa.eu/esco/skill/S8","title":"working with machinery and specialised equipment"},"…"]},"wikidata":{"wdLabel":"honey extraction","method":"sparql-exact-label","handVerified":false,"relation":"topic-anchor"},"descriptionSource":"wikidata-cc0"}}
{"$type":"freeschool.draft.skill","id":"mig-welding","label":"MIG welding","description":"MIG welding — linked concept “gas metal arc welding”: welding process in which an electric arc forms between a consumable wire electrode and the workpieces, which heat up, melt and join; a gas feeds through the welding gun, shielding the process from contaminants in air. Taught under metalwork and welding.","broader":["metalwork-welding"],"externalIds":{"esco":"http://data.europa.eu/esco/skill/60ff3eac-7d4d-4e51-87b8-74c3b5d62498","wikidata":"Q1765723"},"status":"canonical","createdAt":"2026-09-12T00:00:00.000Z","_provenance":{"level":"skill","domain":"practical-trades","broaderSource":"freeschool-grouping","expectedMissingFromEsco":false,"esco":{"label":"perform metal active gas welding","method":"hand-reviewed","skillType":["skill"],"reuseLevel":["sector-specific"],"escoBroaderHierarchy":[{"uri":"http://data.europa.eu/esco/skill/S","title":"skills"},{"uri":"http://data.europa.eu/esco/skill/S7","title":"constructing"},"…"]},"wikidata":{"wdLabel":"gas metal arc welding","method":"sparql-exact-label","handVerified":false,"relation":"topic-anchor"},"descriptionSource":"wikidata-cc0"}}
{"$type":"freeschool.draft.skill","id":"repair-a-flat-tire","label":"Repair a flat tire","description":"Repair a flat tire — linked concept “bicycle tire”: a tire that fits on the wheel of a bicycle. Taught under bicycle mechanics.","broader":["bicycle-mechanics"],"externalIds":{"esco":"http://data.europa.eu/esco/skill/fab8e95a-448d-4784-aa50-9ef10e924829","wikidata":"Q771452"},"status":"canonical","createdAt":"2026-09-12T00:00:00.000Z","_provenance":{"level":"skill","domain":"practical-trades","broaderSource":"freeschool-grouping","expectedMissingFromEsco":false,"esco":{"label":"perform repairs on bicycles","method":"hand-reviewed","skillType":["skill"],"reuseLevel":["sector-specific"],"escoBroaderHierarchy":["…"]},"wikidata":{"wdLabel":"bicycle tire","method":"sparql-exact-label","handVerified":true,"relation":"topic-anchor"},"descriptionSource":"wikidata-cc0"}}
{"$type":"freeschool.draft.skill","id":"hide-tanning","label":"Hide tanning","description":"Hide tanning — linked concept “tanning”: chemical treatment of animal hides. Taught under butchery and animal processing.","broader":["butchery"],"externalIds":{"wikidata":"Q211578"},"status":"proposed","createdAt":"2026-09-12T00:00:00.000Z","_provenance":{"level":"skill","domain":"food","broaderSource":"freeschool-grouping","expectedMissingFromEsco":true,"wikidata":{"wdLabel":"tanning","method":"sparql-exact-label","handVerified":false,"relation":"topic-anchor"},"descriptionSource":"wikidata-cc0"}}
{"$type":"freeschool.draft.skill","id":"consensus-decision-making","label":"Consensus decision making","description":"Consensus decision making — linked concept “consensus decision-making”: group decision-making aiming for universal agreement. Taught under facilitation and meetings.","broader":["facilitation"],"externalIds":{"wikidata":"Q188577"},"status":"proposed","createdAt":"2026-09-12T00:00:00.000Z","_provenance":{"level":"skill","domain":"organizing","broaderSource":"freeschool-grouping","expectedMissingFromEsco":true,"wikidata":{"wdLabel":"consensus decision-making","method":"sparql-exact-label","handVerified":false,"relation":"topic-anchor"},"descriptionSource":"wikidata-cc0"}}
{"$type":"freeschool.draft.skill","id":"make-a-zine","label":"Make a zine","description":"Make a zine — linked concept “zine”: collection of self-published work reproduced by photocopying. Taught under zines, books and publishing.","broader":["publishing"],"externalIds":{"wikidata":"Q549638"},"status":"proposed","createdAt":"2026-09-12T00:00:00.000Z","_provenance":{"level":"skill","domain":"arts","broaderSource":"freeschool-grouping","expectedMissingFromEsco":true,"wikidata":{"wdLabel":"zine","method":"sparql-exact-label","handVerified":true,"ambiguity":2,"relation":"topic-anchor"},"descriptionSource":"wikidata-cc0"}}
{"$type":"freeschool.draft.skill","id":"jail-support","label":"Jail support","description":"Jail support: a skill free schools teach under mutual aid and solidarity; no equivalent concept in ESCO, description to be written by the community that proposes it.","broader":["mutual-aid"],"externalIds":{},"status":"proposed","createdAt":"2026-09-12T00:00:00.000Z","_provenance":{"level":"skill","domain":"organizing","broaderSource":"freeschool-grouping","expectedMissingFromEsco":true,"descriptionSource":"placeholder-needs-authoring"}}
```

`jail-support` is the shape of a genuine gap: no ESCO concept, no Wikidata item, `externalIds: {}` — a node that exists only because free schools teach it.

---

## What ESCO lacks + proposed extension nodes

### Direct evidence

I probed ESCO's `/search` with 41 free-school terms and saved the raw answers to `esco_gap_probes.json`. **Twelve return `total: 0` — ESCO has no concept whose label contains the word at all:**

| term | ESCO `total` |
|---|--:|
| `permaculture` | **0** |
| `beekeeping` | **0** |
| `squatting` | **0** |
| `doula` | **0** |
| `naloxone` | **0** |
| `tincture` | **0** |
| `alleycat` | **0** |
| `copwatch` | **0** |
| `unschooling` | **0** |
| `flintknapping` | **0** |
| `greywater` | **0** |
| `biochar` | **0** |

Several more return results that are *only* the industrial or unrelated sense, which is the more interesting failure mode:

| term | `total` | what ESCO actually returns |
|---|--:|---|
| `beehive` | 0 | — (but `honey production` → `process harvested honey`, `handle honeycombs`: ESCO knows honey *processing*, not keeping bees) |
| `childcare` | 0 | — (but `care for children` → `supervise children`, `attend to children's basic physical needs`) |
| `compost` | 1 | `monitor composting` — one industrial monitoring skill, nothing about making compost |
| `herbalism` | 2 | `phytotherapy`, `traditional Chinese medicine` — both knowledge concepts, no making or using |
| `foraging wild food` | 303 | `wild game meat food safety`, `monitor wildlife`, `handle broodstock` — animal feeding and food-safety senses |
| `hide tanning` | 13 | `physico-chemical properties of hides and skins`, `leather chemistry`, `identify defects on raw hides` — tannery QA, not tanning a hide |
| `zine` | 19 | `music literature`, `compile library lists`, `consult with editor` |
| `eviction` | 1 | `inform on renting agreements` |
| `de-escalation` | 22 | `perform escalation procedure` (the opposite), `quality and cycle time optimisation` |
| `straw bale` | 11 | `operate bale presses`, `remove cotton from bale presser` |
| `bike polo` | 171 | `sell bicycles`, `wash bicycles`, `assemble bicycles` |
| `consensus decision` | 135 | `decision support systems`, `make decisions`, `make legislative decisions` |
| `mutual aid` | 199 | `develop a collaborative therapeutic relationship`, `identify drying defects`, `sell products` |
| `nonviolent communication` | 667 | `communication disorders`, `use a complex communication system` |
| `know your rights` | 660 | `be in touch with your body`, `conveyancing`, `promote yourself` |

That last group is worth naming explicitly: **ESCO's full-text search will always return *something*.** Any integration that trusts a non-zero result count will silently map "know your rights with police" onto "conveyancing". This is the single most important implementation warning in this brief.

**ESCO's structural bias, stated plainly.** ESCO exists to match job-seekers to vacancies in an EU labour market. It therefore has excellent coverage of skills an employer pays for (welding processes, plumbing installation, vehicle diagnostics, food-industry QA, nursing tasks) and near-zero coverage of four things free schools are built on:

1. **Subsistence and land skills outside commercial agriculture** — seed saving (0 of 7 nodes matched), permaculture, beekeeping, composting, foraging, hide tanning, butchery at household scale.
2. **Unwaged care** — herbalism, peer mental-health support, doula work, death doula work, harm reduction, DIY reproductive care, collective childcare.
3. **Political self-organisation** — consensus, facilitation of assemblies, mutual aid, direct action, legal observing, jail support, tenant and eviction defence, cooperative governance (0 of 8 nodes matched).
4. **Anti-commercial and repair culture** — zines, free stores, repair cafés, dumpster diving, upcycling, library-of-things (0 of 7 reuse nodes matched).

### Proposed extension nodes

All 306 are in the JSONL with `status: "proposed"`, a `broader` parent in our tree, and a QID where one exists. **265 of the 306 carry a Wikidata QID; 41 carry neither external id** — those 39 are the skills that exist nowhere in either reference vocabulary, which makes them the most interesting entries in the file. The highlights, with the QIDs as shipped:

**Land and subsistence** — `permaculture-design` Q4572 · `hugelkultur` Q17069101 · `agroforestry-and-food-forests` Q276109 · `sheet-mulching-and-no-dig-beds` Q4413684 · `cover-cropping-and-green-manure` Q97369028 · `keep-bees` Q176353 · `build-top-bar-and-warre-hives` Q1127393 · `manage-varroa-and-bee-disease` Q48564 · `keep-native-and-mason-bees` Q61082077 · `save-seed` Q1077684 · `run-a-seed-library-or-seed-swap` Q7445636 · `landrace-and-locally-adapted-varieties` Q174030 · `seed-sovereignty-and-resisting-seed-patents` Q1361172 · `vermicomposting-with-worms` Q900747 · `make-biochar` Q905495 · `mycoremediation-and-soil-bioremediation` Q3028806 · `humanure-and-compost-toilet-management` *(no QID)* · `bokashi-fermentation-composting` *(no QID)*

**Wild food and whole-animal** — `forage-wild-food` Q2991771 (*wildcrafting* — the human sense; Wikidata's `foraging` Q2916569 is explicitly "by non-human animals") · `identify-wild-mushrooms` Q2391676 · `tap-trees-for-sap-and-syrup` Q402563 · `harvest-and-process-acorns` Q3914781 · `dumpster-diving-and-food-recovery` Q1110145 · `cook-from-salvaged-and-gleaned-food` Q254615 · `hide-tanning` Q211578 · `brain-tanning-and-buckskin` *(no QID)* · `field-dressing-and-game-processing` *(no QID)* · `nose-to-tail-offal-cookery` Q157484 · `render-tallow-and-make-soap-from-it` Q863266 · `urban-foraging` *(QID withheld — see caveats)*

**Natural building and off-grid** — `cob-and-earthen-building` *(no QID)* · `straw-bale-construction` Q1255891 · `build-a-cob-oven` Q908601 · `build-a-rocket-mass-heater` Q7355161 · `earthen-and-clay-plaster` *(no QID)* · `lime-plaster-and-limewash` Q6549153 · `dry-stone-walling` Q5608878 · `build-a-root-cellar` Q1349300 · `greywater-systems` Q1075169 · `build-a-composting-toilet` Q178496 · `micro-hydro-power` Q3917224 · `tiny-house-building` Q30531

**Repair and anti-waste** — `run-a-repair-cafe` Q4504516 · `right-to-repair-and-parts-sourcing` Q108837947 · `run-a-free-store-or-really-really-free-market` Q2233575 · `run-a-swap-giveaway-or-library-of-things` Q25608610 · `visible-mending-and-boro` Q120798968 · `make-patches-and-back-patches` Q384074 · `recycle-plastics-at-small-scale` Q85794325 · `run-a-tool-library` Q6643412 · `run-a-community-bike-workshop` Q3183465 · `set-up-a-community-workshop` Q45820240

**Care outside the clinic** — `street-medicine-and-action-medic-work` Q7623023 · `treat-chemical-weapons-and-tear-gas-exposure` Q190512 · `administer-naloxone-and-respond-to-overdose` Q282902 · `harm-reduction-practice` Q1458711 · `herbal-first-aid-kit` Q861699 · `make-tinctures` Q969804 · `ethical-wildcrafting` Q2991771 · `peer-support-for-mental-health` Q1569083 · `mad-pride-and-psychiatric-survivor-organising` Q7256242 · `trauma-informed-practice` Q115828599 · `abortion-doula-and-access-support` Q113245280 · `birth-doula-and-community-midwifery` Q749813 · `trans-and-queer-health-navigation` Q28130218 · `self-managed-and-diy-gynaecology` *(no QID)* · `care-collectives-and-care-webs` Q65084534 · `death-doula-and-end-of-life-support` *(ESCO-matched, canonical)*

**Conflict and accountability** — `nonviolent-communication` Q840304 · `transformative-justice-practice` Q7834109 · `community-accountability-processes` Q15735889 · `bystander-intervention` Q55950666 · `abolitionist-alternatives-to-policing` Q322740 · `consent-culture-and-boundary-setting` Q231043

**Organising and direct action** — `consensus-decision-making` Q188577 · `hand-signals-and-spokescouncils` Q7578918 · `facilitate-large-assemblies` Q280783 · `nonviolent-direct-action` Q754479 · `affinity-groups-and-action-roles` Q1643970 · `security-culture` Q7445029 · `blockades-lockdowns-and-occupations` Q273976 · `squatting-and-building-occupation` Q44854 · `eviction-defence-and-blockades` *(no QID)* · `tenant-organising-and-rent-strikes` Q31884698 · `strike-organising-and-picket-lines` Q1480879 · `alley-cat-races-and-critical-mass-rides` Q1759171 · `bike-polo-and-diy-sport-organising` Q429885 · `jail-support` *(no QID)* · `prisoner-support-and-letter-writing` Q7245834 · `bail-funds-and-commissary-support` Q97357826 · `legal-observing` Q6517550 · `copwatch-and-filming-police` Q2996885 · `know-your-rights-with-police` *(no QID)* · `support-immigrant-neighbours-and-ice-watch` Q108809868 · `build-a-mutual-aid-network` *(no QID)* · `run-a-community-fridge-or-pantry` Q42417254 · `disaster-response-and-mutual-aid-relief` Q126364760 · `food-not-bombs-style-community-kitchen` Q580916

**Cooperative governance** — `start-a-worker-cooperative` Q1939471 · `start-a-housing-cooperative` Q3683749 · `sociocracy-and-nested-circles` Q672276 · `horizontal-and-leaderless-structure` Q279969 · `commons-governance-and-rules-in-use` Q9828451 · `collective-ownership-of-land-and-buildings` Q4227971 · `solidarity-economy-and-alternative-currencies` Q1783877 · `sliding-scale-and-pay-what-you-can-models` Q12291789

**Zines, print and movement media** — `make-a-zine` Q549638 · `lay-out-and-paste-up-a-zine` Q868954 · `distro-and-zine-distribution` Q134592047 · `run-a-zine-library-or-infoshop` Q428044 · `photocopier-tricks-and-cheap-reproduction` Q185369 · `print-with-a-risograph` Q114079395 · `wheatpaste-and-street-postering` Q2982752 · `cyanotype-and-sun-printing` Q372532 · `patch-and-t-shirt-printing-for-movements` Q131151 · `independent-and-movement-media` Q192855 · `run-a-community-radio-show` Q1179112 · `document-actions-and-protests-safely` Q848979 · `strip-metadata-and-protect-subjects-identities` Q6822481 · `protest-songs-chants-and-street-bands` Q829147 · `theatre-of-the-oppressed-and-forum-theatre` Q1269058 · `puppet-and-large-scale-prop-making-for-parades` Q588750

**Pedagogy** — `unschooling-and-free-school-pedagogy` Q1000032 · `popular-education-and-freirean-methods` Q538925 · `collective-and-consent-based-childcare` *(no QID)*

**Digital autonomy and low-tech resilience** — `threat-modelling-for-activists` Q7797194 · `use-tor-and-vpns` *(no QID)* · `protect-a-phone-at-a-protest` *(no QID)* · `resist-facial-recognition-and-surveillance` Q1192553 · `run-a-mesh-network` Q6453712 · `lora-and-meshtastic-messaging` Q50552023 · `set-up-a-pirate-or-micro-fm-station` Q877017 · `get-a-ham-licence-and-learn-band-plans` *(no QID)* · `run-off-grid-comms-for-an-action` *(no QID)* · `federated-and-atproto-social-tools` Q30325419 · `flintknapping-and-stone-tools` Q13645339 · `wildfire-preparedness-and-defensible-space` *(no QID)* · `build-emergency-shelter` *(no QID)*

### The 41 nodes that exist in neither vocabulary

`externalIds: {}` — no ESCO concept, no Wikidata item. These are where the free-school curriculum is genuinely off the map of both a labour-market classification and a general-knowledge graph:

| domain | node |
|---|---|
| organizing | `jail-support` · `know-your-rights-with-police` · `eviction-defence-and-blockades` · `build-a-mutual-aid-network` · `notice-and-interrupt-power-dynamics-in-a-room` |
| care | `self-managed-and-diy-gynaecology` · `collective-and-consent-based-childcare` · `sobriety-recovery-and-addiction-peer-support` · `burnout-and-sustainable-activism` |
| food | `brain-tanning-and-buckskin` · `field-dressing-and-game-processing` · `process-rabbits-and-small-game` · `urban-foraging` · `wild-fermentation-and-culture-swapping` · `ethical-and-legal-harvesting-practice` |
| land | `humanure-and-compost-toilet-management` · `bokashi-fermentation-composting` · `catch-and-hive-a-swarm` |
| practical-trades | `cob-and-earthen-building` · `earthen-and-clay-plaster` |
| repair | `sew-banners-flags-and-bloc-gear` · `salvage-and-deconstruct-for-materials` · `patch-and-reinforce-clothing` |
| tech-digital | `use-tor-and-vpns` · `protect-a-phone-at-a-protest` · `run-off-grid-comms-for-an-action` · `get-a-ham-licence-and-learn-band-plans` · `wildfire-preparedness-and-defensible-space` · `build-emergency-shelter` · `self-host-services` · `degoogle-and-reduce-platform-dependence` |

**Read that list with one caveat.** Roughly a third of the 41 are artefacts of how *I* phrased the label, not real vocabulary gaps: `cut-and-join-pipe`, `frame-walls-and-partitions`, `spin-yarn`, `smoke-food`, `pressure-can-low-acid-foods`, `cook-soups-and-stocks`, `organise-a-march-or-rally`, `set-and-manage-an-agenda` and `wire-a-battery-bank` are compound or verb-phrased labels that would almost certainly find a QID under a simpler noun (`spinning`, `smoking (cooking)`, `demonstration`). The unambiguously real gaps are the political and care ones — `jail-support`, `eviction-defence-and-blockades`, `know-your-rights-with-police`, `self-managed-and-diy-gynaecology`, `brain-tanning-and-buckskin`, `humanure-and-compost-toilet-management` — which is the substantive finding.

### Checked against real free-skool catalogs

The gap list above started as my priors. To test them I fetched actual published session lists rather than reasoning from memory. **Free Skool Santa Cruz** (running since 2006, sessions pegged to Beltane and the equinoxes) publishes its full class list each session, and four of those lists are live — giving **~122 verbatim class titles** as primary evidence.

**Summer 2022 — 53 classes**, verbatim, as published: *Autumn Equinox Ritual · B40 and Before B40 · Basic DIY Electronics · Basic Songwriting Twists and Tricks! · Bike Mechanics for Beginners · Bioregional Herbalism: Get to Know Your Local Plants! · Blue for the People: Community Indigo Vat · Children's Art Class · Community Workout Day · Creative Writing: Process Writing · Creative Writing Workshop: Intro to Fiction · Crescent Moon Mending Circle and Tea Social · Crochet Windspinners for Beginners · Cultivating Compost · Drag Ultimate Frisbee Meetup · East Meadow Walk · Emma Goldman's Autobiography – Discussion Group · Fábrica Open Hours · Fall Equinox Apple Picking, Plus Apple Press · Find Solid Ground: A Dialectical Behavior Therapy Practice Group · Fire Walk with Me · First Aid Fundamentals for a Protest Environment · Fresh Indigo: Salt Rub Method · Herbal Mutual Aid: Community Medicine-Making · Guitar Church: how to take care of your guitar · Intro to Hand-Stitching · Intro to Lyric Writing and Performance · Intro to Mindfulness · Intro to Writing Poetry · Jessie Street Marsh iNaturalist BioBlitz · Journaling in Nature · Let's Make Buttons! · LiveLoop Lesson · Make your own Astrology Chart · Making Stuff with Junk · Mutual Listening as a Tool for Activists · The Participation of Women in Global Revolutionary Struggle · Practicing Abolitionist Principles in daily life & Lgbtqi+ Inmate snail mail workshops · Pregnant Picnic: a hangout for radical pregnant people · Queer Poetry in the Forest · Queer Yoga · Radical Political Theory Reading Group · Really Really Free Market · Ritual Skills (Reclaiming influenced style) · Salsa Dance Club Basics · Securing your digital presence · Socialist Stitch and Bitch · Star Lovers Club: Equinox Edition · Tenants Rights in Santa Cruz series · T-shirt Screen Printing · UCSC Radical History Walking Tour · Why Knot? A Knot-Tying Workshop · Woven Roots – discussion group for mixed-race people*

**Spring/Summer 2023 — 25 classes**, including: *Beach Flats Garden Celebration · Bike Church Youth Hours · Birth Support! · Building Radical Systems of Care · Cyanotype 101 · Democratic Confederalism · Drag Workshop · Ecology Nerd Sesh · Everything for everyone: an intro to cooperatives · Exploring the Liberatory Potential of Community through Collective Improvisation · Grassroots Organizing: unions, tenants, neighborhoods · Group Somatics · Knots 101 · Make a Broom · Neurodiversity and Community Care · Really Really Free Market · Socialist Stitch and Bitch · Using State Bureaucracy to Benefit Anarchist Projects · We all need a Plan C: A teach-in and conversation on abortion access in a post-Roe US*

**Spring/Summer 2024 — 37 classes**, including: *Bees! · Bicycle Frame Bag Workshop · Cyanotype printmaking workshop: Photography with the sun · Ecological Literacy · Festival of Broken Needles · Hand Stitch Club · Herbal First Aid · Intro to Bikes! · Intro to Stick and Poke Tattooing · Mending Party at the Fábrica · Midsummer Eve Parade · Natural Plaster Work Party · Research Techniques for Anarchists · Soupshare · Stopping Cop Country · Why Knot? A Knot-Tying Class · WTF! (women, trans, femme) Bike Days*

**2025 session part 2 — 7 classes**: *Collective Creation Games part 2 · Fuck Fast Fashion! Fix your Fit! · Identity and Knowledge: Intro to Feminist Epistemology 1 · Handspinning (an introduction) · Mutual Aid in Action: Designing Real Projects Together · Queer writing circle · What Can We Learn From the Rojava Revolution*

**Toronto's Anarchist Free Space and Free Skool** (founded April 1999, Kensington Market; re-formed as the **Anarchist Free University**, one of the city's longest-running anarchist projects) offered, per secondary accounts: *Alternative Health Practices · Art, Anarchism, and Culture · Spanish Conversation · Anarchism and Cities · Wild Plants of Toronto · The Conflict in Chiapas · Judo for Gentle People · Conversational Spanish · Radical Perspectives on Mass Media · Secret History of the World*. Their operating pattern is worth copying into the product model: courses are proposed at monthly meetings, whoever commits to facilitating writes the description, and a new calendar ships every four months with additions allowed at any time.

### What the real catalogs changed

**My gap list was right but incomplete, and the shape of the miss is a product finding, not a taxonomy finding.** Roughly a third of these titles are not "skills" at all. *Radical Political Theory Reading Group*, *Emma Goldman's Autobiography – Discussion Group*, *Woven Roots – discussion group for mixed-race people*, *Queer Poetry in the Forest*, *Queer Yoga*, *Pregnant Picnic*, *Drag Ultimate Frisbee Meetup*, *Star Lovers Club*, *Really Really Free Market*, *Fábrica Open Hours*, *Soupshare*, *East Meadow Walk*, *Community Workout Day* — these are **reading groups, affinity socials, open shop hours, recurring rituals and free markets**. A learner does not acquire a transferable competence from a pregnant picnic; that is not what it is for.

Two implications for the schema, both outside this brief but worth recording:

1. **Events need a format/kind axis independent of skill.** Something like `workshop | class | reading group | open hours | social | ritual | market | walk | work party`. Forcing *Fábrica Open Hours* to declare a skill is the kind of schema violence that makes people stop posting.
2. **Some events legitimately have no skill at all**, or have a *topic* rather than a skill. `freeschool.draft.event` should allow zero skill references, or a separate topic reference, rather than requiring one.

**Fourteen nodes were added to the seed directly from these titles**, each traceable to a fetched class (eleven more follow from the second evidence batch below):

| new node | from (verbatim class title) | QID |
|---|---|---|
| `host-a-reading-or-discussion-group` | *Radical Political Theory Reading Group*; *Emma Goldman's Autobiography – Discussion Group* | Q2980154 |
| `run-a-teach-in` | *We all need a Plan C: A teach-in…* | Q1518054 |
| `organise-a-work-party` | *Natural Plaster Work Party* | — |
| `host-a-mending-circle` | *Crescent Moon Mending Circle and Tea Social*; *Mending Party at the Fábrica*; *Festival of Broken Needles* | Q4504516 |
| `sew-a-bicycle-frame-bag` | *Bicycle Frame Bag Workshop* | Q117208871 |
| `host-a-soup-share-or-collective-meal` | *Soupshare* | Q5153956 |
| `lead-a-radical-history-walking-tour` | *UCSC Radical History Walking Tour* | Q12695722 |
| `lead-community-ritual-and-seasonal-ceremony` | *Autumn Equinox Ritual*; *Ritual Skills (Reclaiming influenced style)*; *Midsummer Eve Parade* | Q189819 |
| `perform-drag` | *Drag Workshop* | Q337084 |
| `stick-and-poke-tattooing` | *Intro to Stick and Poke Tattooing* | Q43006 |
| `make-a-broom` | *Make a Broom* | Q172833 |
| `run-a-bioblitz-or-citizen-science-survey` | *Jessie Street Marsh iNaturalist BioBlitz*; *Ecology Nerd Sesh* | Q2904016 |
| `host-a-queer-or-affinity-social-space` | *Queer writing circle*; *Queer Yoga*; *Pregnant Picnic*; *Woven Roots* | Q4080972 |
| `group-somatics-and-nervous-system-work` | *Group Somatics*; *Find Solid Ground: A DBT Practice Group* | Q4937028 |

**What the catalogs confirmed I already had**, with the title that confirms it: `herbal-first-aid-kit` (*Herbal First Aid*), `identify-medicinal-plants` (*Bioregional Herbalism*), `street-medicine-and-action-medic-work` (*First Aid Fundamentals for a Protest Environment*), `grow-and-process-indigo-and-woad` (*Blue for the People: Community Indigo Vat*; *Fresh Indigo: Salt Rub Method*), `cyanotype-and-sun-printing` (*Cyanotype 101*), `patch-and-t-shirt-printing-for-movements` (*T-shirt Screen Printing*), `make-compost` (*Cultivating Compost*), `run-a-free-store-or-really-really-free-market` (*Really Really Free Market*), `tenant-rights-and-housing-law-basics` (*Tenants Rights in Santa Cruz series*), `prisoner-support-and-letter-writing` (*Lgbtqi+ Inmate snail mail workshops*), `abolitionist-alternatives-to-policing` (*Practicing Abolitionist Principles in daily life*; *Stopping Cop Country*), `start-a-worker-cooperative` (*Everything for everyone: an intro to cooperatives*), `tenant-organising-and-rent-strikes` and `union-organising-and-workplace-committees` (*Grassroots Organizing: unions, tenants, neighborhoods*), `earthen-and-clay-plaster` (*Natural Plaster Work Party*), `repair-a-flat-tire` / `run-a-community-bike-workshop` (*Bike Mechanics for Beginners*; *Bike Church Youth Hours*; *Intro to Bikes!*), `spin-yarn` (*Handspinning (an introduction)*), `crochet` (*Crochet Windspinners for Beginners*), `hand-sew` (*Intro to Hand-Stitching*; *Hand Stitch Club*), `mend-and-darn-clothing` (*Fuck Fast Fashion! Fix your Fit!*), `knots-and-lashings` (*Why Knot?*; *Knots 101*), `build-a-mutual-aid-network` (*Mutual Aid in Action*; *Herbal Mutual Aid*), `threat-modelling-for-activists` and `use-strong-passwords-and-a-manager` (*Securing your digital presence*), `birth-doula-and-community-midwifery` (*Birth Support!*), `abortion-doula-and-access-support` (*We all need a Plan C*), `care-collectives-and-care-webs` (*Building Radical Systems of Care*; *Neurodiversity and Community Care*), `peer-support-for-mental-health` (*Find Solid Ground*), `make-patches-and-back-patches` (*Let's Make Buttons!*), `upcycle-materials` (*Making Stuff with Junk*), `collective-ownership-of-land-and-buildings` and `horizontal-and-leaderless-structure` (*Democratic Confederalism*; *What Can We Learn From the Rojava Revolution*), `start-and-steward-a-community-garden` (*Beach Flats Garden Celebration*), and the `music-sound` area generally (*Exploring the Liberatory Potential of Community through Collective Improvisation*, *Basic Songwriting Twists and Tricks!*, *Intro to Lyric Writing and Performance*, *Guitar Church*).

**What I still do not cover, and deliberately did not add.** Real catalogs carry a large seam of *political-education and reading* content — *Democratic Confederalism*, *Intro to Feminist Epistemology*, *The Participation of Women in Global Revolutionary Struggle*, *Intro To Sociology*, *Research Techniques for Anarchists*, *Solidarity in Resistance: The Palestinian, Armenian, and Kurdish Struggles Against Genocide*, *Using State Bureaucracy to Benefit Anarchist Projects*, *UCSC Radical History Walking Tour* — plus **language exchange** (*Spanish Conversation*, *Conversational Spanish* at Toronto AFU), **sport and movement clubs** (*Queer Soccer Club!*, *Queer Basketball*, *Salsa Dance Club Basics*, *Judo for Gentle People*, *Juggle Your Life Away*), and **divinatory and spiritual practice** (*Make your own Astrology Chart*, *Star Lovers Club*, *Fire Walk with Me*). A skills taxonomy is the wrong instrument for most of this: "Democratic Confederalism" is a *subject*, not a competence, and cramming it into a skill tree would mean inventing a parallel academic-subject hierarchy inside `freeschool.draft.skill`. **My recommendation is a separate `topic` vocabulary** — Wikidata QIDs alone would carry it well, since every one of those subjects has a solid QID — referenced from events alongside (or instead of) skills. Flagging it as an open design question rather than silently papering over it.


### Second evidence batch — five more projects, and a correction to my own gap list

A parallel archive sweep (web.archive.org CDX + direct `curl`, since WebFetch is blocked for archive.org) turned up five further projects with **verified** catalogs. This materially widens the evidence base and, more usefully, **contradicts several of my own priors.**

**EXCO — Experimental Community Education of the Twin Cities** (`excotc.org`, now dead; snapshot 2011-11-06 of `/all-classes`, 34 titles; season pages 2010–2014; the CDX index lists **908 archived `/class/` detail pages**). Verbatim highlights: *Street Medic First Aid · Navigating American Sign Language Access in Your Activism · Building an Earth Oven · Complete Bicycle Overhaul at Sibley Bike Depot · Women and Trans Only – Winter Biking and Maintenance · DIY Screenprinting with Living Proof Print Collective · Beginning Screenprinting with Living Proof: Workshop for People of Color · Kiswahili Discussion Circle · Gourmet Vegetarian: The Diet of Sustainability · Knit & Such · Writing and Performing Political Theatre · Instead of Marriage: Write Your Own Relationship Contract · Piñatas · Bordados y más · Tejidos · Alfabetización para adultos · Maquillaje Profesional*. Archived class slugs include `back-yard-chicken-keeping`, `beginning-tomato-canning-class`, `basement-screen-printing`, `becoming-riflemyn-rifle-marksmynship`, `bike-feminism-what-it-is-how-we-live-it-how-to-share-it`, `beginning-meditation-and-mindfulness-for-activists`, `anticipating-collapse`, `audio-electronics`, `5-string-banjos`, `basic-alterations-no1-hems`.

**Montreal Anarchist Bookfair workshop archive, 2002–2017** — by far the richest political-education source, and a near-perfect map of the `organizing` and `care` domains: *Refusing to Be Abused: Histories and Present Realities of Copwatch · Our rights in dealing with cops · Legal self-defence · Squatting: Legal considerations in occupying a building · Squatting as political practice: Guide to Italy's occupied autonomous social centres · The Anarchist Black Cross and Political Prisoner Support · Organizing in Solidarity with Prisoners · Homos for Prison Abolition · Transforming Harm: Supporting Survivors and Confronting Sexual Assault in Our Communities · Collective responses to intimate violence and sharing emotional labour · Radical Mental Health: foundations and being a good ally · Radical Sobriety: Anarchist Perspectives on Addiction and Recovery · Death on the Commons: Toward Caring Communities · For the Long Haul: Care, Intention, and Steadiness in Radical Organizing · Birth Work as Care Work · Building Your Own Radio Station: FM transmitter building · Affinity Groups: A Method of Anarchist Action · Anarchism and Ableism: Radical Disability Politics · Solidarity City: Migrant justice and the everyday practice of mutual aid · Freeschool: One is not born a libertarian, one becomes one · Deschooling: Getting society out of school · Popular Education as Liberatory Pedagogy · FemCrypt · Strategies for Computer Security*. Note: **"Anarchist Free School Montreal" does not exist as a named project** — Montreal's free-school activity runs through QPIRG skillshares, the Ste-Émilie Skillshare and the Bookfair itself.

**Bloomington Free Skool** (`bloomington.freeskool.org`, snapshot 2011-04-12) — complete inaugural Spring 2011 catalog, 45 titles, including *You Can Squat Too! · How to teach yourself anything and quit school · Make Your Own Laundry Detergent · Beer Brewing · Homemade vinegars and oils · Nature Connection: Natural Dyes · Understanding Bird Language · Contrary urban farming · Bicycles, demystifed · Screenprinting at home · Felting handbags · Mask Making · Explore the Theatre of the Oppressed · Reading Group: The Coming Insurrection · Spanish Night/Noche Española · Fundamental chinese language for the autodidactic*.

**Firestorm Books, Asheville** — live, fetched via `https://firestorm.coop/calendar.ics` (the HTML calendar is behind a bot wall; the iCal feed is not). 29 current events: *Asheville Prison Books Packaging Party · Political Prisoner Letter Writing · Drop-in Community Notary Service · Abolitionist Reading Club · Tranzmission Prison Project Packaging Party · Harm Reduction Kit Packing Party · Zine Assembly · Neurodivergent Reading Group · Weekly Trans Writing Circle · De-Google Together · Rad Parent Meetup · Darn it all! An Introduction to Visible Mending · Consent Conversations 101 · Rural Radical Resistance · Tech Workers Fight Back!* No entity called "Asheville Free School" was found; Firestorm is the actual venue.

**QPIRG McGill / Concordia** — partially verified (one Social Justice Days page fetched); dozens of CDX-indexed skillshare posts remain unfetched (Winter Skillshare Day, Ste-Émilie Skillshare, Elderberry Syrup Workshop, Tatreez Workshop, Radical Reference Research Skills, *School Schmool* radical day-planner). **Brooklyn Free School** was not verified — it is a K–12 democratic school with student-proposed classes rather than a public catalog, so low value here.

#### This corrected me in both directions

**Now confirmed by a real fetched listing** (topics I had proposed on priors alone): **squatting** as a titled class (*You Can Squat Too!*, Bloomington 2011; *Squatting: Legal considerations…*, Montreal 2009), **street medicine** (*Street Medic First Aid*, EXCO), **natural building** (*Building an Earth Oven*, EXCO), **know-your-rights / legal** (*Our rights in dealing with cops*, *Legal self-defence*, Montreal), **transformative justice and survivor support** (an entire Montreal sub-genre 2006–2014), **prisoner support and prison books** (Firestorm packaging parties; *The Anarchist Black Cross*), **radical mental health and peer sobriety** (*Radical Mental Health*, *Radical Sobriety*), **harm reduction** (*Harm Reduction Kit Packing Party*), **deschooling/unschooling as a taught meta-topic** (recurring at Bloomington, Montreal, Toronto and Santa Cruz), **visible mending** (*Darn it all!*), **pirate FM** (*Building Your Own Radio Station: FM transmitter building*), and **community defence / marksmanship** (EXCO's `becoming-riflemyn-rifle-marksmynship`).

**And it did *not* confirm some of my favourites.** Across every catalog fetched — Santa Cruz, EXCO, Montreal, Bloomington, Firestorm, Toronto — **none of these appeared as a class title**: *lockpicking · flintknapping · hide tanning · compost toilets · cob or straw-bale building by name · death doula by name · DIY gynaecology by name · dumpster diving / freeganism as a titled class · alley cat races*. Those nodes are still in the seed as `proposed`, which is the right status for them, but I should be straight about it: **they came from my model of free-school culture, not from a catalog I read.** They may be real (they are well attested in zines and in the wider radical-skillshare scene) or they may be my romanticism. Anyone pruning this seed should treat that list as the first candidates for deletion, and the Montreal/EXCO-attested nodes as the last.

**Eleven more nodes were added from this batch**, plus a new area — `pedagogy-and-literacy`, holding the free school's reflection on its own method together with the literacy and language work that immigrant and Deaf neighbours actually ask for (`unschooling-and-free-school-pedagogy` and `popular-education-and-freirean-methods` moved there out of `childcare`, where they never belonged):

| new node | from (verbatim class title) | QID |
|---|---|---|
| `run-a-free-skool-or-learning-collective` | *Freeschool: One is not born a libertarian…* [MTL]; *Anarchist Education* [MTL] | Q17014717 |
| `deschooling-and-self-directed-learning` | *How to teach yourself anything and quit school* [Bloomington]; *Deschooling: Getting society out of school* [MTL] | Q356099 |
| `host-a-language-exchange-circle` | *Kiswahili Discussion Circle* [EXCO]; *Spanish Night/Noche Española* [Bloomington]; *Conversational Spanish* [Toronto] | Q17084569 |
| `sign-language-for-access-and-organising` | *Navigating American Sign Language Access in Your Activism* [EXCO] | Q14759 |
| `adult-literacy-tutoring` | *Alfabetización para adultos* [EXCO] | Q8236 |
| `pack-and-send-books-to-prisoners` | *Asheville Prison Books Packaging Party*; *Tranzmission Prison Project Packaging Party* [Firestorm] | Q4943298 |
| `pack-harm-reduction-and-naloxone-kits` | *Harm Reduction Kit Packing Party* [Firestorm] | Q1760326 |
| `community-defence-and-firearms-safety` | `becoming-riflemyn-rifle-marksmynship` [EXCO] | Q1315509 |
| `make-household-cleaners-and-laundry-soap` | *Make Your Own Laundry Detergent* [Bloomington] | Q910284 |
| `degoogle-and-reduce-platform-dependence` | *De-Google Together* [Firestorm] | — |

One QID needed a hand correction worth recording, because it is a nice illustration of the topic-anchor problem: **`free school` resolves by default to Q5500295, the UK state-funded academy** — the exact opposite of the anarchist lineage. It is overridden to **Q17014717 *Free school movement*** (the American 1960s–70s education reform movement).

---

## Licensing / attribution text to ship in the app

### ESCO — free for any purpose, **attribution required**

Reuse rests on **Commission Decision 2011/833/EU of 12 December 2011 on the reuse of Commission documents**, under a **Creative Commons Attribution 4.0 International (CC BY 4.0)** licence. The terms, quoted:

> "the ESCO classification can be downloaded, used, reproduced and reused for any purpose and by any interested party free of charge."

> "The reuse of this document is authorised under a Creative Commons Attribution 4.0 International (CC-BY 4.0) licence, which means that reuse is allowed provided appropriate credit is given and any changes are indicated."

ESCO specifies the exact wording to use. **For a service, ship this string verbatim:**

> **This service uses the ESCO classification of the European Commission.**

**For a document or export, the variant is:**

> **This publication uses the ESCO classification of the European Commission.**

And because we extend and re-parent ESCO concepts, this clause applies directly to us:

> "Any modified or adapted version of ESCO must be clearly indicated as such."

Good news for the forkable-records decision: implementers retain "complete freedom" to modify concepts for local needs, and the Commission asks only that modifications be shared back. Our `status: proposed` + fork model is exactly the behaviour ESCO invites.

ESCO also carries third-party content whose attributions travel with it. If any of these reach a user-facing surface, ship them too:

> O*NET OnLine is provided by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O*NET® is a trademark of USDOL/ETA.

The ESCO skill hierarchy is partially based on O*NET and on the Government of Canada's Skills and Knowledge Checklist. ESCO's Bertelsmann Stiftung competence cards are **CC BY-SA 4.0** — a share-alike licence. We do not use them and should keep it that way, since SA would be viral into our records.

### Wikidata — CC0, no attribution required

Wikidata's structured data is released under **CC0 1.0 Universal (public domain dedication)**. No attribution is legally required, which is why 378 seed descriptions reuse Wikidata's English descriptions verbatim without an encumbrance. Credit is still good practice and good for the commons.

### Suggested shipping text

In the app footer and in the `/about/data` page:

> **Skill taxonomy data.** This service uses the ESCO classification of the European Commission (ESCO v1.2.1), licensed CC BY 4.0. Free School's taxonomy is a modified and extended version of ESCO: we regroup ESCO concepts under our own domains and areas, and we add community-proposed skills that ESCO does not cover. Those additions and the regrouping are Free School's, not the European Commission's. ESCO's skill hierarchy is partly based on O*NET, provided by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA) under CC BY 4.0; O*NET® is a trademark of USDOL/ETA. Concept identifiers and descriptions from Wikidata are released under CC0 1.0 (public domain).

Per-record, the `externalIds` field already carries the citation: an `esco` URI resolves to the concept on `data.europa.eu`, and a `wikidata` QID resolves on `wikidata.org`. Rendering those as links in the skill detail view satisfies "appropriate credit" better than a footer does.

---

## Sources

**APIs queried directly (all 2026-09-12):**
- ESCO REST API — `https://ec.europa.eu/esco/api/search`, `/resource/skill`, `/resource/taxonomy`. 1,301 cached `/search` responses in `esco_cache.json`; 196 resolved skill-group concepts in `esco_groups.json`; 41 gap probes in `esco_gap_probes.json`; an 8-URI live resolution spot-check.
- Wikidata Query Service — `https://query.wikidata.org/sparql`, 13 batched exact-label queries.
- Wikidata API — `https://www.wikidata.org/w/api.php`, `wbsearchentities` (~185 calls) and `wbgetentities` (87 QIDs verified).

**Documentation and licence pages:**
- ESCO download page and version statement — https://esco.ec.europa.eu/en/use-esco/download (ESCO v1.2.1, last update 10/12/2025)
- ESCO FAQ — licence, required attribution strings, modification clause, API statement — https://esco.ec.europa.eu/en/about-esco/faq
- ESCO Skills & Competences copyright notice — O*NET, Government of Canada, Bertelsmann Stiftung attributions — https://esco.ec.europa.eu/en/copyright-notice-esco-skills-competences
- The ESCO classification — https://esco.ec.europa.eu/en/classification
- ESCO skills pillar — https://esco.ec.europa.eu/en/classification/skills
- ESCO handbook (PDF) — https://esco.ec.europa.eu/system/files/2021-07/Handbook.pdf
- Commission Decision 2011/833/EU on the reuse of Commission documents
- Wikidata licensing (CC0 1.0) — https://www.wikidata.org/wiki/Wikidata:Licensing

**Free-skool catalogs fetched directly (primary evidence, 2026-09-12):**
- Free Skool Santa Cruz, Summer 2022 class list (53 titles) — https://freeskoolsantacruz.org/2022-free-skool-santa-cruz-list-of-classes-in-alphabetical-order/
- Free Skool Santa Cruz, Spring/Summer 2023 class list (25 titles) — https://freeskoolsantacruz.org/spring-summer-2023-free-skool-santa-cruz-session-part-1/
- Free Skool Santa Cruz, Spring/Summer 2024 class list (37 titles) — https://freeskoolsantacruz.org/2024-fssc-list-of-classes-so-far/
- Free Skool Santa Cruz, 2025 session part 2 (7 titles, with dates) — https://freeskoolsantacruz.org/2025/08/03/2025-free-skool-santa-cruz-session-part-2/
- Free Skool Santa Cruz home — https://freeskoolsantacruz.org/
- Free Skool Santa Cruz 2026 Spring/Summer session announcement (session dates: May Day/Beltane 1 May – 15 July; Summer/Autumn 16 July – Autumn Equinox 22 September) — https://www.anarchistfederation.net/join-us-for-the-free-skool-santa-cruz-2026-spring-summer-session

**Free-skool catalogs fetched from archive.org / live feeds (primary evidence, second batch, 2026-09-12):**
- EXCO Twin Cities, all-classes page (34 titles) — http://web.archive.org/web/20111106104754/http://www.excotc.org/all-classes (snapshot 2011-11-06); season pages snapshotted 2010-04-26 → 2014-10-29; CDX index lists 908 `/class/` detail pages
- Montreal Anarchist Bookfair, workshops archive 2002–2011 — http://web.archive.org/web/20120423034737/http://www.anarchistbookfair.ca/about/archives/workshopsarchive (snapshot 2012-04-23); per-year workshop pages for 2012 (snap 2013-03-16), 2013 (2014-07-08), 2014 (2015-07-07), 2015 (2016-05-21), 2016 (2017-05-31), 2017 (2017-05-28)
- Bloomington Free Skool, complete Spring 2011 catalog (45 titles) — http://web.archive.org/web/20110412132310/http://bloomington.freeskool.org/classes (snapshot 2011-04-12); homepage snap 2011-04-10
- Firestorm Books (Asheville), live calendar feed (29 events) — https://firestorm.coop/calendar.ics (fetched 2026-09-12); archived workshop calendar — `calendar.html?types=workshop` (snapshot 2019-08-18)
- QPIRG McGill, Social Justice Days 2010 — http://web.archive.org/web/20110107090046/http://qpirgmcgill.org/2010/02/social-justice-days-february-7th-17th-2010/
- Brooklyn Free School program page — `brooklynfreeschool.org/our-program/` (snapshot 20160322105717, **not fetched**; 648 archived URLs exist)

**Free-skool history and course examples (secondary, not fetched as catalogs):**
- Toronto's Anarchist Free School — Fifth Estate, Summer 1999 — https://fifthestate.anarchistlibraries.net/library/353-summer-1999-torontos-anarchist-free-school
- Toronto's Free School — Fifth Estate, Winter 2013 — https://www.fifthestate.org/archive/388-winter-2013/torontos-free-school/
- Anarchist Free University, Toronto — LocalWiki — https://localwiki.org/toronto/Anarchist_Free_University
- ANARCHIST U FREE SCHOOL: An Engaging Alternative to Consumer Education — The Mindful Word, 2007 — https://www.themindfulword.org/2007/anarchist-u-free-schools/
- Spaces of Learning: The Anarchist Free Skool — Alliance for Self-Directed Education — https://www.self-directed.org/tp/spaces-of-learning/
- Grow Your Own Free Skool! guide and zine — It's Going Down — https://itsgoingdown.org/grow-your-own-free-skool-guide-and-zine/
- Toronto's Free Schools, It Takes a Community — Toronto Media Co-op — https://toronto.mediacoop.ca/story/torontos-free-schools/16025


**Artefacts produced (`scratchpad/research/r5_skills/`):**
`skills-seed.jsonl` (525 records) · `stats.json` · `provenance.json` · `taxonomy.py` · `nodes.py` · `prune.py` · `fetch_esco.py` · `esco_match.py` · `make_review.py` · `esco_decisions.tsv` · `resolve_decisions.py` · `fetch_wikidata.py` · `wd_pick.py` · `wikidata_overrides.tsv` · `verify_wikidata.py` · `wikidata_handchecked.tsv` · `build_seed.py` · plus caches (`esco_cache.json`, `esco_groups.json`, `esco_decided.json`, `esco_auto.json`, `wikidata_cache.json`, `wikidata_verified.json`, `esco_gap_probes.json`) and the review artefacts (`review.txt`, `review_index.json`).

---

## Confidence / not verified

### Verified

- **Both APIs are live and were hit directly.** Nothing in the ESCO or Wikidata columns comes from memory; every URI and QID is in a cache file with the response it came from.
- **All 159 ESCO mappings are exact (53) or hand-read (106).** I read the entire 387-node review band plus ~40 targeted probes. The 106 hand decisions are individually listed in `esco_decisions.tsv` and all 106 resolved to live URIs with zero unresolved.
- **Shipped ESCO URIs resolve.** A seeded 8-URI spot-check re-fetched each `externalIds.esco` from `/resource/skill` and compared the live `title` against the label recorded in provenance: 8/8 resolved HTTP 200 with the exact expected label (`repair plumbing systems`, `join wood elements`, `operate sound live`, …).
- **87 Wikidata QIDs hand-verified** via `wbgetentities` with label, English description and P31/P279, in three passes: a 20-node random sample (seed 20260912 — reproducible) in which **all 20 were correct**; 37 hand-picked sense corrections, all confirmed correct; and a targeted sweep of the **30 highest-ambiguity unchecked picks** — every node where 3 or more Wikidata items carry our label exactly, which is where a wrong sense is most likely. All 30 were the correct topic sense (`knot`, `seed`, `fence`, `Arduino`, `pottery`, `OpenStreetMap`, `blacksmith`, `chicken`, `beehive`, `cobbler`, …); not one was an album, film, municipality or taxon. Recorded in `wikidata_handchecked.tsv`. The overrides file records 14 further labels where I concluded **no** acceptable Wikidata item exists.
- **The twelve `total: 0` ESCO gap claims** are raw API responses saved in `esco_gap_probes.json`.
- **Referential integrity** is asserted at build time: every `broader` and `prerequisites` target resolves to an id in the file; slug uniqueness is asserted at parse time.
- **The emitted file validates clean**: all 525 lines parse as JSON, carry the eight required fields and the correct `$type`, use unique kebab-case ids, a `status` in `{canonical, proposed}`, only `esco`/`wikidata`/`onet` keys in `externalIds`, `Q\d+`-shaped QIDs and `http://data.europa.eu/esco/skill/…` ESCO URIs. Zero problems.
- **ESCO licence wording** is quoted from ESCO's own FAQ and copyright-notice pages, not paraphrased.

### Not verified / known weak

- **330 Wikidata QIDs were not hand-checked.** Three clean passes (20 random + 37 corrections + the 30 most ambiguous, 87 for 87) point to a high hit rate, but 84 clean checks only bound the error rate loosely; a few percent of the remaining 330 being a wrong sense is entirely consistent with what I saw. The riskiest band is largely cleared. Of the 330 unchecked, **~250 are `ambiguity: 1`** — only one Wikidata item carries that label at all, so there is no competing sense to get wrong — leaving **52 at `ambiguity: 2`** and **27 still at `ambiguity: 3+`** as the queue a reviewer should work first. `provenance.json` carries the flag per node. Two I already know are shaky and would rather flag than quietly keep: `urban-foraging` → Q136706446 and `power-mapping-and-target-research` → Q2106994 (the Wikidata item *Power Structure Research*), both items with no English description; I set both labels to `none` in the overrides, so neither QID ships.
- **`status: proposed` conflates two different things.** It means "no ESCO concept passed verification", which covers both genuine ESCO gaps *and* my matcher's failures. I can partly separate them: 38 proposed leaves returned **zero** ESCO results for their core keyword, and **15** had a ≥0.70 near-miss that I rejected by hand as not equivalent. But about 229 had ESCO results with nothing close, and a second reviewer would likely rescue some — `build-furniture`, `brew-beer`, `make-wine`, `write-code`, `build-a-website`, `weave-cloth`, `crochet`, `spin-yarn`, `frame-walls-and-partitions` and `service-brakes` are all cases where I suspect a better ESCO concept exists and my queries or my strictness missed it. **Treat 34% as a floor on ESCO coverage, not an estimate.**
- **Wikidata QIDs are topic anchors, not skill identities** — 402 of 417. Only 15 have a label identical to ours. Do not render a QID as "this skill is X"; render it as "related concept". The `relation` field in provenance says which is which.
- **49 descriptions are placeholders** that literally say the description needs writing. 400 more are Wikidata descriptions of a *related* concept. Only 60 are authored for this taxonomy. **This seed is structurally good and editorially thin** — the descriptions need a human pass before they face a learner.
- **ESCO's hierarchy is recorded but not used.** The brief asked to use ESCO's broader relations where they exist. I judged that wrong for this use and documented why (ESCO's cut is sectoral; `S5 handling and moving` is our largest bucket). If you disagree, the full root-walked chains are in `provenance.json` and a variant tree can be generated from them without refetching anything.
- **525 nodes against a ~400 target.** I pruned a 685-node first draft down with an explicit, reviewable drop list (`prune.py`, 185 entries), landed on 500, then added 25 more (and one whole area) grounded in fetched free-skool catalogs. I stopped there rather than cutting further because every node is individually reviewable and marked. Flagging the overshoot rather than hiding it.
- **`prerequisites` is effectively unexercised.** The field is implemented, validated and empty — the one demo edge I drafted was redundant and got pruned. Prerequisite edges are a real modelling job (and arguably belong with levels on events, not on skills) and I did not attempt them.
- **No O*NET codes.** `externalIds.onet` is in the record shape and is populated nowhere. O*NET has its own API requiring registration; out of scope here.
- **Single-language.** Labels and descriptions are English only, though ESCO's `preferredLabel` ships ~27 languages per concept and is cached in `esco_cache.json` — multilingual labels are available for free from data already on disk whenever that becomes a priority.
- **Nine of my proposed nodes are not attested in any catalog I read.** `lockpicking` (not in the seed), `flintknapping-and-stone-tools`, `hide-tanning`, `brain-tanning-and-buckskin`, `build-a-composting-toilet`, `cob-and-earthen-building`, `straw-bale-construction`, `death-doula-and-end-of-life-support`, `self-managed-and-diy-gynaecology`, `dumpster-diving-and-food-recovery` and `alley-cat-races-and-critical-mass-rides` appeared as class titles in **none** of Santa Cruz, EXCO, Montreal, Bloomington, Firestorm or Toronto. They are in the seed because I believe they belong there, which is a different warrant from the rest. Prune these first if the seed needs cutting.
- **The curriculum evidence is six projects deep but geographically narrow.** Verified catalogs: Free Skool Santa Cruz (4 sessions, live), EXCO Twin Cities (archived, plus 908 unscraped class pages), Montreal Anarchist Bookfair (2002–2017, archived), Bloomington Free Skool (2011, archived), Firestorm Asheville (live iCal). All are North American, mostly white-led anarchist scenes; none is in the Global South, and Boulder specifically is unrepresented. Partially verified: QPIRG McGill/Concordia (one page fetched; dozens of skillshare posts CDX-indexed but unfetched). Not verified: **Brooklyn Free School** (K–12 democratic school, no public catalog), **Free Skool Olympia** (one image-only PDF remains unfetched), **Toronto's Anarchist Free University** (course list is **secondary** — from Fifth Estate, LocalWiki and The Mindful Word, not a fetched catalog). And `baltimorefreeschool.org` **no longer resolves** at all. Three Santa Cruz quarters (Spring 2012, Summer 2012, Winter 2013-14) also remain unfetched.
- **The 25 catalogue-grounded nodes were added late and got lighter scrutiny** than the original 500: their QIDs come from one SPARQL/search pass with six hand corrections (`drag (entertainment)` → Q337084 *drag queen*; `hand-poked tattoo` → Q43006 *tattooing*; `free school` → Q17014717 *Free school movement*, away from Q5500295, the UK state academy; `language exchange` → Q17084569 *tandem language learning*; `adult literacy` → Q8236 *literacy*; `working bee` → none), and none of the 25 was in the random verification sample.
- **A practical note for whoever extends this.** `WebFetch` is blocked for `web.archive.org` — use `curl`, and go sequential because archive.org rate-limits. Firestorm's HTML calendar sits behind a bot wall but `https://firestorm.coop/calendar.ics` is open. Free Skool Santa Cruz changed its HTML title markup three times across eras, so a scraper needs three selectors.
- **ESCO v1.2.1 is a moving target.** URIs are stable across versions by design, but concepts are added and deprecated. The fetch used `viewObsolete=false`. A periodic re-resolution job would be wise.
