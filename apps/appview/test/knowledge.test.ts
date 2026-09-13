process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool_polish_test'
process.env.SESSION_SECRET ??= 'knowledge-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 5).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'knowledge-test-pepper'
import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest'
import type { Context } from 'hono'
import { pgAvailable,testDb,truncate,closeTestDb } from './helpers/pg.js'
import { appMeta } from '../src/db/schema.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'
const did='did:plc:knowledge-author', skill='at://did:plc:school/freeschool.draft.skill/repair'
let role=20
const indexed=vi.hoisted(()=>({resources:[] as Array<Record<string,unknown>>,claims:[] as Array<Record<string,unknown>>,events:[] as Array<Record<string,unknown>>,linkedClass:null as Record<string,unknown>|null}))
const writes=vi.hoisted(()=>({put:vi.fn(),remove:vi.fn()}))
vi.mock('../src/lib/actor-agent.js',async()=>({...await vi.importActual('../src/lib/actor-agent.js'),actorAgent:async()=>({com:{atproto:{repo:{putRecord:writes.put,deleteRecord:writes.remove}}}})}))
vi.mock('../src/lib/roles.js',async()=>({...await vi.importActual('../src/lib/roles.js'),roleOf:async()=>role}))
vi.mock('../src/index/indexer.js',()=>({getIndexer:async()=>({contrail:{query:async(short:string)=>({records:short==='skill'?[{uri:skill,did:'did:plc:school',rkey:'repair',record:{id:'repair',label:'Repair',status:'canonical'}}]:short==='skillClaim'?[{uri:`at://${did}/freeschool.draft.skillClaim/one`,did,rkey:'one',record:{skill,level:'practicing'}},...indexed.claims]:short==='resource'?indexed.resources:short==='event'?indexed.events:[]})},notify:async()=>{}})}))
vi.mock('../src/http/routes/events.js',async()=>({...await vi.importActual('../src/http/routes/events.js'),loadEvent:async()=>indexed.linkedClass}))
const { createApp }=await import('../src/http/app.js')
let available=false
beforeAll(async()=>{available=await pgAvailable();expect(available).toBe(true)})
beforeEach(async()=>{if(available)await truncate('fs_app_meta','fs_session','fs_member');role=20;indexed.resources=[];indexed.claims=[];indexed.events=[];indexed.linkedClass=null;writes.put.mockReset().mockResolvedValue({data:{uri:`at://${did}/freeschool.draft.resource/new`}})})
afterAll(async()=>{if(available)await closeTestDb()})
async function cookie(){const id=await createSession({header:()=>{}} as unknown as Context,did,'custodial');return `${config().SESSION_COOKIE}=${signSessionId(id)}`}
it('keeps private profiles and avatars inaccessible until explicit opt-in, and revokes access immediately',async()=>{
 const app=createApp(),headers={Cookie:await cookie(),'Content-Type':'application/json'}
 await testDb().insert(appMeta).values({key:`profile:${did}`,value:{displayName:'A neighbor',bio:'Private biography'},updatedAt:new Date()})
 expect((await app.request(`/api/profiles/${did}`)).status).toBe(404)
 expect((await app.request(`/api/profiles/${did}/avatar`)).status).toBe(404)
 expect((await app.request(`/api/practitioners?skill=${encodeURIComponent(skill)}`)).status).toBe(200)
 expect((await (await app.request(`/api/practitioners?skill=${encodeURIComponent(skill)}`)).json()).profiles).toEqual([])
 expect((await app.request('/api/me',{method:'PUT',headers,body:JSON.stringify({publicListing:true})})).status).toBe(200)
 const res=await app.request(`/api/profiles/${did}`);expect(res.status).toBe(200);expect(res.headers.get('X-Robots-Tag')).toContain('noindex')
 const profile=await res.json();expect(profile.claims).toHaveLength(1);expect(profile.attendance).toBeUndefined();expect(profile.rsvps).toBeUndefined()
 expect((await (await app.request(`/api/practitioners?skill=${encodeURIComponent(skill)}`)).json()).profiles).toHaveLength(1)
 await app.request('/api/me',{method:'PUT',headers,body:JSON.stringify({publicListing:false})})
 expect((await app.request(`/api/profiles/${did}`)).status).toBe(404)
})
it('publishes a resource under the contributor’s own DID and rejects unsafe links',async()=>{
 const app=createApp(),headers={Cookie:await cookie(),'Content-Type':'application/json'}
 const body={title:'Repair notes',description:'A useful starting point.',skills:[skill]}
 expect((await app.request('/api/resources',{method:'POST',headers,body:JSON.stringify({...body,uri:'javascript:alert(1)'})})).status).toBe(400)
 expect((await app.request('/api/resources',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(201)
 expect(writes.put).toHaveBeenCalledWith(expect.objectContaining({repo:did,collection:'freeschool.draft.resource',record:expect.objectContaining({title:'Repair notes',skills:[skill]})}))
 role=10
 expect((await app.request('/api/resources',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(403)
 expect((await app.request('/api/resources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status).toBe(401)
})
it('prevents deleting another contributor’s resource',async()=>{
 const response=await createApp().request(`/api/resources/${encodeURIComponent('at://did:plc:someone-else/freeschool.draft.resource/one')}`,{method:'DELETE',headers:{Cookie:await cookie()}})
 expect(response.status).toBe(403);expect(writes.remove).not.toHaveBeenCalled()
})

it('edits only author-owned resources while preserving identity and creation date',async()=>{
 const id=`at://${did}/freeschool.draft.resource/original`
 indexed.resources=[{uri:id,did,rkey:'original',cid:'bafyoriginal',record:{title:'Original',skills:[skill],description:'First notes',createdAt:'2026-01-01T00:00:00Z'}}]
 const app=createApp(),headers={Cookie:await cookie(),'Content-Type':'application/json'}
 const body={title:'Revised',description:'Updated notes',skills:[skill],license:'CC0'}
 expect((await app.request(`/api/resources/${encodeURIComponent(id)}`,{method:'PUT',headers,body:JSON.stringify(body)})).status).toBe(200)
 expect(writes.put).toHaveBeenCalledWith(expect.objectContaining({rkey:'original',record:expect.objectContaining({createdAt:'2026-01-01T00:00:00Z',license:'CC0'})}))
 indexed.resources[0]!.did='did:plc:someone-else'
 writes.put.mockClear()
 expect((await app.request(`/api/resources/${encodeURIComponent(id)}`,{method:'PUT',headers,body:JSON.stringify(body)})).status).toBe(403)
 expect(writes.put).not.toHaveBeenCalled()
})
it('ignores malformed remote skill claims rather than rendering arbitrary record values',async()=>{
 indexed.claims=[{uri:`at://${did}/freeschool.draft.skillClaim/bad`,did,rkey:'bad',record:{skill,level:{unexpected:true},note:{html:'unsafe'}}}]
 await testDb().insert(appMeta).values({key:`profile:${did}`,value:{displayName:'A neighbor',publicListing:true},updatedAt:new Date()})
 const app=createApp()
 expect((await (await app.request(`/api/profiles/${did}`)).json()).claims).toEqual([{skill,level:'practicing'}])
 expect((await (await app.request(`/api/practitioners?skill=${encodeURIComponent(skill)}`)).json()).profiles[0].level).toBe('practicing')
})

function noteFixture(event?:{uri:string;cid:string}) {
 const id=`at://${did}/freeschool.draft.resource/managed`
 indexed.resources=[{uri:id,did,rkey:'managed',cid:'bafynote',record:{title:'My notes',description:'Still mine to manage.',skills:[skill],createdAt:'2026-01-01T00:00:00Z',...(event?{event}:{})}}]
 return id
}
it('keeps moderated notes manageable only by their author, never in public discovery',async()=>{
 const id=noteFixture(), app=createApp(),headers={Cookie:await cookie()}
 await testDb().insert(appMeta).values({key:`resource-hidden:${id}`,value:true,updatedAt:new Date()})
 expect((await app.request(`/api/resources/${encodeURIComponent(id)}`)).status).toBe(404)
 expect((await (await app.request('/api/resources',{headers})).json()).resources).toEqual([])
 expect((await app.request('/api/my-resources')).status).toBe(401)
 const mine=await (await app.request('/api/my-resources',{headers})).json()
 expect(mine.resources).toHaveLength(1);expect(mine.resources[0].libraryStatus).toBe('moderated')
 expect((await (await app.request(`/api/resources/${encodeURIComponent(id)}`,{headers})).json()).libraryStatus).toBe('moderated')
 const otherId=await createSession({header:()=>{}} as unknown as Context,'did:plc:another-contributor','custodial')
 expect((await app.request(`/api/resources/${encodeURIComponent(id)}`,{headers:{Cookie:`${config().SESSION_COOKIE}=${signSessionId(otherId)}`}})).status).toBe(404)
 await app.request(`/api/resources/${encodeURIComponent(id)}`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({title:'Revised',description:'Updated',skills:[skill]})})
 expect((await app.request(`/api/resources/${encodeURIComponent(id)}`)).status).toBe(404)
})
it('lets an author preserve or detach an existing unlisted class without allowing new private associations',async()=>{
 const event={uri:`at://${did}/community.lexicon.calendar.event/private`,cid:'bafyclass'},id=noteFixture(event)
 indexed.linkedClass={listed:false,hostDid:did}
 indexed.events=[{uri:event.uri,did,rkey:'private',cid:event.cid,record:{name:'Private class'}}]
 const app=createApp(),headers={Cookie:await cookie(),'Content-Type':'application/json'}
 const body={title:'Updated notes',description:'A useful note',skills:[skill]}
 expect((await app.request(`/api/resources/${encodeURIComponent(id)}`)).status).toBe(404)
 expect((await (await app.request(`/api/resources/${encodeURIComponent(id)}`,{headers})).json()).libraryStatus).toBe('class-unlisted')
 expect((await app.request(`/api/resources/${encodeURIComponent(id)}`,{method:'PUT',headers,body:JSON.stringify({...body,event})})).status).toBe(200)
 expect((await app.request('/api/resources',{method:'POST',headers,body:JSON.stringify({...body,event})})).status).toBe(400)
 expect((await app.request(`/api/resources/${encodeURIComponent(id)}`,{method:'PUT',headers,body:JSON.stringify(body)})).status).toBe(200)
 expect(writes.put.mock.calls.at(-1)?.[0].record.event).toBeUndefined()
})
it('keeps deleted notes gone for the author even if a school visibility flag is restored',async()=>{
 const id=noteFixture(),app=createApp(),headers={Cookie:await cookie()}
 expect((await app.request(`/api/resources/${encodeURIComponent(id)}`,{method:'DELETE',headers})).status).toBe(200)
 await testDb().insert(appMeta).values({key:`resource-hidden:${id}`,value:false,updatedAt:new Date()})
 expect((await app.request(`/api/resources/${encodeURIComponent(id)}`,{headers})).status).toBe(404)
 expect((await (await app.request('/api/my-resources',{headers})).json()).resources).toEqual([])
 expect((await app.request(`/api/resources/${encodeURIComponent(id)}`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({title:'Resurrected',description:'No',skills:[skill]})})).status).toBe(404)
})
