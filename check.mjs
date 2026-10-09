// Irembo provisoire (provisional driving-licence) slot checker.
//
// Drives the Irembo citizen portal with Playwright, walks the provisional
// test service for each exam type (mudasobwa/computer, impapuro/paper) and
// each target district, and writes the observed exam slots to result.json.
// Run by .github/workflows/provisoire-check.yml.
//
// result.json shape: { types: { mudasobwa: {districts}, impapuro: {districts} } }
// plus legacy top-level districts (= mudasobwa) for back-compat.
//
// Privacy: the applicant ID is scrubbed from every saved text, and district
// screenshots are cropped (top 30% removed) so the ID header never ships.
import { chromium } from 'playwright';
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ID defaults to the owner's number; override with the IREMBO_ID secret or a
// workflow_dispatch id_number input when needed.
const DEFAULT_ID = '1200480003683096';
const ID = (process.env.INPUT_ID || process.env.IREMBO_ID || DEFAULT_ID).trim();

// Per-type district lists, verified against Irembo's own Akarere dropdown on
// 2026-10-09 (dropdown dump, run 37905963666). Districts Irembo does not list
// for a type are never fetched for that type.
const EXAM_DISTRICTS = {
  mudasobwa: [
    'bugesera', 'gicumbi', 'gisagara', 'huye', 'karongi', 'kayonza',
    'kicukiro', 'kirehe', 'muhanga', 'musanze', 'ngororero', 'nyagatare',
    'nyamasheke', 'nyarugenge', 'ruhango', 'rutsiro', 'rwamagana',
  ],
  impapuro: [
    'bugesera', 'gicumbi', 'huye', 'karongi', 'muhanga', 'musanze',
    'ngoma', 'nyagatare', 'nyamagabe', 'nyanza', 'rubavu', 'rusizi',
    'rwamagana',
  ],
};
const DISTRICT_KEYS = [...new Set([...EXAM_DISTRICTS.mudasobwa, ...EXAM_DISTRICTS.impapuro])];
// Single-district test mode (workflow_dispatch `district` input): check only
// that district so one flow can be watched in isolation before sweeping all.
const ONLY_DISTRICT = (process.env.INPUT_DISTRICT || '').trim().toLowerCase();
if (ONLY_DISTRICT && !DISTRICT_KEYS.includes(ONLY_DISTRICT)) {
  console.error(`Unknown district: ${ONLY_DISTRICT} (expected one of: ${DISTRICT_KEYS.join(', ')})`);
  process.exit(1);
}
console.log(ONLY_DISTRICT ? `Single-district mode: ${ONLY_DISTRICT}` : `Full sweep: ${DISTRICT_KEYS.length} districts`);
const DISTRICTS = DISTRICT_KEYS.map((key) => ({ key, re: new RegExp(key, 'i') }));

// Exam types: computer-based first (back-compat default), then paper-based.
// Each type re-runs the whole portal flow in a fresh browser.
const EXAM_TYPES = [
  {
    key: 'mudasobwa',
    // Preferred service option, then acceptable fallback.
    serviceRes: [/agateganyo/i, /mudasobwa|computer/i],
    fallbackRes: [/agateganyo/i, null],
  },
  {
    key: 'impapuro',
    // Irembo writes it as one word "kumpapuro" — /mpapuro/ matches both spellings.
    serviceRes: [/agateganyo/i, /mpapuro/i],
    fallbackRes: null, // no fallback: a mudasobwa pick must never masquerade as impapuro
  },
];

const NAME = 'Herve';
const DOB = '28/12/2004'; // dd/mm/yyyy

if (!ID) {
  console.error('Missing ID: set secret IREMBO_ID or dispatch input id_number');
  process.exit(1);
}
console.log(`Checking ID ending ...${ID.slice(-4)}`);

// Scrub the applicant ID out of any saved text (result.json is public).
const scrub = (s) => String(s || '').split(ID).join('[hidden]');

