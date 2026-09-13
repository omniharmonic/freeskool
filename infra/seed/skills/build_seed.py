# -*- coding: utf-8 -*-
"""
Assemble skills-seed.jsonl + stats.json from the cached ESCO / Wikidata evidence.

Pipeline (each step is its own script so it can be rerun independently):
    taxonomy.py        hand-authored domain -> area -> skill skeleton (the DSL)
    nodes.py           parse the DSL into flat node dicts, check slug uniqueness
    fetch_esco.py      cache ESCO /search candidates (3 queries per node)
    esco_match.py      strict label matcher; >=0.95 is auto-accepted
    make_review.py     write review.txt: the sub-0.95 band, for hand review
    esco_decisions.tsv hand-review verdicts (slug -> exact ESCO label)
    resolve_decisions.py  resolve those labels to real ESCO URIs
    fetch_wikidata.py  SPARQL exact-label pass, then wbsearchentities fallback
    wd_pick.py         sense disambiguation from the English description
    wikidata_overrides.tsv  hand corrections to the pick
    verify_wikidata.py wbgetentities check of overrides + a 20-node random sample
    build_seed.py      <- this file

status is DERIVED, not asserted: a node with a verified ESCO concept is
`canonical`; a node ESCO has no equivalent for is `proposed` — i.e. a
community-extension node that a school's repo would carry until it is merged.

`_provenance` is an annotation block, not part of the lexicon; strip it (or add
it as an optional lexicon field) before publishing records.
"""
import json
from collections import Counter, defaultdict

import esco_match
import wd_pick
from fetch_esco import node_queries
from nodes import all_nodes

CREATED_AT = "2026-09-12T00:00:00.000Z"
LEXICON = "freeschool.draft.skill"

esco_cache = json.load(open("esco_cache.json"))
esco_groups = json.load(open("esco_groups.json"))
esco_decided = json.load(open("esco_decided.json"))
wd_cache = json.load(open("wikidata_cache.json"))
wd_verified = json.load(open("wikidata_verified.json"))
wd_resolved = wd_verified["resolved"]
wd_entities = wd_verified["entities"]

overrides_none = set()
for line in open("wikidata_overrides.tsv", encoding="utf-8"):
    line = line.rstrip("\n")
    if line and not line.startswith("#"):
        lab, q = line.split("\t")
        if q.strip() == "none":
            overrides_none.add(lab)


def esco_chain(uris):
    """Walk ESCO's real broader hierarchy to the root; returns [{uri,title}] root-first."""
    chain, seen = [], set()
    frontier = list(uris)
    while frontier:
        u = frontier.pop(0)
        if u in seen:
            continue
        seen.add(u)
        g = esco_groups.get(u)
        if not g:
            continue
        chain.append({"uri": u, "title": g["title"]})
        frontier.extend([b for b in g["broader"] if b])
    chain.reverse()
    return chain


def esco_for(n):
    """Returns (candidate, method) or (None, None)."""
    if n["slug"] in esco_decided:
        return esco_decided[n["slug"]], "hand-reviewed"
    m = esco_match.best([n.get("esco_q"), n["label"]], node_queries(n), esco_cache)
    if m and m["matchScore"] >= 0.95:
        return m, "exact-label"
    return None, None


def wd_for(n):
    lab = n.get("wd_q")
    if not lab or lab in overrides_none:
        return None
    r = wd_resolved.get(lab)
    if not r:
        return None
    out = dict(r)
    # label/description: prefer the authoritative wbgetentities record, fall back
    # to what the SPARQL / search pass already returned for that QID
    ent = wd_entities.get(r["qid"])
    if ent:
        out["wdLabel"] = ent["label"] or lab
        out["wdDescription"] = ent["description"]
    else:
        for h in (wd_cache.get(lab, {}).get("hits") or []):
            if h["qid"] == r["qid"]:
                out["wdLabel"] = h.get("label") or lab
                out["wdDescription"] = h.get("description") or ""
                break
    return out


def sentence(s):
    s = (s or "").strip()
    if not s:
        return ""
    s = s[0].upper() + s[1:]
    return s if s.endswith(".") else s + "."


nodes = all_nodes()
by_slug = {n["slug"]: n for n in nodes}
records, provenance = [], {}
wd_desc_used = 0

