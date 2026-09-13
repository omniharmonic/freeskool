# Skill taxonomy seed (from research brief R5, 2026-09-12)

`skills-seed.jsonl` — 525 `freeschool.draft.skill` records: 8 domains → 52 areas → 465 leaf skills. `stats.json` has the counts; `provenance.json` records, per node, how the ESCO URI and Wikidata QID were chosen; `build_seed.py` regenerates the file (needs the ESCO cache from the research run). Nodes with `status: proposed` are community extensions ESCO lacks.

Write them to a PDS with `pnpm --filter @freeschool/lexicons seed:skills` (env: `PDS_URL`, `AUTHORITY_HANDLE`, `AUTHORITY_PASSWORD`; local dev handles use the `.test` domain). The script strips `_provenance`, turns `broader` slugs into at-uris under the authority DID, validates every record against the lexicon, and uses the slug as the rkey (`key: any`).

## Attribution (ship verbatim in the app footer and `/about/data`)

> **Skill taxonomy data.** This service uses the ESCO classification of the European Commission (ESCO v1.2.1), licensed CC BY 4.0. Free School's taxonomy is a modified and extended version of ESCO: we regroup ESCO concepts under our own domains and areas, and we add community-proposed skills that ESCO does not cover. Those additions and the regrouping are Free School's, not the European Commission's. ESCO's skill hierarchy is partly based on O*NET, provided by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA) under CC BY 4.0; O*NET® is a trademark of USDOL/ETA. Concept identifiers and descriptions from Wikidata are released under CC0 1.0 (public domain).

Render each record's `externalIds` as links; that satisfies "appropriate credit" better than a footer.
