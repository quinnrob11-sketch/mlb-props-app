import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
await p.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await p.locator('button.btn-primary').click();
for (let i = 0; i < 40; i++) {
  const s = await p.locator('.statusline').first().textContent();
  if (!/…|Fetching|Loading|Projecting/.test(s || '')) break;
  await p.waitForTimeout(2000);
}
await p.waitForTimeout(1000);
console.log('TOOLBAR:', (await p.locator('.toolbar').first().innerText()).replace(/\n/g,' | '));
await p.screenshot({ path: 'shot-best.png' });

// BATTERS tab
await p.locator('.tab', { hasText: 'BATTERS' }).click();
await p.waitForTimeout(600);
console.log('BATTER ROWS:', await p.locator('table tbody tr').count());
const firstRows = await p.locator('table tbody tr').first().innerText();
console.log('FIRST ROW:', firstRows.replace(/\n/g,' | '));
console.log('PROJ LINEUP FLAGS:', await p.locator('.flag', { hasText: 'PROJ LINEUP' }).count());
await p.screenshot({ path: 'shot-batters.png' });

// open filter modal
const fbtn = p.locator('button', { hasText: 'Filters' }).first();
await fbtn.click();
await p.waitForTimeout(500);
console.log('MODAL HEADS:', await p.locator('.modal h4').allTextContents());
console.log('MODAL SUMMARY:', await p.locator('.modal').first().innerText().split('\n')[1]);
await p.screenshot({ path: 'shot-filters.png' });
await p.locator('.modal button', { hasText: 'Done' }).click();
await p.waitForTimeout(300);

// apply a chip filter and confirm counts change
const before = await p.locator('table tbody tr').count();
await p.locator('.chip', { hasText: 'No small sample' }).first().click();
await p.waitForTimeout(600);
const after = await p.locator('table tbody tr').count();
console.log(`SMALL-SAMPLE CHIP: rows ${before} -> ${after}`);
console.log('--- ERRORS ---'); errs.slice(0,10).forEach(e => console.log(e));
await b.close();