for n in nodes:
    ext, prov = {}, {"level": n["level"], "domain": n["domain"],
                     "broaderSource": "freeschool-grouping",
                     "expectedMissingFromEsco": n.get("proposed", False)}

    ec, emethod = (None, None) if n["level"] != "skill" else esco_for(n)
    if ec:
        ext["esco"] = ec["uri"]
        chain = esco_chain(ec.get("broaderHierarchyConcept") or [])
        prov["esco"] = {
            "label": ec["label"], "method": emethod,
            "skillType": ec.get("skillType", []),
            "reuseLevel": ec.get("reuseLevel", []),
            "escoBroaderHierarchy": chain,
        }

    wc = wd_for(n)
    if wc:
        ext["wikidata"] = wc["qid"]
        prov["wikidata"] = {k: wc[k] for k in
                            ("wdLabel", "wdDescription", "method", "handVerified", "ambiguity")
                            if k in wc}

    # A Wikidata QID is a TOPIC ANCHOR, not a claim that the item *is* the skill:
    # "Repair a flat tire" anchors to Q771452 "bicycle tire". Only when the item's
    # label equals ours is it the same concept. Descriptions are generated so a
    # reader can always see which of the two they are reading (Wikidata English
    # descriptions are CC0, so shipping them verbatim is fine).
    if wc:
        same = (wc.get("wdLabel", "").strip().lower() == n["label"].strip().lower())
        prov["wikidata"]["relation"] = "same-concept" if same else "topic-anchor"

    desc = n.get("desc")
    if not desc:
        wdd = (wc or {}).get("wdDescription", "")
        parent = by_slug[n["broader"][0]]["label"] if n["broader"] else ""
        if wdd and len(wdd) > 12:
            if prov.get("wikidata", {}).get("relation") == "same-concept":
                desc = sentence(wdd) + f" Taught under {parent.lower()}."
            else:
                desc = (f"{n['label']} \u2014 linked concept \u201c{wc['wdLabel']}\u201d: "
                        f"{wdd}. Taught under {parent.lower()}.")
            wd_desc_used += 1
            prov["descriptionSource"] = "wikidata-cc0"
        elif ec:
            parent = by_slug[n["broader"][0]]["label"] if n["broader"] else ""
            desc = (f"{n['label']} — aligned with the ESCO skill \u201c{ec['label']}\u201d. "
                    f"Taught under {parent.lower()}.")
            prov["descriptionSource"] = "esco-aligned-template"
        else:
            parent = by_slug[n["broader"][0]]["label"] if n["broader"] else ""
            desc = (f"{n['label']}: a skill free schools teach under {parent.lower()}; "
                    "no equivalent concept in ESCO, description to be written by the "
                    "community that proposes it.")
            prov["descriptionSource"] = "placeholder-needs-authoring"
    else:
        prov["descriptionSource"] = "authored"

    rec = {
        "$type": LEXICON,
        "id": n["slug"],
        "label": n["label"],
        "description": desc,
        "broader": n["broader"],
        "externalIds": ext,
        "status": "canonical" if (n["level"] != "skill" or ec) else "proposed",
        "createdAt": CREATED_AT,
    }
    if n.get("prerequisites"):
        rec["prerequisites"] = n["prerequisites"]
    rec["_provenance"] = prov
    records.append(rec)
    provenance[n["slug"]] = prov

# referential integrity
ids = {r["id"] for r in records}
for r in records:
    for b in r["broader"]:
        assert b in ids, f"{r['id']} -> unknown broader {b}"
    for p in r.get("prerequisites", []):
        assert p in ids, f"{r['id']} -> unknown prerequisite {p}"

with open("skills-seed.jsonl", "w", encoding="utf-8") as f:
    for r in records:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
json.dump(provenance, open("provenance.json", "w"), indent=1)

# ---------------------------------------------------------------- stats
dom = defaultdict(lambda: Counter())
for r in records:
    p = r["_provenance"]
    d = dom[p["domain"]]
    d["nodes"] += 1
    d[p["level"]] += 1
    if r["externalIds"].get("esco"):
        d["esco"] += 1
    if r["externalIds"].get("wikidata"):
        d["wikidata"] += 1
    if r["status"] == "proposed":
        d["proposed"] += 1
    if p["level"] == "skill":
        d["skills"] = d["skill"]

leaves = [r for r in records if r["_provenance"]["level"] == "skill"]
esco_methods = Counter(r["_provenance"]["esco"]["method"] for r in records
                       if r["_provenance"].get("esco"))
