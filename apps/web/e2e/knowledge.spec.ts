import { expect, test } from '@playwright/test';

test('an author manages hidden notes, linked skills and license without republishing them', async ({ page }, testInfo) => {
  const did='did:plc:fixture-author';
  const id=`at://${did}/freeschool.draft.resource/one`;
  const skill='at://did:plc:school/freeschool.draft.skill/repair';
  const other='at://did:plc:school/freeschool.draft.skill/gardening';
  let resource={id,authorDid:did,authorName:'Community contributor',authorHasProfile:false,title:'Notes worth keeping',description:'An original note.',skills:[skill,other],license:'CC0',libraryStatus:'moderated',event:{uri:`at://${did}/community.lexicon.calendar.event/one`,cid:'class'}};
  let deleted=false;
  await page.route('**/api/auth/me',r=>r.fulfill({json:{did,role:20,kind:'custodial',isCustodial:true,emailVerified:true}}));
  await page.route('**/api/skills',r=>r.fulfill({json:{skills:[{uri:skill,label:'Repair',children:[]},{uri:other,label:'Gardening',children:[]}]}}));
  await page.route('**/api/events/*',r=>r.fulfill({json:{name:'A former class'}}));
  await page.route('**/api/resources',r=>r.fulfill({json:{resources:[]}}));
  await page.route('**/api/my-resources',r=>r.fulfill({json:{resources:deleted?[]:[resource]}}));
  await page.route('**/api/resources/*',async r=>{
    if(r.request().method()==='PUT') { resource={...resource,...r.request().postDataJSON()};if(!('event' in r.request().postDataJSON()))delete (resource as {event?:unknown}).event;return r.fulfill({json:{id}}); }
    if(r.request().method()==='DELETE'){deleted=true;return r.fulfill({json:{ok:true}});}
    return r.fulfill({status:deleted?404:200,json:deleted?{error:'NotFound'}:resource});
  });
  await page.goto('/knowledge');
  await expect(page.getByRole('heading',{name:'A notebook waiting to be filled.'})).toBeVisible();
  await page.getByRole('button',{name:'My contributions',exact:true}).click();
  await expect(page.getByText('Hidden by this school')).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('my-contributions.png')});
  await page.getByRole('link',{name:'Notes worth keeping',exact:true}).click();
  await expect(page.getByText('Hidden from this school’s library',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Edit these notes'}).click();
  await expect(page.getByLabel('License (optional)',{exact:true})).toHaveValue('CC0');
  await expect(page.getByLabel('Additional skill 1',{exact:true})).toHaveValue(other);
  await page.screenshot({path:testInfo.outputPath('edit-resource.png')});
  await page.getByRole('button',{name:'Detach from this class',exact:true}).click();
  await page.getByLabel('Field notes').fill('Revised without changing the school’s moderation decision.');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByText('Hidden from this school’s library',{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'From this class'})).toHaveCount(0);
  await expect(page.getByRole('link',{name:'Gardening',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Remove my resource',exact:true}).click();
  await page.getByRole('button',{name:'Confirm removal',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Your first contribution starts here.'})).toBeVisible();
});
