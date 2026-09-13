---
title: "Regen Hub Working Session \u2014 ATProto Architecture, Naming, and the Co-op Question"
date: "2026-09-11"
type: "report"
attendees: ["Benjamin Life", "Lucian Hymer", "Aaron Gabriel Neyer"]
location: "Regen Hub, Boulder, CO"
source_transcript: "vault/projects/local-alternatives/meetings/2026-09-11_lucian-aaron-pds-roadmap-lexicon-governance-and-the-techne-coop-question"
projects: ["local-alternatives", "regen-hub", "techne"]
status: "draft"
parachute_path: "vault/agent/reports/2026-09-11_regen-hub-atproto-session"
parachute_id: "2026-09-12-17-11-09-756225"
tags: ["atproto", "local-alternatives", "regen-hub", "report", "techne"]
---

# Regen Hub Working Session — ATProto Architecture, Naming, and the Co-op Question

**Date:** September 11, 2026, 1:36 PM  
**Location:** Regen Hub, Boulder, CO  
**Attendees:** Benjamin Life · Lucian Hymer · Aaron Gabriel Neyer  
**Source:** [[vault/projects/local-alternatives/meetings/2026-09-11_lucian-aaron-pds-roadmap-lexicon-governance-and-the-techne-coop-question]]

---

## Overview

A long working session at the Regen Hub — half a technical walkthrough of the ATProto stack Lucian has been building, half an unresolved argument about what legal and organizational shape Techne should take. Several concrete things landed: the backend platform will be renamed **Syntropic** (dropping "Regen OS"), Benjamin gets a sandbox PDS to start building the free-school app independently, and the cooperative-as-primary-vehicle direction is agreed on in principle — but sequenced after the foundation raises. The GTC token swap idea for patronage shares was the most generative new concept to surface.

---

## 1. Infrastructure Roadmap

Lucian's read on the sequencing:

- **Q3 → Q4:** Have a really good PDS, build a lot on top of it themselves, land local Boulder developers on it. A few different apps running against one shared PDS. Stay focused — don't try to run the global firehose yet.
- **End of Q4 → Q1:** Federation arrives. Easy self-hostable PDS images. Make the "own your own information" promise real in the roadmap even if it's not the day-one offering, so people trust the architecture.
- **Global firehose:** Deferred. Connecting to it mainly buys events created elsewhere on ATProto, at the cost of running infrastructure comparable to an Ethereum node. Worth it eventually; not the priority.

Benjamin pushed the **nested-scales federation** idea: a bioregional or ecoregion node that federates a sub-network sharing data peer-to-peer, with one heavier node bridging to the global firehose. This directly addresses a standing ATProto community complaint that it's "global or nothing." Lucian thought it would make waves in the protocol forums. The idea: geographic-scope apps like Beacon or Actualize only need to index a firehose relevant to their region — the outer node selectively relays global signals, the inner nodes share directly.

**Almanac data pipeline** is already running every 15 minutes: Overture places (open-source Google Maps alternative), Secretary of State data, Spirit of the Front Range events, survey data — all importing into the data lake and publishing to ATProto via Lucian's publisher. This is the infrastructure that makes Beacon work.

---

## 2. Lexicon Governance

Lucian has been suffixing new data types `.draft` (e.g., `co-op.lexicon.draft`) to allow iteration and normalization before committing to canonical forms. Both liked this.

The longer-term vision: the **cooperative formally manages canonical lexicons** — with a real proposal process — rather than relying on PRs to Bluesky's repo where their team decides at their discretion. As Lucian put it: "Co-op just is DAO but not a dirty word." Same governance challenges apply (avoiding politics, defining clear rules for when to extend a record vs. attach a sidecar), but the legitimacy and process are ours to design.

The currently unresolved question: the rule set for **when to extend a record versus attach a sidecar**. Benjamin named this as the thing that makes him nervous building deep against the architecture — the answer isn't fully specified and a wrong call early means scrapping a branch of work. Lucian's custom event types compose the community lexicon event record so Techne events stay interoperable with SmokeSignal and Dandelion while carrying extra detail those apps could adopt.

---

## 3. Spaces and Permissioned Data

Lucian walked through the spaces architecture — the most technically significant piece of the session:

- **Public data** goes through the firehose as normal.
- **Permissioned data** skips the firehose and lives in spaces — shared permission sets with **read / write / manage** levels. Apps index whatever is relevant (public or private) the same way.
- Anyone can write any record into their own repo and label it with any space key — the architecture is permissionless at the record level. **Verification moves to the edges:** check provenance (that the author had permission at the time), optionally layer verifiable credentials.
- Lucian is implementing ATProto's permissioned-data spec ahead of official PDS support. Right now permissioned data writes directly to the index (not through the PDS, which doesn't support it yet), but following the spec.

The most exciting capability: **publicly declared algorithms over lexicon types** that each user combines with their own permissioned records, producing feeds that are individually tailored in a way that structurally prevents capture — the indexer can't see the permissioned half that tunes the result. This is the architecture that makes anonymous host/skill feedback possible in the free-school app.

