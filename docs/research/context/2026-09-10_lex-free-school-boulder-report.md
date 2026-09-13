---
type: "report"
title: "Lex / Free School Boulder: skill-share network, open-source app, tag-routed calendar interoperability, COhere launch \u2014 2026-09-10"
date: "2026-09-10"
author: "Benjamin Life (@omniharmonic)"
status: "complete"
source_transcript: ["vault/projects/local-alternatives/meetings/2026-09-10_free-school-opening-conversation", "vault/projects/local-alternatives/meetings/2026-09-10_free-school-boulder-app-and-calendar-interoperability", "vault/projects/local-alternatives/meetings/2026-09-10_voice-note-tool-libraries-and-pooled-purchasing"]
interviewee: "Lex (Free School Boulder; full name not stated in transcript)"
interviewee_type: "community-steward"
projects: ["local-alternatives", "RegenOS"]
speaker_inference: "Main transcript: Speaker 1 = Benjamin Life, Speaker 2 = Lex; opening fragment labels reversed (Speaker 1 = Lex). Identity 'Lex' from Benjamin's calendar entry 'Lex Free Skool'."
speaker_confidence: "high"
parachute_path: "vault/projects/local-alternatives/reports/2026-09-10_lex-free-school-boulder-report"
parachute_id: "2026-09-10-23-56-32-342550"
tags: ["interview", "local-alternatives", "report"]
---

# Lex / Free School Boulder: A skill-share network that wants an open-source app, tag-routed calendar interoperability, and COhere as its launch — 2026-09-10

