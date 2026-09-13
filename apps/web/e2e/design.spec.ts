import { test, expect } from '@playwright/test';

for (const trim of ['Letter','A4']) test(`busy zine prints complete, bounded ${trim} pages`,async({page},testInfo)=>{
  const events=Array.from({length:80},(_,i)=>({uri:`at://did:plc:fixture/community.lexicon.calendar.event/class${i}`,name:`Class ${String(i).padStart(2,'0')} — ${i%5===0?'A thoughtful and unusually long title about learning things together in the neighborhood':'Neighborhood skill sharing'}`,startsAt:'2026-09-14T16:00:00Z',endsAt:'2026-09-14T18:00:00Z',locationRedacted:true,neighborhood:'Around the neighborhood',tags:['skillshare','design-demo'],venueNeeded:false}));
  await page.route('**/api/zine/*',route=>route.fulfill({json:{month:'2026-09',school:{name:'Boulder Free School',region:'Boulder'},days:[{date:'2026-09-14',events}],howToPost:'Give your class a tag the school routes on (ask a steward which ones, or use skillshare) and set it to listed before the month starts. A class with no venue yet still makes the zine — it is marked venue needed so a reader can offer one.'}}));
  await page.goto('/zine');
  await expect(page.getByRole('button',{name:'Print',exact:true})).toBeEnabled();
  if(trim==='A4')await page.getByRole('button',{name:'A4',exact:true}).click();
  await page.evaluate(()=>document.fonts.ready);
  const articles=page.locator('.zine-sheet');
  await expect.poll(()=>articles.count()).toBeGreaterThan(1);
  await expect(page.locator('.zine-sheet .zine-entry')).toHaveCount(80);
  const overflow=await page.locator('.zine-sheet').evaluateAll(sheets=>sheets.flatMap(sheet=>{
    const footer=sheet.querySelector('footer')!.getBoundingClientRect();
    return Array.from(sheet.querySelectorAll('.zine-entry')).filter(entry=>entry.getBoundingClientRect().bottom>footer.top-5).map(entry=>entry.textContent);
  }));
  expect(overflow).toEqual([]);
  const count=await articles.count();
  const pdf=await page.pdf({path:testInfo.outputPath(`zine-${trim}.pdf`),preferCSSPageSize:true,printBackground:true});
  expect((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)??[]).length).toBe(count);
});

test('calendar switches between month, day, week and list with working class links',async({page})=>{
  await page.goto('/?view=list&date=2026-09-14');
  await page.getByRole('button',{name:'Month',exact:true}).click();
  await expect(page.locator('.month-grid')).toBeVisible();
  await page.getByRole('button',{name:'View Monday, September 14, 2026',exact:true}).click();
  await expect(page.locator('.calendar-single-day')).toBeVisible();
  await expect(page.getByRole('button',{name:'Next day',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Week',exact:true}).click();
  await expect(page.locator('.week-grid .calendar-cell')).toHaveCount(7);
  await page.getByRole('button',{name:'List',exact:true}).click();
  await expect(page.locator('.calendar-list')).toBeVisible();
});

 test('phone month fits all seven days and date navigation survives reload',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/?view=month&date=2026-09-14');
  await expect(page.locator('.month-grid')).toBeVisible();
  const widths=await page.locator('.calendar-board-month').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client+1);
  await page.getByRole('button',{name:'View Monday, September 14, 2026',exact:true}).click();
  await page.getByRole('button',{name:'Next day',exact:true}).click();
  await page.reload();
  await expect(page.locator('.calendar-single-day')).toBeVisible();
  await expect(page).toHaveURL(/date=2026-09-15/);
 });