**Portable export:** Public data exports as a single SQLite file. Permissioned-data export isn't solved yet — flagged as something to address during a future migration step.

---

## 4. The Co-op Question

Aaron's argument: The Techne Foundation and the Regen Hub cooperative are deeply entangled. The co-op's members are essentially the foundation's people. All six board members (Benjamin, Lucian, Aaron, Kevin Owocki, Jon Bo, Todd Youngblood) are aligned with the Techne vision. Nobody on that board is passionate about running a co-working space. His preference: the **foundation funnels money into the cooperative**, which does the day-to-day and builds Beacon under contract — dogfooding cooperative infrastructure by being a cooperative — and which unlocks the `.coop` domains they already hold.

Lucian agreed directionally but doubts it happens before the foundation raises, since it would mean the Gitcoin community voting to fund a co-op rather than Kevin. He also couldn't see why a for-profit entity is needed alongside a 501(c)(3) if Techne is explicitly not exiting.

**Benjamin's synthesis:** The foundation grants to the co-op to produce lexicons and open-source software. The co-op spins out further cooperatives whose service businesses monetize the stack — e.g., last-mile food delivery running on a food lexicon, or a disaster-response coordination stack built from Eric Boyer's knowledge that the City of Boulder would plausibly pay for. The co-op as flywheel-starter.

**MacGuffin insight:** Each product (Beacon, the free-school app) is a MacGuffin — a plot device. Beacon existing is what lets Benjamin go convince every events platform in Boulder to publish into the same data architecture. The app is almost secondary to what it enables strategically: getting everyone to converge on shared lexicons. Techne is less about shipping apps and more about how the software shifts other software providers into a network effect.

**On the for-profit entity:** All three agreed it seems unnecessary if exit is off the table. The talent gets paid; the co-op can do that. The only scenario where a for-profit makes sense is if a spinout business wants to exit independently — which is fine as a specific case, not as the parent structure.

---

## 5. The GTC Token Swap

Benjamin floated: what if Gitcoin token holders could swap GTC for **patronage shares** in the co-op?

Current problem: GTC is essentially a meme coin. The only thing holding its value is community belief in Kevin. Token holders have no real asset, no dividends, no roadmap connection.

Patronage shares would:
- Connect holdings to a real roadmap with upside
- Give holders dividends as the co-op generates revenue
- Reduce liquidity (a downside), but create genuine asset value
- Let Kevin's large holdings become patronage shares in something he already believes in

Aaron's note: **convert before traction** — moving wealth now at a $5M valuation is very different from after the token appreciates. The timing matters. Offering the swap could cause the remaining token price to go either direction depending on how it's framed.

This idea is generative but requires Kevin's buy-in and some traction proof-points first. Not ready to act on — but worth developing.

---

## 6. Naming — Regen OS → Syntropic

**Regen OS** is agreed to be the wrong name for the backend. Kevin has been leaning toward **Syntropic**, and all three liked it:
- Describes what the thing does (syntropic: forming new complex order through information exchange)
- `syntropic.org` is available for ~$1,500 — a one-time purchase, then cheap annual renewal
- As Benjamin noted: "It's a shot across the bow at Anthropic"

**Lexicon and identity namespace strategy:** Benjamin wants these to read as neutral standards rather than branded Techne assets. Lucian favors `co-op.lexicon` (or `coop-lexicon.coop`) as the canonical namespace — handled through the co-op, giving it real governance weight. Aaron flagged caution about using the core handle domain for user handles (you lose those handles forever to users).

`api.coop` and `mcp.coop` were both surfaced as excellent domain candidates for the commons infrastructure. `id.vu` (Uruguay's TLD) at $2,700/year was considered but likely premature. **`lexicon.coop`** was the strongest candidate for the canonical lexicon namespace.

---

## 7. Repo Situation

The RegenOS monorepo is getting unmanageably large as more apps pile in. **Lucian needs to split it** before there's a clean public surface to point developers at. Currently everything is technically accessible (there's an MCP server, identity creation, record CRUD, higher-level convenience methods) but the repo structure makes DevEx impossible. Aaron proposed taking developer experience and communications as his role within Techne — podcast, writing platform, documentation, relationship-building.

---

## 8. Adjacent Threads

**Dandelion / Stephen Reid:** Benjamin talked to Stephen on Tuesday. He's game to collaborate. Current state: one-way publish — events from Techne can be published to ATProto but Dandelion doesn't list other ATProto events. No bi-directional sync yet. A few days of work to fix. Benjamin will connect Lucian with Stephen.

**DIDComm / Kaliya Young:** Kaliya sent Benjamin a detailed email about DIDComm — substrate-agnostic, DID-to-DID verifiable credential exchange. Key signal: the Linux Foundation is reportedly adopting it at the kernel level to enable cryptographic signing of code contributions by human and AI developers. Lucian wants to see it — it sounds similar to PGP keys. Benjamin's read: ATProto's trade-offs are right for social tech; DIDComm's maximalism isn't necessary, but the Linux Foundation signal is significant. Benjamin will forward the email to Lucian.

