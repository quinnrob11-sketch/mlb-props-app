import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
const errors = [], logs = [];
p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); else logs.push(m.text()); });
await p.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
console.log('TITLE:', await p.title());
console.log('HEADER:', (await p.locator('.hdr-title').first().textContent().catch(()=> 'none')));
console.log('TABS:', await p.locator('.tab').allTextContents());
console.log('STATUS:', await p.locator('.statusline').first().textContent().catch(()=>''));
// hit LOAD SLATE
const btn = p.locator('button.btn-primary');
console.log('BUTTON:', await btn.textContent());
await btn.click();
await p.waitForTimeout(3000);
for (let i = 0; i < 40; i++) {
  const s = await p.locator('.statusline').first().textContent();
  if (!/…|Fetching|Loading/.test(s || '')) break;
  await p.waitForTimeout(2000);
}
console.log('STATUS AFTER:', await p.locator('.statusline').first().textContent());
console.log('STRIP:', (await p.locator('.strip').first().innerText().catch(()=>'')).replace(/\n/g,' | '));
console.log('TABS AFTER:', await p.locator('.tab').allTextContents());
console.log('ROWS:', await p.locator('table tbody tr').count());
console.log('BANNERS:', await p.locator('.banner').allTextContents());
console.log('--- ERRORS ---'); errors.slice(0,15).forEach(e=>console.log(e));
await p.screenshot({ path: 'shot-pitchers.png', fullPage: false });
await b.close();