async function runType(typeCfg) {
  const { key: typeKey } = typeCfg;
  const tag = (n) => `step-${typeKey}-${n}`;
  let typeKeys = EXAM_DISTRICTS[typeKey] || DISTRICT_KEYS;
  if (ONLY_DISTRICT) typeKeys = typeKeys.filter((k) => k === ONLY_DISTRICT);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    locale: 'rw-RW',
    viewport: { width: 1280, height: 900 },
    timezoneId: 'Africa/Kigali',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  const out = { steps: [] };

  // Viewport-clipped district screenshot: scroll the slot table into view,
  // then cut the top 30% (applicant/ID header) so the ID never ships.
  // NOTE: clipping alone is NOT enough — the applicant block sits mid-page.
  // So first scrub the ID out of the DOM (inputs + summary spans), then take
  // a full-page shot: slots fully visible, ID nowhere.
  async function clippedDistrictShot(key) {
    try {
      await page.evaluate((idNum) => {
        // 1) Blank any input holding a long digit string (the ID field).
        document.querySelectorAll('input').forEach((inp) => {
          try {
            const v = inp.value || '';
            if (v.replace(/\D/g, '').length >= 10) inp.value = '';
          } catch {}
        });
        // 2) Hide small elements whose text contains the ID.
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let el = null;
        const hide = [];
        while ((el = walker.nextNode())) {
          try {
            const t = el.innerText || '';
            if (t && t.includes(idNum) && t.length < 3000) hide.push(el);
          } catch {}
        }
        hide.forEach((e) => {
          e.style.display = 'none';
        });
        // 3) Hide the whole applicant summary card (Amakuru Y'usaba block).
        document.querySelectorAll('*').forEach((e) => {
          try {
            const t = e.innerText || '';
            if (/Amakuru Y['’]usaba/.test(t) && t.length < 600) {
              let p = e;
              for (let i = 0; i < 4 && p; i++) p = p.parentElement;
              if (p && p.style) p.style.display = 'none';
            }
          } catch {}
        });
      }, ID);
      await sleep(700);
      await page.screenshot({ path: `step-10-${typeKey}-district-${key}.png`, fullPage: true });
      return true;
    } catch {
      return false;
    }
  }

  try {
    await page.goto('https://irembo.gov.rw/', { waitUntil: 'networkidle', timeout: 90000 });
    await sleep(4000);
    await page.screenshot({ path: `${tag('01-home')}.png` });
    out.steps.push('home');

    // 1. Find "Kwiyandikisha gukora ikizamini" link/button
    const examLink = page.getByText(/kwiyandikisha.*kizamini/i).first();
    if (await examLink.count()) {
      await examLink.click({ timeout: 15000 });
      await sleep(5000);
    } else {
      fs.writeFileSync(`home-dump-${typeKey}.html`, (await page.content()).slice(0, 5000));
      throw new Error('exam link not found');
    }
    await page.screenshot({ path: `${tag('02-exam')}.png` });
    out.steps.push('exam');

    // 2. Service dropdown: pick this run's exam-type option
    const combo = page.locator('div[role="combobox"], .ng-input, .ng-select').first();
    if (await combo.count()) {
      await combo.click({ timeout: 15000 });
      await sleep(3000);
    }
    await page.screenshot({ path: `${tag('03-combo-open')}.png` });

    const opts = page.locator('[role="option"], .ng-option, .ng-dropdown-panel .ng-option');
    const nopt = await opts.count().catch(() => 0);
    console.log(`[${typeKey}] combo options=${nopt}`);
    try {
      const dump = await opts.allInnerTexts();
      fs.writeFileSync(`options-${typeKey}.json`, JSON.stringify(dump.slice(0, 50), null, 2));
      console.log(dump.slice(0, 20).join(' | ').slice(0, 1500));
    } catch {}

    async function tryPick([mustRe, wantRe]) {
      for (let i = 0; i < Math.min(nopt, 40); i++) {
        let t = '';
        try {
          t = await opts.nth(i).innerText({ timeout: 3000 });
        } catch {
          continue;
        }
        if (mustRe.test(t) && (!wantRe || wantRe.test(t))) {
          console.log(`[${typeKey}] pick service: ` + t.slice(0, 150));
          await opts.nth(i).click({ timeout: 8000 });
          await sleep(5000);
          return true;
        }
      }
      return false;
    }

    let picked = await tryPick(typeCfg.serviceRes);
    if (!picked && typeCfg.fallbackRes) {
      console.log(`[${typeKey}] fallback service pick`);
      picked = await tryPick(typeCfg.fallbackRes);
    }
    if (!picked) throw new Error(`service option not found for ${typeKey}`);
    await page.screenshot({ path: `${tag('03-polisi')}.png` });
    out.steps.push('service-picked');

    // 3. Click Saba to open the service page, then enter the ID there
    const saba = page.getByRole('button', { name: /saba/i }).first();
    if (await saba.count()) {
      await saba.click({ timeout: 15000 });
      await sleep(8000);
    }
    await page.screenshot({ path: `${tag('04-popup')}.png` });
    out.steps.push('popup');
    out.after_saba_url = page.url();
    out.after_saba_text = scrub((await page.evaluate(() => document.body.innerText || '')).slice(0, 2000));
    console.log(`[${typeKey}] after Saba: ` + out.after_saba_url);

    // 4. ID input on the service page
    let typed = false;
    for (const sel of ['input[name*="id" i]', 'input[placeholder*="ID" i]', 'input[type="text"]']) {
      const inputs = page.locator(sel);
      const n = await inputs.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 10); i++) {
        try {
          const inp = inputs.nth(i);
          if (await inp.isVisible()) {
            await inp.fill(ID, { timeout: 8000 });
            typed = true;
            break;
          }
        } catch {}
      }
      if (typed) break;
    }
    if (!typed) throw new Error('ID input not found');
    await sleep(1500);
    await page.screenshot({ path: `${tag('05-id-filled')}.png` });
    out.steps.push('id-filled');

    // 5. Proceed / Komeza button
    for (const pat of [/ibikurikira/i, /komeza/i, /proceed/i, /continue/i, /next/i, /ohereza/i]) {
      const b = page.getByRole('button', { name: pat }).first();
      try {
        if ((await b.count()) && (await b.isVisible()) && (await b.isEnabled())) {
          await b.click({ timeout: 8000 });
          await sleep(6000);
          break;
        }
      } catch {}
    }
    await page.screenshot({ path: `${tag('06-result')}.png` });
    out.steps.push('result');

    // 6. Gusuzuma popup: name + terms + Genzura, plus DOB if asked
    try {
      const nameInput = page.getByPlaceholder(/rimwe.*mazina|injiza.*mazina/i).first();
      if (await nameInput.count()) {
        await nameInput.fill(NAME, { timeout: 8000 });
        await sleep(1000);
        out.steps.push('name-filled');
      } else {
        const allInputs = page.locator('input[type="text"]');
        const nn = await allInputs.count().catch(() => 0);
        for (let i = 0; i < Math.min(nn, 10); i++) {
          try {
            const inp = allInputs.nth(i);
            if (await inp.isVisible()) {
              const v = await inp.inputValue().catch(() => '');
              if (!v) {
                await inp.fill(NAME, { timeout: 5000 });
                out.steps.push('name-filled');
                break;
              }
            }
          } catch {}
        }
      }

      // DOB if present: text or date input
      const dobSel = page.locator(
        'input[type="date"], input[placeholder*="birth" i], input[placeholder*="amavuko" i], input[placeholder*="itariki" i]',
      );
      if (await dobSel.count()) {
        const d = dobSel.first();
        try {
          if (await d.isVisible()) {
            const typ = await d.getAttribute('type');
            if (typ === 'date') {
              const [dd, mm, yyyy] = DOB.split('/');
              await d.fill(`${yyyy}-${mm}-${dd}`, { timeout: 8000 });
            } else {
              await d.fill(DOB, { timeout: 8000 });
            }
            out.steps.push('dob-filled');
          }
        } catch {}
      }
      await page.screenshot({ path: `${tag('07-verify-filled')}.png` });

      // terms checkbox - custom control, click label text
      try {
        const lbl = page.getByText(/nemeye/i).first();
        if (await lbl.count()) {
          await lbl.click({ timeout: 5000 });
          await sleep(1000);
        }
      } catch {}
      try {
        const chk2 = page.locator('input[type="checkbox"]').first();
        if (await chk2.count()) {
          try {
            await chk2.check({ force: true, timeout: 5000 });
          } catch {
            try {
              await chk2.click({ force: true, timeout: 5000 });
            } catch {}
          }
        }
      } catch {}

      const genzura = page.getByRole('button', { name: /genzura/i }).first();
      if (await genzura.count()) {
        await genzura.click({ timeout: 8000 });
        await sleep(8000);
        out.steps.push('genzura-clicked');
      }
      await page.screenshot({ path: `${tag('08-after-genzura')}.png` });
    } catch (e2) {
      out.verify_error = String(e2.message).slice(0, 300);
    }
    out.steps.push('verified');

    // 7. After verification: language Kinyarwanda, then each district's slots
    try {
      await page.evaluate(() => window.scrollBy(0, 800));
      await sleep(1500);

      async function pickDropdown(labelPat, optionPat) {
        try {
          await page.keyboard.press('Escape');
          await sleep(800);
        } catch {}
        // hide the help/chat overlays that intercept clicks
        try {
          await page.evaluate(() => {
            document.querySelectorAll('div').forEach((d) => {
              const t = (d.innerText || '').slice(0, 60);
              if (/Muraho!Ngufashe|Bona ibisubizo byihuse/i.test(t) && d.offsetParent) {
                d.style.display = 'none';
              }
            });
          });
        } catch {}

        // label-anchored: find the "Ururimi..."/"Akarere" label, click ng-select in the same row
        try {
          const labels = page.locator('label, span, div');
          const nl = await labels.count().catch(() => 0);
          for (let i = 0; i < Math.min(nl, 400); i++) {
            let t = '';
            try {
              t = await labels.nth(i).innerText({ timeout: 1000 });
            } catch {
              continue;
            }
            if (!labelPat.test(t) || t.length > 60) continue;
            try {
              const row = labels.nth(i).locator('xpath=ancestor::div[ng-select or .//ng-select][1]');
              const sel = row.locator('ng-select, .ng-select').first();
              const target = (await sel.count()) ? sel : page.locator('ng-select').nth(i % 5);
              await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
              await target.click({ timeout: 8000 });
              await sleep(2500);
              const o = page.locator('.ng-option').filter({ hasText: optionPat }).first();
              if (await o.count()) {
                await o.click({ timeout: 8000 });
                await sleep(3000);
                return true;
              }
              await page.keyboard.press('Escape');
            } catch {}
          }
        } catch {}

        try {
          const box = page.getByText(labelPat).first();
          if (await box.count()) {
            try {
              await box.scrollIntoViewIfNeeded({ timeout: 5000 });
            } catch {}
            await box.click({ timeout: 8000 });
            await sleep(2500);
            const opt = page
              .locator('[role="option"], .ng-option, li, div[role="listbox"] div')
              .filter({ hasText: optionPat })
              .first();
            if (await opt.count()) {
              try {
                await opt.scrollIntoViewIfNeeded({ timeout: 5000 });
              } catch {}
              await opt.click({ timeout: 8000 });
              await sleep(3000);
              return true;
            }
            const opt2 = page.getByText(optionPat).last();
            if (await opt2.count()) {
              await opt2.click({ timeout: 8000 });
              await sleep(3000);
              return true;
            }
          }
        } catch {}

        // try direct option text first (dropdowns render as Hitamo...)
        const combos = page.locator(
          'div[role="combobox"], .ng-select, .ng-input, select, div:has-text("Hitamo ururimi"), div:has-text("Hitamo akarere")',
        );
        const nc = await combos.count().catch(() => 0);
        for (let i = 0; i < Math.min(nc, 20); i++) {
          try {
            const c = combos.nth(i);
            if (!(await c.isVisible())) continue;
            const ctext = (await c.innerText().catch(() => '')).slice(0, 200);
            if (!labelPat.test(ctext)) continue;
            const tag = await c.evaluate((el) => el.tagName).catch(() => '');
            if (tag === 'SELECT') {
              await c.selectOption({ label: optionPat }).catch(async () => {
                const o = c.locator('option');
                const n = await o.count();
                for (let k = 0; k < n; k++) {
                  const t = await o.nth(k).innerText().catch(() => '');
                  if (optionPat.test(t)) {
                    await c.selectOption({ index: k });
                    break;
                  }
                }
              });
            } else {
              await c.click({ timeout: 8000 });
              await sleep(2500);
              const o2 = page.locator('[role="option"], .ng-option, li, div[role="listbox"] div');
              const n2 = await o2.count().catch(() => 0);
              for (let k = 0; k < Math.min(n2, 80); k++) {
                const t = await o2.nth(k).innerText().catch(() => '');
                if (optionPat.test(t)) {
                  await o2.nth(k).click({ timeout: 8000 });
                  break;
                }
              }
            }
            await sleep(3000);
            return true;
          } catch {}
        }

        // fallback: click the label text directly (scroll into view first)
        try {
          const hit = page.getByText(labelPat).first();
          if (await hit.count()) {
            try {
              await hit.scrollIntoViewIfNeeded({ timeout: 5000 });
            } catch {}
            await hit.click({ timeout: 8000 });
            await sleep(2500);
            const o3 = page.getByText(optionPat).first();
            if (await o3.count()) {
              try {
                await o3.scrollIntoViewIfNeeded({ timeout: 5000 });
              } catch {}
              await o3.click({ timeout: 8000 });
              await sleep(3000);
              return true;
            }
          }
        } catch {}
        return false;
      }

      await pickDropdown(/hitamo ururimi|ururimi ikizamini/i, /kinyarwanda/i);
      await page.screenshot({ path: `${tag('09-language')}.png`, fullPage: true });

      // Dump the Akarere dropdown options: the TRUE per-type district list
      // straight from Irembo (options-districts-<type>.json, uploaded as artifact).
      // Tells missing centers apart from flaky picks.
      try {
        const combosD = page.locator('div[role="combobox"], .ng-select, .ng-input, select');
        const ncd = await combosD.count().catch(() => 0);
        for (let i = 0; i < Math.min(ncd, 20); i++) {
          try {
            const c = combosD.nth(i);
            if (!(await c.isVisible().catch(() => false))) continue;
            const ctext = (await c.innerText().catch(() => '')).slice(0, 200);
            if (!/hitamo akarere|akarere/i.test(ctext)) continue;
            await c.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
            await c.click({ timeout: 8000 });
            await sleep(2500);
            const oo = page.locator('.ng-option, [role="option"]');
            const no = await oo.count().catch(() => 0);
            const names = [];
            for (let k = 0; k < Math.min(no, 60); k++) {
              try { names.push((await oo.nth(k).innerText({ timeout: 2000 })).trim()); } catch {}
            }
            fs.writeFileSync(`options-districts-${typeKey}.json`, JSON.stringify(names, null, 2));
            out._dropdownNames = names;
            console.log(`[${typeKey}] district options (${names.length}): ` + names.join(' | ').slice(0, 1200));
            break;
          } catch {}
        }
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(800);
      } catch {}

      out.districts = {};
      if (Array.isArray(out._dropdownNames) && out._dropdownNames.length) {
        const live = typeKeys.filter((k) => out._dropdownNames.some((n) => String(n).toLowerCase().includes(k)));
        if (live.length) {
          if (live.length !== typeKeys.length) console.log(`[${typeKey}] live dropdown trims ${typeKeys.length} -> ${live.length}: ` + live.join(','));
          typeKeys = live;
        }
      }
      for (const { key, re } of typeKeys.map((k) => ({ key: k, re: new RegExp(k, 'i') }))) {
        try {
          await pickDropdown(/hitamo akarere|akarere/i, re);
          await sleep(2000);
          // Verify the district actually switched: the page must name it.
          // Otherwise every district would capture the same default view with
          // copy-paste counts (seen once: identical totals across districts).
          let slotProbe = await page.evaluate(() => document.body.innerText || '').catch(() => '');
          if (!new RegExp(key, 'i').test(slotProbe)) {
            await pickDropdown(/hitamo akarere|akarere/i, re);
            await sleep(2000);
            slotProbe = await page.evaluate(() => document.body.innerText || '').catch(() => '');
          }
          if (!new RegExp(key, 'i').test(slotProbe)) {
            out.districts[key] = { error: 'district did not switch (page shows another district)' };
            console.log(`[${typeKey}] ${key} SKIPPED: district not switched`);
            continue;
          }
          await clippedDistrictShot(key);
          const slotText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
          const m = slotText.match(/imyanya[^\n]{0,120}/gi) || slotText.match(/nta mwanya[^\n]{0,120}/gi) || [];
          // Worker-grade row pattern (date/center/time/count across lines).
          const rows = [];
          const rowRe = /(\d{2}-\d{2}-\d{4})\s*\n([^\n]+)\n([^\n]*?\d{1,2}:\d{2}\s*(?:AM|PM)[^\n]*)\n(?:Imyanya|Umwanya)\s*\n(\d+)/gi;
          let rm;
          while ((rm = rowRe.exec(slotText)) && rows.length < 20) {
            rows.push({ date: rm[1], center: rm[2].trim(), time: rm[3].trim(), slots: Number(rm[4]) });
          }
          out.districts[key] = { imyanya: m.slice(0, 10), rows, has_slots: rows.length > 0, text: scrub(slotText).slice(0, 1500) };
          console.log(`[${typeKey}] ${key} IMYANYA rows=${rows.length}`);
        } catch (eD) {
          out.districts[key] = { error: String(eD.message).slice(0, 200) };
        }
      }

      const first = out.districts.nyamasheke || {};
      out.slot_text = first.text || '';
      out.imyanya = first.imyanya || [];
      out.has_slots = !!first.has_slots;

      const nextBtn2 = page.getByRole('button', { name: /ibikurikira/i }).first();
      try {
        const dis = await nextBtn2.isDisabled().catch(() => null);
        out.next_disabled = dis;
        if (dis === false) {
          await nextBtn2.click({ timeout: 8000 });
          await sleep(8000);
          out.steps.push('next-clicked');
        }
      } catch (eN) {
        out.applicant_error = String(eN.message).slice(0, 300);
      }
      await page.screenshot({ path: `${tag('10-applicant')}.png`, fullPage: true });
      out.steps.push('applicant-handled');
    } catch (e3) {
      out.applicant_error = String(e3.message).slice(0, 300);
    }

    out.body_text = scrub((await page.evaluate(() => document.body.innerText || '')).slice(0, 4000));
    console.log(scrub(out.body_text).slice(0, 1500));
  } catch (e) {
    out.error = String(e.message).slice(0, 500);
    console.error(`[${typeKey}] CHECK FAILED:`, e.message);
    try {
      await page.screenshot({ path: `${tag('ERR')}.png` });
    } catch {}
  } finally {
    await browser.close();
  }
  return out;
}