wd_methods = Counter(r["_provenance"]["wikidata"]["method"] for r in records
                     if r["_provenance"].get("wikidata"))
group_titles = Counter()
for r in records:
    ch = (r["_provenance"].get("esco") or {}).get("escoBroaderHierarchy") or []
    if len(ch) >= 2:
        group_titles[ch[1]["title"]] += 1   # ch[0] is the scheme root (skills/knowledge)
    elif ch:
        group_titles[ch[0]["title"]] += 1

stats = {
    "generatedAt": CREATED_AT,
    "lexicon": LEXICON,
    "totals": {
        "nodes": len(records),
        "domains": sum(1 for r in records if r["_provenance"]["level"] == "domain"),
        "areas": sum(1 for r in records if r["_provenance"]["level"] == "area"),
        "skills": len(leaves),
        "withEsco": sum(1 for r in records if r["externalIds"].get("esco")),
        "withWikidata": sum(1 for r in records if r["externalIds"].get("wikidata")),
        "withBoth": sum(1 for r in records if r["externalIds"].get("esco")
                        and r["externalIds"].get("wikidata")),
        "withNeither": sum(1 for r in records if not r["externalIds"]),
        "statusCanonical": sum(1 for r in records if r["status"] == "canonical"),
        "statusProposed": sum(1 for r in records if r["status"] == "proposed"),
    },
    "coverage": {
        "pctNodesWithEsco": round(100 * sum(1 for r in records if r["externalIds"].get("esco")) / len(records), 1),
        "pctNodesWithWikidata": round(100 * sum(1 for r in records if r["externalIds"].get("wikidata")) / len(records), 1),
        "pctLeafSkillsWithEsco": round(100 * sum(1 for r in leaves if r["externalIds"].get("esco")) / len(leaves), 1),
        "pctLeafSkillsWithWikidata": round(100 * sum(1 for r in leaves if r["externalIds"].get("wikidata")) / len(leaves), 1),
    },
    "byDomain": {k: {"nodes": v["nodes"], "areas": v["area"], "skills": v["skill"],
                     "withEsco": v["esco"], "withWikidata": v["wikidata"],
                     "proposed": v["proposed"],
                     "pctEsco": round(100 * v["esco"] / v["nodes"], 1),
                     "pctWikidata": round(100 * v["wikidata"] / v["nodes"], 1)}
                 for k, v in dom.items()},
    "escoMatchMethods": dict(esco_methods),
    "wikidataMatchMethods": dict(wd_methods),
    "wikidataHandVerified": sum(1 for r in records
                                if (r["_provenance"].get("wikidata") or {}).get("handVerified")),
    "descriptionsFromWikidataCC0": wd_desc_used,
    "escoTopLevelGroupsHit": dict(group_titles.most_common()),
    "descriptionSources": None,  # filled below
    "hypothesisCheck": {
        "note": "'*' in taxonomy.py was a prior guess that ESCO lacks the concept; "
                "status is derived from the API result instead.",
        "expectedMissing_andWas": sum(1 for r in records
                                      if r["_provenance"]["expectedMissingFromEsco"]
                                      and r["status"] == "proposed"),
        "expectedMissing_butEscoHadIt": sum(1 for r in records
                                            if r["_provenance"]["expectedMissingFromEsco"]
                                            and r["status"] == "canonical"),
        "expectedPresent_butEscoLacked": sum(1 for r in records
                                             if r["_provenance"]["level"] == "skill"
                                             and not r["_provenance"]["expectedMissingFromEsco"]
                                             and r["status"] == "proposed"),
    },
}
stats["descriptionSources"] = dict(Counter(r["_provenance"]["descriptionSource"] for r in records))
json.dump(stats, open("stats.json", "w"), indent=1)

print(json.dumps(stats["totals"], indent=1))
print(json.dumps(stats["coverage"], indent=1))
print("esco methods:", dict(esco_methods), "| wd methods:", dict(wd_methods))
print("hand-verified QIDs:", stats["wikidataHandVerified"])
print("hypothesis:", json.dumps(stats["hypothesisCheck"], indent=1))
for k, v in stats["byDomain"].items():
    print(f"  {k:18s} n={v['nodes']:3d} skills={v['skills']:3d} esco={v['withEsco']:3d} "
          f"({v['pctEsco']:4.1f}%) wd={v['withWikidata']:3d} ({v['pctWikidata']:4.1f}%) "
          f"proposed={v['proposed']:3d}")