*Prepared by Benjamin Life (@omniharmonic) · 2026-09-11 · Source transcripts: [[vault/projects/local-alternatives/meetings/2026-09-10_free-school-opening-conversation]] (part 1 of 2), [[vault/projects/local-alternatives/meetings/2026-09-10_free-school-boulder-app-and-calendar-interoperability]] (part 2 of 2, main interview); context: [[vault/projects/local-alternatives/meetings/2026-09-10_voice-note-tool-libraries-and-pooled-purchasing]] (Benjamin's solo voice note recorded on the way to this meeting) · Speaker inference: in the main transcript Speaker 1 = Benjamin Life, Speaker 2 = Lex (high confidence). In the two-minute opening fragment the labels are reversed — Speaker 1 there is Lex ("I'm back in town... from Hygiene"), Speaker 2 is Benjamin (medium-high confidence). A handful of lines in the main transcript are mis-assigned by the diarizer (e.g. "I'm a good mama" and "has your dad gone through yet?" are attributed to Speaker 1 but read as Lex); no third voice detected.*

**Identity note.** The counterpart's name is not spoken in any of the three recordings. The identification as "Lex" comes from Benjamin's own calendar entry ("Lex Free Skool", Thu 2026-09-10 13:00–14:00 MDT) and from his Sep 8 description to Julia Keller of "someone who's starting a free school" surfacing through COhere. No surname or organisation beyond "Free School Boulder" is stated; there is no person note for Lex in the vault. Lex states they own the domain freeschool.com and co-ran the Free School in Asheville, NC for two years.

---

## TL;DR

Lex is a post-burnout anarchist organiser, recently moved from an acre in Hygiene into a friend's backyard in South Boulder/Table Mesa, reviving the **Free School** — "a decentralized education empowerment network" — in Boulder. They co-ran the Asheville Free School for two years (welding, plumbing, chicken slaughters, hide tanning, natural painting; "my favorite community build project ever") and are currently running a bare Glide prototype: one admin, email registration, admin approval before a class hits a calendar. The Free School is explicitly anti-capitalist by rule (no charging for classes; donations for supplies only), explicitly political (so it cannot be a 501(c)(3)), and about to become the orchestrator of the **skill-share track at COhere**, which Lex intends to use as the launch moment and then sustain year-round between COhere pulses.

The single most important thing for RegenOS is that this conversation produced the clearest **real-world spec for tag-routed calendar interoperability** so far this week: keep the Free School calendar, the COhere calendar, and a future "punk rock community calendar" as *separate interfaces over shared event data*, with an event flowing to any of them based on tags (`skillshare` / `free-school`), in both directions, so organisers never face "where should I put this?" Aaron Gabriel Neyer is already building the COhere calendar and is the natural counterpart. Alongside that, Lex's needs are a textbook list of the social primitives ATProto lacks: vouch/referral-gated membership, graduated moderation, badges for attendance, anonymous feedback, and "guilds" (standing groups that emerge from skill clusters) — i.e. **the group as first-class citizen**, again.

**Interviewee type: community-steward** (not a technologist — "I don't know shit about anything... anything that had tech, I don't think"). The "app build" in the transcript title is Benjamin's commitment, not Lex's product.

Recommended next step: Benjamin builds Free School Boulder v1 as a free, open-source app targeted before COhere, using it as a **reference implementation of the RegenOS event lexicon plus a minimal group/membership model**, with Aaron Gabriel wiring the Free School ↔ COhere calendar flow. Lucian should treat the Free School as a concrete, low-stakes test bed for the group primitive.

---

## 1. Who they are and what they steward

**Person.** Lex describes themselves as "an out anarchist, anti capitalist" whose formative period was Asheville, ages 27–32 — anarchist worker-owned spaces (Firestorm Cafe and Books), collectives, living cheap. They came to Boulder unplanned ("I had accidentally had a kid here"; child is four, named Jasper), do construction/renovation and photography gigs, and have been "drowning in capitalism" — "just broke at the end of every fucking beginning of every month." They have now moved out of Hygiene (rural, on the road to Lyons) into a friend's backyard in South Boulder (the friend is Milan Ocean — "she's super solid") for two rent-free months to "get my bearings financially," and are re-emerging from several "retirements" from organising: "I'm post burnout... I'm just now being like, you know, I'm feeling a little bit energized. I want to get back involved." They are "only throwing myself into the Free School" and no other projects, with the explicit caveat "about my time and my life."

Lex has a strong aversion to "organizing orgs": "I'm not here to organize an organization... six months go by and we're like still fighting about the bylaws... the nonprofit industrial complex is eating itself already and we haven't done a thing." They had a bruising experience at the Anchor (hardware) community-build project with "Duffy," and are explicit that they don't want to create "another Climatique" (which they say is doing great and should be supported).

**The Free School.** Lineage: anarchist free-school pedagogy (Lex points Benjamin to the Wikipedia article on free schools, linked in the Free School group chat). Lex's own definition: "decentralized education empowerment network... ultimately it's a network." Core principles as stated:

- **Everybody's a teacher, everybody's a student.** "Anybody who knows anything about auto mechanic show up. And then by the end of a couple hours, everybody knows what everybody else knows." Horizontal skill transfer over facilitation.
- **Explicitly anti-capitalist by rule.** "You cannot charge money for any of them." Donations for *supplies* are fine (e.g. vegetables for a fermentation class); donations *for the class itself* are not: "that just gets icky too quick and then it just becomes an issue."
- **Explicitly political**, therefore "it can't be a 501C3. It could work under umbrella or something like that."
- **Radically open membership.** "If you say you're part of Free School, you're part of Free School. That's it." Existing clubs (sewing clubs, etc.) can join the network just by posting.
- **Accessible, not sectarian.** "It's an anarchist project but there's not any Circle A's... Anybody should feel like it's for them." In Asheville, "kind of like red right winger type of people" taught plumbing classes.
- **Analog at heart.** "It's kind of funny that it's an app because it's really kind of like an analog project" — zines, posters, laminated cards. The app is a calendar and a directory, not the thing itself.
- **Failure is normal.** "Sometimes free schools don't. Nobody comes, you know, and that's just part of it."

**Stage.** Pre-launch. The Glide prototype has one registered user (Lex), no real classes ("nothing's even plugged in for this month"), placeholder skills, a daily calendar view Lex doesn't like, and email-confirmed registration Lex adopted only because "I don't know how to gatekeep otherwise." Echo (a local volunteer who also volunteers at Food Rescue, did Food Not Bombs for a while, and is building a "free food" delivery-by-bike project) built the Glide app as a favour; Lex says Echo's "eyes don't light up the way your eyes light up on this project" and has ~30 other projects. A Free School group chat exists (Benjamin was added during the meeting; Echo is deliberately not in it). Lex owns **freeschool.com** and imagined a Craigslist-style per-city subdomain structure. Benjamin's read on Glide: it was the right tool for non-technical builders before AI, but "now non technical people can just build it themselves" — so the prototype is disposable, and Lex confirmed "I'm not committed to Glide."

**Funding.** None. The Free School collective should be able to accept donations, but not per class. Benjamin offered fiscal hosting via the climate 501(c)(3) (Spirit of the Front Range context: "peer to peer neighborhood resilience stuff"): a separate bank account, donations tax-deductible, Free School as a fiscally hosted project. Lex: "I have no idea how to do that... I'm in. Let's do it."

**Deeper motivation.** Lex frames the Free School as resilience-building and dual power: "an unspoken intention of it... is to build that resilience even if people don't even know it... who's the go to person for water filtration, who's the go to person for blah blah blah... all these necessary skills for survival and then this dual power." They expect "car camps, tent cities... the housing market's about to crash" and see "the Free School, the Regen Hub, Hive, Climatique" as the infrastructure that has to exist before that. They mentioned an encampment at Central Park ("it can turn to an occupation pretty quick") and planned to go check on it after the meeting; Benjamin: "I've been waiting for it to happen."

---

## 2. Their pain points and needs

### (a) Technical needs (stated or agreed in the conversation)

1. **A calendar that is the Free School calendar** — "what I want the calendar to actually be is the Free School calendar." Simple: post a class, pick a space, pick a time, list materials.
2. **Profiles with listed skills**, browsable by skill ("who knows about bicycle repair?" → list of people).
3. **A "needs list" / bulletin board.** Lex's "number one thing": points of entry. "I would love to see this class" → "I can do that class" → "I'll help you coordinate a class if you do it." Auto mechanics is "literally my example."
4. **Gatekeeping without email registration.** Lex wants to "slow it down a little bit" on profile creation while keeping the calendar and all classes fully public. Agreed direction: vouching and/or referral invite links ("anyone can create an invite link and send it to their friends so that you keep it kind of trust based"). Benjamin floated "in order to create a profile you have to have gone to one Free School session."
5. **Moderation that graduates.** Admin approval for new posters, lifting once someone has hosted enough classes. Lex: "Absolutely."
6. **Privacy and anti-spam.** "I want some sort of data privacy stuff. I want to know user privacy. I want to know how to despam."
7. **Badges / attendance records.** Host checks off who actually came; attendees get a badge. Lex's reference is Couchsurfing: "you gotta get a certain amount of vouchers and then you get a badge... that means that you are who you say you are."
8. **Anonymous feedback** as culture, not rating: "any interactions we have, we always have like a little link... anonymously... this stays totally internal." Both explicitly rejected Uber-style star ratings.
9. **No transactions in the app.** Agreed. Open design question: a per-class "Venmo for supplies" field vs nothing (risk of it becoming a de facto suggested-donation ticket).
10. **Newsletter / email list**, at least monthly ("upcoming classes, that's it"), plus possibly a members' Signal chat.
11. **Admin dashboard** so Lex never touches code — Benjamin's framing: "you have all the tools inside of the tool."
12. **Automation of busy work.** Benjamin: "once it's on it should just be on... notifying people." Lex: "I want that... it's just not my wheelhouse at all."
13. **Calendar interoperability** with COhere and other Boulder sources (see §3).
14. **Replicability.** Benjamin's addition: make it trivially forkable for other cities; Lex's freeschool.com / per-city idea fits.

### (b) Social/organising needs

- **Culture-building from zero.** "Now we gotta create a culture for that to pick up here." The first hurdle is "getting people interested in that or even understanding how to... oh, I can host this." People are "so intimidated by it."
- **A core collective** ("some sort of core Free School organizers that are steering it") that facilitates logistics — park permits, tables, promotion — without becoming an org.
- **Monthly rhythms**: potluck, auto-mechanic meetup, bike stuff — "Free School-y things" that could, over a year or two, become an auto-mechanic collective and eventually "a community garage."
- **Momentum continuity after COhere.** "Whatever COhere builds, I want that momentum. I want opportunities for that momentum to continue on throughout the year." Lex's concrete mechanism: COhere (a 10-day event, per Lex) hosts "micro little sessions" — "I'm doing a 30 minute one now, I'm gonna do a three hour version on this on the Free School on this day" — and the email list captures the people who want the longer version. "COhere could just be this massive fucking push for the Free School." Lex also said "basically I'm going to pivot everything to COhere" and floated simply using or renaming the COhere calendar for the Free School, before accepting Benjamin's separate-interfaces model.
- **Clarity on their COhere role.** Lex was "voluntold" by Eileen to run the skill-share track and did not yet know what COhere is or what they are responsible for ("is my job to get all those slots filled?"). Benjamin: no — it's an unconference, "a potluck for a conference."
- **Bike-punk culture**: alley cat races (a "radical history of Boulder" alley cat with stations, laminated cards, zines), critical mass; Benjamin pointed them at the existing Thursday cruiser rides, which Lex immediately wanted on the calendar.

### (c) Resource/funding needs

- **Fiscal hosting** for collective donations (offered by Benjamin).
- **Lex's own runway** is the binding constraint: two rent-free months, gig work, a four-year-old. Any plan that depends on Lex doing admin work at volume is fragile — which is exactly why automation and the admin dashboard matter.
- **Promotion support** ("advertising is the wrong word because there's no money"): posters, zines, the newsletter.

---

## 3. Where RegenOS / ATProto fits (and doesn't)

### Integration surfaces

**How Benjamin framed his role.** Benjamin told Lex he walked away from OpenCivics after burnout — a 150-person community with "great vibes" and a clear intention that "stayed pretty abstract and theoretical" — and chose to focus "locally with real people and real relationships." He is now working with Kevin Owocki again (Benjamin, Kevin, and one other person still at the Regen Hub were its founders); Kevin's prior crypto grants platform funded open-source and climate projects, but with crypto now "a cesspool of meme coins" that "the banking system just ate," Kevin is using the remaining treasury for "local first community tech" — tools for communities that "plug into each other like Lego blocks." Benjamin described himself as a community liaison: "they have engineers that are just like ready to build stuff for community, and I'm doing the outreach of weaving the local projects that either already have tech that we could make more interoperable or people who are trying to build things that they need support." ATProto was pitched as the Bluesky substrate: your data on their server until "as soon as I don't like what they're doing, I can just take all my information and move it." Lex's response was enthusiasm without evaluation ("Yeah, I'm stoked").

**Events lexicon and multi-calendar routing (primary).** This is the most direct RegenOS surface of the week. Benjamin laid out the architecture and Lex agreed to it on the spot:

> Benjamin: "I would say don't have them be the same app or the same interface, but make them able to talk to each other."

> Benjamin: "It's one thing for all the Free School calendar items to show up on the COhere calendar, but what if whenever Climatique is hosting an event, it automatically goes to the COhere calendar, but then if they tag it with Skillshare or Free School, then it also populates. So it goes both ways... there's not like duplication where it's like, oh, where should I put this? It's like, no, it can be on all of the platforms, depending on what the tag is."

> Lex: "That was my big concern... I wanted it to be the punk rock community calendar. Meaning that there could be things that aren't necessarily in the definition of Free School, but it's still about people plugging into basically leftist projects."

Concrete data-model implications for the RegenOS event lexicon:
- Events need **tags/categories as a first-class, queryable field** (`skillshare`, `free-school`, `cohere-2026`), not free text.
- Events need a **source/publisher** identity (which calendar/collective created it) so a view can filter "just Free School."
- **Bidirectional routing by tag** implies a view subscribes to a feed filtered by tag, rather than events being "sent" to calendars — this is exactly the app-view pattern, and it is the same conclusion Juicy reached (the blocker is the shared event/place data model, not transport).
- Recurring events (Thursday cruiser rides, monthly potluck, monthly auto-mechanic meetup) must be representable.
- Membership in the Free School network is declared by posting with the tag ("you just post it, you're part of Free School"). That is an interesting, ultra-low-friction group model worth noting: **group affiliation as a claim on the event record**, verified socially rather than cryptographically.

**Group primitive (the known #1 gap).** Nearly everything Lex wants beyond the calendar is a group feature: vouch/referral-gated profile creation, graduated moderation, host-attested attendance badges, internal anonymous feedback, and guilds/collectives forming from skill clusters. None of that exists in ATProto today. This makes the Free School an unusually good **test bed for whatever group primitive Lucian/Aaron adopt** (The Arbiter, Project Weave), because the stakes are low, the community is small, and the steward is enthusiastic and non-technical (i.e. the tool has to just work). Kaliya Young's verifiable membership credentials map directly onto "you gotta get a certain amount of vouchers and then you get a badge."

**Profiles + skills.** A skills list on a profile is a small lexicon that RegenOS could publish once and reuse (Free School, Backyard Farm Network, tool libraries, COhere participant profiles). Cross-app reuse of a "skills I can share" record is precisely the Lego-block story Benjamin pitched.

**Hosting tier.** The Free School is the archetypal "home Pi / Regen Hub" tier from the Juicy conversation: tiny, values-driven, allergic to platforms, no budget. It should be a demonstration that a community can run its own PDS cheaply.

**Identity.** ATProto's public DID index / correlation surface is a live concern here, not a theoretical one: Lex's network explicitly includes people in "a lot of legal trouble" over Palestine solidarity, anti-fascist organising, and "encampment... occupation" activity, and Lex references the green scare as the lineage's trauma. Benjamin pitched ATProto to Lex purely on data portability ("as soon as I don't like what they're doing, I can just take all my information and move it"); he did not mention that repos are public and DIDs are globally indexable. Lex's stated requirements ("data privacy stuff... user privacy... despam") are compatible with public *events* but not necessarily with public *membership graphs*. Beacon-style private data stores may be needed for profiles/vouches/feedback while events stay public.

### Objections and pushback

Lex raised no technical objections — they cannot evaluate the stack and said so. Their objections are cultural and structural, and they matter for RegenOS's go-to-market posture:
- **Anti-money.** No transactions, no per-class donations, no monetisation of any kind. Any RegenOS/Locus feature that nudges toward ticketing would be rejected.
- **Anti-org.** Anything that requires the Free School to become a legal entity, sign agreements, or "fight about the bylaws" is a non-starter. Fiscal hosting under an existing nonprofit was accepted precisely because it avoids that.
- **Anti-hero / anti-gatekeeper.** "Let people do it how they need to do it... being the fucking gatekeeper... pisses me the fuck off." RegenOS tooling for this community must not centralise control in a platform or in a single admin (including Lex, who is uncomfortable being the only admin).
- **Tech skepticism as a running joke** ("Is it going to steal all my data too?"), which Benjamin should read as a real prior.

### What a RegenOS-based tool would have to do to be useful

1. Be free, open source, and forkable per city, with Lex (and Echo) as repo admins.
2. Ship an **admin dashboard** and near-total automation of notifications/newsletter so a broke, part-time steward can run it.
3. Implement **tag-based bidirectional event flow** with the COhere calendar before COhere starts.
4. Provide **vouch/referral onboarding, graduated moderation, attendance badges, anonymous feedback** — i.e. a minimal group model — without building a reputation economy.
5. Keep **money entirely out of the app**.
6. Keep **membership and feedback private**; keep **events public**.

---

## 4. Insights and ideas that emerged

- **Separate interfaces, shared data, routed by tag.** The design principle that resolved Lex's "one calendar or three?" anxiety. *Why it matters:* it is the RegenOS thesis stated by a non-technical steward in their own terms, and it's a spec Lucian can build against now.
- **"If you say you're part of Free School, you're part of Free School."** Group membership as self-declaration via tagged posting. *Why it matters:* a group primitive doesn't have to start with credentials; a claim-on-record plus social verification may be the right v0, with Kaliya-style credentials layered later.
- **Guilds from skill clusters.** Benjamin: "we see there's five people with auto mechanic skill listed. What if they formed a guild?" Lex: "even if it's one off... try it." *Why it matters:* an app-suggested path from individual skills → standing groups → collectives/community garage is a concrete, observable version of Beacon's theory of change (does easier visibility increase spontaneous gathering?).
- **Needs list as the primary point of entry**, not the class list. *Why it matters:* demand-side posting ("I want to learn X") lowers the intimidation barrier that Lex identifies as hurdle #1; most event platforms only model supply.
- **Decommodified reputation.** Both rejected Uber-style ratings ("who am I to take away this person's livelihood"); accepted attendance badges and Couchsurfing-style vouch counts, plus anonymous internal feedback. *Why it matters:* a reputation design for non-market groups — attestations of participation, never scores.
- **COhere as pulse, Free School as continuity.** "Why does it stop? Why is it only once a year?" is the question Benjamin hears most about COhere; the Free School volunteers to be the year-round network between pulses. *Why it matters:* gives COhere (and the COhere calendar Aaron Gabriel is building) a reason to persist as live infrastructure rather than a once-a-year site.
- **Analog-first, app-second.** Zines, posters, laminated alley-cat cards. *Why it matters:* the app's job is the directory and the notification, not the experience; printable/exportable views (a monthly zine of the calendar) would fit this community better than push notifications.
- **Fiscal hosting as the org-avoidance move.** Lets an explicitly political collective take tax-deductible donations without incorporating. *Why it matters:* a repeatable pattern for the bioregional nonprofit across neighbourhood-resilience projects.
- **Freeschool.com with per-city namespaces** (Craigslist-style). *Why it matters:* a ready-made domain and mental model for a multi-city, federated instance layout — each city a PDS/community, one shared lexicon.
- **Embodied collective power** (cruiser rides, critical mass): "the law is only as strong as its ability to be enforced." *Why it matters:* frames what these tools are for in Benjamin's and Lex's view — muscle memory for acting together — which is a different KPI from engagement.
- **Post-burnout convergence.** Both describe themselves as "retired" from saving the world; both land on "solidarity, relationship, resilience... do the work, don't be the hero." *Why it matters:* the working relationship is grounded in a shared politics, which raises trust and also raises the cost if Benjamin over-commits.

---

## 5. Potential collaborations

1. **Free School Boulder app v1 (agreed).** Benjamin builds an open-source replacement for the Glide prototype — profiles + skills, class posting, calendar, needs list, vouch/referral onboarding, graduated moderation, badges, anonymous feedback, newsletter, admin dashboard — targeted before COhere. Involves Benjamin, Lex, Echo (repo co-admin). Takes: Benjamin's build time in the next few weeks; a decision on whether to build directly on RegenOS lexicons (which are exploratory) or build standalone with an ATProto-compatible event schema and migrate. *Mutuality/risk:* high mutuality — Lex gets a tool and a partner, Gitcoin gets a live reference implementation and a steward who will actually use it. Risks: RegenOS is not production-ready and COhere is soon; Benjamin has now told Lex "I want to build something that meets all of the needs that you have, help maintain it" — a maintenance commitment that outlives the Gitcoin contract; Lex's own capacity is thin. Note the scope mismatch in how each side described the role: Lex — "I think you're going to be like more than just a tech person, you know, you're going to be like taking this project on"; Benjamin — "getting it from 0 to 1... once it's on it should just be on," i.e. build, automate the busy work, then step back. Benjamin's open-source model as described to Lex: anyone ("some random kid from CU... trying to find leftist tech projects") can contribute permissionlessly, with the repo admins deciding what to accept.

2. **Free School ↔ COhere calendar interoperability (agreed in principle).** Benjamin + Aaron Gabriel Neyer implement tag-based two-way flow; Lucian consulted on the event lexicon so this becomes the first real multi-calendar demo of RegenOS rather than a one-off hack. Takes: an agreed event schema with tags and source, a feed/subscription mechanism, and a deadline before COhere. *Risk:* if done as a Glide/iCal hack under time pressure, it teaches RegenOS nothing; if done "properly," it may slip past COhere.

3. **Free School as the group-primitive test bed.** Lucian/Aaron pilot whatever membership/vouch/badge model they adopt (Arbiter, Project Weave) on the Free School. Takes: Lucian's interest and a private-data approach for membership. *Mutuality:* good for Gitcoin; for Lex only if it stays invisible and reliable.

4. **Fiscal hosting via the climate 501(c)(3) (offered and accepted).** Separate bank account, donations tax-deductible. Takes: board/legal sign-off that a "rabid and vicious," explicitly political, anti-capitalist collective fits the nonprofit's scope; a simple MOU. *Risk:* political-activity exposure for the nonprofit; Lex explicitly wants to remain "explicitly political." Needs honest scoping.

5. **COhere skill-share track orchestrated by the Free School.** Lex, Eileen, COhere organisers, Benjamin (sponsor). Takes: Lex learning what COhere is (meeting was that evening) and a shared calendar. *Risk:* Lex was "voluntold" and unclear on scope; watch for overload.

6. **Primitive-skills / resilience gathering.** Benjamin's Spirit of the Front Range idea (baskets, herbal medicine, hide tanning) meets Lex's Asheville experience (they ran a hide-tanning class from dumpstered deer hides). Natural joint Free School programme. Low risk, high fit.

7. **Echo's "free food oasis" project.** Benjamin: "Oh, man, I need to talk to him." Food-posting-by-neighbourhood plus bike delivery is another small coordination app in the same family as Benjamin's tool-library and Backyard Farm Network ideas (see the voice note). Potential RegenOS place/offer lexicon reuse.

8. **Climatique events on the aggregated calendar.** Lex offered to ask Climatique whether they want to be "encapsulated in the Free School"; Benjamin's view is the Free School tag should mean skill-sharing specifically, with Climatique flowing to the broader COhere/punk calendar. Deferred.

---

## 6. Action items

- **Benjamin** → Build Free School Boulder app v1, free and open source, replacing the Glide prototype; add Echo as repository co-admin; include admin dashboard, vouch/referral onboarding, graduated moderation, badges, anonymous feedback, newsletter automation (target: before COhere).
- **Benjamin** → Work with Aaron Gabriel Neyer to make the Free School and COhere calendars interoperable via tags, both directions ("I'll figure that part out").
- **Benjamin** → Set up fiscal hosting for Free School collective donations under the climate 501(c)(3) (separate bank account); confirm scope with the nonprofit first.
- **Benjamin** → Read the Wikipedia free-school history Lex linked in the group chat ("I would love to educate myself on that").
- **Benjamin** → Talk to Echo about the free-food / bike-delivery project.
- **Benjamin** → Send Lex details of the Thursday night cruiser rides (park near 28th, off Discount Tire) so they go on the calendar.
- **Benjamin** → Brief Lucian Hymer / Aaron Gabriel on the tag-routing spec and the group-primitive needs (this report).
- **Lex** → Add Benjamin to the Free School group chat (done during the meeting).
- **Lex** → Send Benjamin the campaign material for Laura (Palestine-solidarity legal case; DIY festival organiser; she had been thinking of a kids' version of the Free School, which caused some confusion between them; Lex told her about COhere).
- **Lex** → Attend the COhere meeting that evening; clarify the skill-share track scope; report back.
- **Lex** → (Optional) Ask Climatique whether they want their events aggregated under the Free School / skill-share tag.
- **Benjamin + Lex** → Decide the supplies-donation design (Venmo field vs nothing) before v1 ships.
- **Both** → Reconvene "in a couple hours" at the COhere meeting (per Lex).

---

## 7. Open questions / things to verify

- **Lex's full name and preferred pronouns** — never stated; "Lex" is inferred from Benjamin's calendar. Confirm before creating a person note or naming them to the Gitcoin team.
- **freeschool.com ownership** — Lex says they own it; verify (WHOIS) before building a namespace plan around it.
- **What "the Free School chat" is** (Signal? group text?) and who is in it — Lex: "I don't know what that group is yet but felt appropriate to put you in it."
- **Build substrate decision:** RegenOS lexicons (exploratory, Rust/ATProto) vs standalone with ATProto-compatible schema. RegenOS is "NOT go-to-market" per the Gitcoin brain; COhere is weeks away. Needs Lucian's read on what's actually usable.
- **COhere dates and the COhere calendar's current stack** — not stated; determines the interoperability deadline and approach. Also whether "Eileen and Benjamin" (COhere organisers, with a new baby — a different Benjamin) are on board with Free School running the skill-share track as Lex describes.
- **Fiscal-hosting fit** — can the climate 501(c)(3) host an "explicitly political," anti-capitalist collective without jeopardising its status? Lex was clear the Free School cannot itself be a 501(c)(3).
- **Privacy model** — which records are public (events) vs private (profiles, vouches, feedback, membership) given the activist exposure of Lex's network and ATProto's public repos. Benjamin's ATProto pitch to Lex did not cover this.
- **Echo's real position** — Lex says Echo won't mind being displaced; Benjamin should confirm directly, since Echo built the prototype.
- **Scope of the "punk rock community calendar"** — deferred, but Benjamin claimed "Aaron Gabriel already wants the COhere calendar to be like the punk rock community calendar." Verify with Aaron Gabriel.
- **Benjamin's maintenance commitment** — "help maintain it" was said; how long, and under whose budget, is undefined.
- **Attendees list in the meeting note mentions "Micha"** — no Micha appears in the transcript I read; likely an ingest artefact.

---

## 8. Connections to other interviews this week

- **Juicy Life / Actualize (Sep 7).** Same conclusion from the opposite end of the spectrum: Juicy (9k users, mature API) and Lex (one user, Glide) both need a shared event/place data model with tags and source, not a shared front-end. Benjamin explicitly cited Actualize to Lex as one of the calendars to aggregate. The "Lexicon Co-op" idea has a natural second member.
- **Kaliya Young / Project Weave (Sep 3).** Lex's vouch → badge → unmoderated progression is verifiable membership credentials in plain language; the Free School is a candidate pilot for whatever group primitive emerges. IIW #43 (Nov 3–5) is after COhere, so v1 will need an interim model.
- **Savannah Kruger (Sep 10, immediately prior) and Benjamin's voice note.** The voice note's pattern — "a coordination platform that's very small that helps people do one small coordinated action" (tool libraries, Backyard Farm Network) — is exactly the Free School app's shape, with the shared resource being skills. Echo's free-food project is a fourth instance.
- **Nisha / the Hive (Sep 10, immediately after).** Lex: "Are you tied into the Hive?" and named "the Free School, the Regen Hub, Hive, Climatique" as the resilience cluster. Worth cross-referencing that report for overlap in people and calendars.
- **COhere thread (Julia Keller, Sep 8; Aaron Gabriel Neyer).** This meeting turns COhere from a sponsorship into a live interoperability deadline for the COhere calendar.

---

## 9. Sources

- Transcripts: [[vault/projects/local-alternatives/meetings/2026-09-10_free-school-opening-conversation]]; [[vault/projects/local-alternatives/meetings/2026-09-10_free-school-boulder-app-and-calendar-interoperability]] (read in full, 76.8 KB); context [[vault/projects/local-alternatives/meetings/2026-09-10_voice-note-tool-libraries-and-pooled-purchasing]].
- Vault: [[vault/projects/local-alternatives/PROJECT]]; [[vault/projects/local-alternatives/reports/2026-09-08_actualize-juicy-partnership-report]]; [[vault/projects/local-alternatives/briefings/2026-09-03_project-weave-kaliya-atproto-groups]]; existing task notes `vault/tasks/active/build-free-school-boulder-app-v1-before-cohere`, `vault/tasks/active/wire-free-school-and-cohere-calendars-together`, `vault/tasks/active/fiscally-host-free-school-donations`.
- Gitcoin brain: `projects/regenos-senius`; `knowledge/atproto-vs-nostr-for-regenos` (via context brief).
- Calendar: "Lex Free Skool", Thu 2026-09-10 13:00–14:00 MDT.

---

## Completeness check

- 2026-09-11 — Independent re-read of all three transcripts in full (opening fragment, main 76.8 KB session, and the solo voice note) against every section of this report.
- Feature list, calendar-interoperability spec, fiscal-hosting offer, COhere logistics, action items, and all named people/orgs were already present and correctly attributed; no speaker misattributions or wrong numbers found.
- Added: Benjamin's own framing of his role to Lex (OpenCivics exit, Kevin Owocki / Regen Hub founding, Gitcoin liaison, Lego-block pitch); COhere as a 10-day event and Lex's 30-minute-at-COhere → 3-hour-at-Free-School mechanism; Lex's initial impulse to pivot to / rename the COhere calendar; the "more than a tech person" vs "0 to 1" scope mismatch; permissionless-contribution model; Glide-is-disposable reasoning; Echo's Food Not Bombs history; Milan Ocean as the host friend; the Central Park encampment; Laura's kids'-version confusion.
- Residual uncertainties: "Spirit of the Front Range" as the fiscal-hosting nonprofit is inferred from vault context, not named in the transcript (Benjamin said "the 501C3 for the climate work that we do"); the "six months" bylaws quote is transcribed as "Sep months"; Lex's name remains inferred from the calendar entry.