const finalOut = { started_at: new Date().toISOString(), steps: [], types: {} };
for (const typeCfg of EXAM_TYPES) {
  console.log(`==== exam type: ${typeCfg.key} ====`);
  const part = await runType(typeCfg);
  finalOut.types[typeCfg.key] = {
    districts: part.districts || {},
    slot_text: part.slot_text || '',
    imyanya: part.imyanya || [],
    has_slots: !!part.has_slots,
  };
  finalOut.steps.push(...(part.steps || []).map((s) => `${typeCfg.key}:${s}`));
  if (part.error) finalOut.error = `[${typeCfg.key}] ${part.error}`;
  if (part.verify_error) finalOut.verify_error = `[${typeCfg.key}] ${part.verify_error}`;
  if (part.applicant_error) finalOut.applicant_error = `[${typeCfg.key}] ${part.applicant_error}`;
}
// Legacy top-level shape (= mudasobwa) for back-compat consumers.
const legacy = finalOut.types.mudasobwa || { districts: {} };
finalOut.districts = legacy.districts;
finalOut.slot_text = legacy.slot_text || '';
finalOut.imyanya = legacy.imyanya || [];
finalOut.has_slots = !!legacy.has_slots;
finalOut.finished_at = new Date().toISOString();
fs.writeFileSync('result.json', JSON.stringify(finalOut, null, 2));