**Zero-knowledge collective credentials:** Lucian surfaced the idea of signing in as a verified member of a collective without revealing which member — a group of DIDs issuing a credential together. Relevant for cooperative governance and anonymous feedback systems. "Pretty cool and not that hard to implement."

**Free-school app:** A contact from the COhere space is building a skill-sharing app — profiles with skill badges (attestations from events attended or peer attestations), anonymous feedback on hosts, local community instances that share skill attestations across moves. Benjamin can start hacking on this tomorrow against Lucian's sandbox PDS, using his own draft lexicons. This is the first independent build — not waiting on Gitcoin budget approval.

**Turtle Island Bioregional Congress (Oregon):** Benjamin heads there the following Tuesday through Saturday. Distributed protocols for local resilience mastermind follows at an eco-village in the gorge (Saturday–Monday). Neither Lucian nor Aaron can make it. Context: the conference itself rejected the grassroots-tech track; the mastermind is the spillover organized by a sponsor who'd read Benjamin's "Protocols of Place" essay.

**November builders' retreat:** Around Internet Identity Workshop / Funding the Commons, people working on verifiable credentials and ATProto want a focused immersion hackathon in the woods. Looking for a sponsor. Benjamin's framing: Techne could "own the ATProto space" the way Gitcoin came to steer Ethereum — by funding the ecosystem and becoming the most well-funded dev shop building on it.

---

## 9. Fundraising Narrative

The target donor profile: philanthropic tech people who feel guilt about what their contributions have done to society. Tristan Harris and Justin Rosenstein were named as examples. The pitch:

> This isn't building one behemoth platform to go head-to-head against Meta. That would cost billions. This is the Ikea/Keto investment — shifting the incentive landscape that allowed network monopolies to form in the first place. A coalition of groups adopting shared lexicons, chipping away at the monopolies' position through non-enclosable infrastructure. The coldest start problem is solved by interoperability — each new adopter makes the whole thing more valuable.

The key unlock: **Emma needs to be able to sell this story.** As Lucian put it bluntly: once she can sell it, everyone else stops questioning it. Until she can sell it, the entire team keeps having the same uncertainty conversations.

Benjamin's crypto post-mortem essay frames part of the value prop: here's what crypto was trying to do, here's what failed, here's why cryptography is still the essential primitive — but for portability and author-trust, not trustless smart contracts for social interaction.

---

## 10. The Shell Cooperative

Aaron's proposal for Jeremy: create a worker cooperative called **the Shell** — Terrible Turtle Burning Man camp's operational entity, doubling as a software dev shop for festival technology and mesh-network wearables. If Jeremy does it, the Shell gets `shell.coop` as a domain. The camp becomes a vehicle for worker ownership and a proving ground for Techne cooperative infrastructure. Aaron sees this as something the first floor of the Regen Hub building could house — a more interesting use case than growing co-working desk MRR.

---

## Key Decisions

1. The backend platform name is **Syntropic** (replacing Regen OS). `syntropic.org` (~$1,500) is the candidate domain.
2. Benjamin gets a **sandbox PDS** to build the free-school app against, using his own draft lexicons.
3. New lexicon types carry a **`.draft` suffix** until normalized; the cooperative is the preferred long-term canonical lexicon steward.
4. Techne's custom event type will **compose the community lexicon event** to stay interoperable with SmokeSignal and Dandelion.
5. **Foundation funnels money into the cooperative** as the operational and building entity — directionally right, sequenced after the foundation raises.
6. **No for-profit entity** needed alongside 501(c)(3) unless a specific spinout wants to exit.
7. Lucian will **split the RegenOS monorepo** before exposing a public developer surface.
8. **GTC token swap for patronage shares** is a generative idea worth developing — not ready to act on yet.

## Open Questions

- When does the foundation raise, and how does the Gitcoin community decision process work for funding a co-op rather than Kevin directly?
- What are the rules for extending a record vs. attaching a sidecar? Needs a written spec.
- Which domain becomes the canonical lexicon namespace (`lexicon.coop`, `api.coop`, or `org.techne`)?
- Does Kevin buy the `.coop` domain strategy, or does he still think it reads as "too hippie"?
- How soon can the GTC token swap be put in front of Kevin, and what traction proof-points are needed first?
- Can Lucian and Aaron make the November builders' retreat, or is it just Benjamin?

## Action Items

- [ ] **Benjamin** — Forward Kaliya Young's DIDComm email to Lucian
- [ ] **Benjamin & Aaron** — Finish and publish the "Protocols of Belonging" essay
- [ ] **Benjamin** — Pitch Kevin on sponsoring the November ATProto / verifiable-credentials builders' retreat
- [ ] **Benjamin** — Equip Emma with the fundraising narrative so she can sell the infrastructure story to funders
- [ ] **Benjamin** — Finish the crypto post-mortem essay ("Crypto is Dead, Long Live Crypto")
- [ ] **Benjamin** — Connect Lucian with Stephen Reid on bi-directional Dandelion / ATProto event sync
- [ ] **Lucian** — Split the RegenOS repo; secure lexicon / API domains; write for the ATProto forums
- [ ] **Aaron** — Propose the Shell worker cooperative to Jeremy
