/** Local-only, explicitly fictional linked knowledge fixtures. */
import { readFile } from 'node:fs/promises'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { getDb, closeDb } from '../src/db/index.js'
import { appMeta, session } from '../src/db/schema.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'

const c=config(),did=process.env.ARTWORK_HOST_DID
const local=(url:string)=>['localhost','127.0.0.1'].includes(new URL(url).hostname)
if(c.isProd || !local(c.DATABASE_URL)||!local(c.PDS_URL)||!local(c.APPVIEW_PUBLIC_URL)||!did)throw new Error('Use an existing local test host and local development services')
const id=await createSession({header:()=>{}} as unknown as Context,did,'custodial')
const headers={'Content-Type':'application/json',Cookie:`${c.SESSION_COOKIE}=${signSessionId(id)}`}
async function request(path:string,method='GET',body?:unknown){const res=await fetch(`${c.APPVIEW_PUBLIC_URL}/api${path}`,{method,headers,body:body?JSON.stringify(body):undefined});if(!res.ok)throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);return res.json()}
try {
 const tree=await request('/skills')
 type Skill={uri:string;label:string;children:Skill[]}
 const flatten=(items:Skill[]):Skill[]=>items.flatMap(s=>[s,...flatten(s.children??[])])
 const skills=flatten(tree.skills)
 const skill=skills.find(s=>/bicycle|bike/i.test(s.label))??skills.find(s=>/repair/i.test(s.label))??skills[0]!
 const events=JSON.parse(await readFile(new URL('../../../fixtures/artwork/events.json',import.meta.url),'utf8'))
 const eventUri=decodeURIComponent(new URL(events[1].url).pathname.slice('/events/'.length))
 const avatar=await readFile(new URL('../../../fixtures/artwork/botanical-square.webp',import.meta.url))
 await request('/me','PUT',{avatar:{data:`data:image/webp;base64,${avatar.toString('base64')}`,alt:'Colorful illustrated nasturtiums; generated demo artwork'},displayName:'The courtyard notebook · demo',bio:'A fictional workshop host for exploring the design. A place for useful notes, generous questions, and things we learn by making together.',publicListing:true})
 await request('/me/skill-claims','PUT',{claims:[{skill:skill.uri,level:'teaching',note:'A fictional self-description for the design preview, not an endorsement or credential.',visibility:'public'}]})
 await request(`/events/${encodeURIComponent(eventUri)}`,'PUT',{skills:[{skill:skill.uri,level:1}]})
 const notes=[
  {title:'A repair table anyone can join',description:'DESIGN DEMO · Start with introductions, a shared table, and a clear question: what would you like to understand about your bicycle? Leave room for watching as well as doing. Pair an experienced neighbor with someone who is trying for the first time.\n\nOur best tool was a little patience. Write down what you tried, what worked, and what you want to ask next time.',event:{uri:eventUri,cid:''}},
  {title:'Keep a notebook of the small discoveries',description:'DESIGN DEMO · You do not need to be an expert to leave a useful note. Sketch the part you learned to recognize. Name the tool someone lent you. Record the question that changed how you looked at the problem.\n\nThese small observations become a trail another learner can follow.'},
  {title:'Before the next gathering',description:'DESIGN DEMO · Ask what participants want to learn. Make the route into the space easy to describe. Share whether tools and materials are supplied. Invite people to bring a question, even if they have nothing to repair.\n\nAfterwards, add one thing you learned to the shared notebook.'},
 ]
 for(const [i,note] of notes.entries()) {
   const key=`design-knowledge-fixture:v1:${i}`
   const [stored]=await getDb().select().from(appMeta).where(eq(appMeta.key,key))
   const prior=(stored?.value as {id?:string}|undefined)?.id
   const result=await request(prior?`/resources/${encodeURIComponent(prior)}`:'/resources',prior?'PUT':'POST',{...note,skills:[skill.uri],license:'CC0'})
   await getDb().insert(appMeta).values({key,value:result,updatedAt:new Date()}).onConflictDoUpdate({target:appMeta.key,set:{value:result,updatedAt:new Date()}})
   console.log(`Ready: ${note.title}`)
 }
 console.log(`Skill preview: http://localhost:5173/skills/${encodeURIComponent(skill.uri)}`)
} finally {await getDb().delete(session).where(eq(session.id,id));await closeDb()}
