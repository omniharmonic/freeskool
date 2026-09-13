import { Lexicons } from '@atproto/lexicon'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const strongRef = { lexicon: 1, id: 'com.atproto.repo.strongRef', defs: { main: { type: 'object', required: ['uri','cid'], properties: { uri: { type: 'string', format: 'at-uri' }, cid: { type: 'string', format: 'cid' } } } } }
const dir = fileURLToPath(new URL('../lexicons/freeschool/draft/', import.meta.url))
const docs = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))
const lex = new Lexicons([strongRef, ...docs])
const now = new Date().toISOString()
const sref = { uri: 'at://did:plc:abc/community.lexicon.calendar.event/3k', cid: 'bafyreigdcnuvcw5cwtnfn7tmd3cwmqyaqqfj2yzjvz7sjclp33sdnylmqe' }
const samples = {
  'freeschool.draft.skill': { $type:'freeschool.draft.skill', id:'bicycle-repair', label:'Bicycle repair', status:'canonical', broader:['at://did:plc:abc/freeschool.draft.skill/repair'], externalIds:{ wikidata:'Q1236436' }, createdAt: now },
  'freeschool.draft.skillClaim': { $type:'freeschool.draft.skillClaim', skill:'at://did:plc:abc/freeschool.draft.skill/bicycle-repair', level:'teaching', createdAt: now },
  'freeschool.draft.skillAttestation': { $type:'freeschool.draft.skillAttestation', subject:'did:plc:xyz', skill:'at://did:plc:abc/freeschool.draft.skill/bicycle-repair', direction:'positive', createdAt: now },
  'freeschool.draft.attendance': { $type:'freeschool.draft.attendance', event:sref, attendee:'did:plc:xyz', participated:true, level:2, createdAt: now },
  'freeschool.draft.hostFeedback': { $type:'freeschool.draft.hostFeedback', event:sref, host:'did:plc:xyz', direction:'positive', aspects:{knowledge:3}, createdAt: now },
  'freeschool.draft.request': { $type:'freeschool.draft.request', title:'Auto mechanics 101', status:'open', threshold:5, createdAt: now },
  'freeschool.draft.claim': { $type:'freeschool.draft.claim', request:sref, createdAt: now },
  'freeschool.draft.resource': { $type:'freeschool.draft.resource', title:'Park Tool repair guide', skills:['at://did:plc:abc/freeschool.draft.skill/bicycle-repair'], uri:'https://example.org', license:'CC-BY-SA-4.0', createdAt: now },
  'freeschool.draft.course': { $type:'freeschool.draft.course', title:'Welding in three Saturdays', sessions:[sref], createdAt: now },
  'freeschool.draft.policy': { $type:'freeschool.draft.policy', title:'Free School Boulder rules', text:'No money changes hands for classes.', version:'1', effectiveAt: now, thresholds:{ hostMinAttended:0, feedbackK:3, destructiveActionStewards:2 }, createdAt: now },
  'freeschool.draft.moderationAction': { $type:'freeschool.draft.moderationAction', action:'remove-listing', reason:'Duplicate of an existing class.', actors:['did:plc:steward'], subjectRecord:'at://did:plc:abc/coop.lexicon.event.listing/3k', createdAt: now },
  'freeschool.draft.appeal': { $type:'freeschool.draft.appeal', action:sref, text:'It was not a duplicate.', createdAt: now },
  'freeschool.draft.skillLevel': { $type:'freeschool.draft.skillLevel', event:sref, skill:'at://did:plc:abc/freeschool.draft.skill/bicycle-repair', level:2, prerequisites:'Bring your own bike.', createdAt: now },
  'freeschool.draft.series': { $type:'freeschool.draft.series', firstEvent:sref, rrule:'FREQ=WEEKLY;INTERVAL=1;BYDAY=TH;COUNT=8', freq:'weekly', interval:1, byDay:['TH'], count:8, timezone:'America/Denver', materializeAhead:60, createdAt: now },
  'freeschool.draft.occurrence': { $type:'freeschool.draft.occurrence', event:sref, series:sref, originalStartsAt: now, sequence:3, createdAt: now },
  'freeschool.draft.approval': { $type:'freeschool.draft.approval', proposal:'at://did:plc:school/freeschool.draft.moderationAction/3k', action:'remove-listing', reason:'Duplicate listing', createdAt: now },
  'freeschool.draft.school': { $type:'freeschool.draft.school', name:'Free School Boulder', region:'Boulder, CO', peers:['did:plc:cohere'], tags:['skillshare','free-school'], createdAt: now },
}
let failed = 0
for (const d of docs) {
  const sample = samples[d.id]
  try {
    if (!sample) throw new Error('no sample record')
    lex.assertValidRecord(d.id, sample)
    console.log('OK  ', d.id)
  } catch (e) { failed++; console.log('FAIL', d.id, '-', e.message) }
}
// negative checks
try { lex.assertValidRecord('freeschool.draft.skillLevel', { $type:'freeschool.draft.skillLevel', event:sref, skill:'at://did:plc:abc/freeschool.draft.skill/x', level:4, createdAt: now }); console.log('FAIL negative: level 4 accepted'); failed++ } catch { console.log('OK   negative: level 4 rejected') }
try { lex.assertValidRecord('freeschool.draft.moderationAction', { $type:'freeschool.draft.moderationAction', action:'remove-listing', reason:'', actors:['did:plc:s'], createdAt: now }); console.log('FAIL negative: empty reason accepted'); failed++ } catch { console.log('OK   negative: empty reason rejected') }
try { lex.assertValidRecord('freeschool.draft.hostFeedback', { $type:'freeschool.draft.hostFeedback', event:sref, host:'did:plc:x', direction:'positive', aspects:{knowledge:5}, createdAt: now }); console.log('FAIL negative: aspect 5 accepted'); failed++ } catch { console.log('OK   negative: aspect out of range rejected') }
console.log(failed ? `${failed} failures` : `all ${docs.length} lexicons valid`)
process.exit(failed ? 1 : 0)
