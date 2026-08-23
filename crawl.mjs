// crawl.mjs - liest Spielplan + Tabelle der HSG Varel (1. Herren, 3. Liga) von handball.net
// und schreibt handball-data.json im HSG-Schema. Laeuft in GitHub Actions (headless).
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const TEAM = '87310';
const SEASON = '2627';
const URL = `https://www.handball.net/team/${TEAM}?season_id=${SEASON}`;
const OUT = process.env.OUT || 'handball-data.json';
const WEEKS_BACK = 5;
const WEEKS_FWD = 14;

function iso(dmy) {
  const m = dmy.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
function titleCase(s) {
  if (!s) return s;
  return s.split(' ').map(w => /^(II|III|IV|SG|SV|HSG|HC|TV|TSV|VfL|TuS|MTV|ESG|MT|DJK|HF)$/i.test(w)
    ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    .replace(/\bIi\b/g, 'II').replace(/\bIii\b/g, 'III');
}

async function consent(page) {
  for (const fr of [page, ...page.frames()]) {
    for (const t of ['Alle akzeptieren', 'Akzeptieren', 'Zustimmen']) {
      try { const b = fr.getByRole('button', { name: new RegExp('^' + t, 'i') }); if (await b.count()) { await b.first().click({ timeout: 2500 }); return; } } catch {}
    }
  }
}
async function clickTab(page, re) {
  const b = page.locator('nav.dhb-tabs-nav button.tab-btn').filter({ hasText: re });
  if (await b.count()) { await b.first().click(); await page.waitForTimeout(3500); return true; }
  return false;
}

const isLogo = s => typeof s === 'string' && /^https?:/.test(s) && !/\.svg(\?|$)/i.test(s);

async function scrapeTable(page) {
  await clickTab(page, /tabelle/i);
  const rows = await page.evaluate(() => [...document.querySelectorAll('table tr')]
    .filter(tr => tr.querySelectorAll('td').length >= 5)
    .map(tr => {
      const img = tr.querySelector('img');
      return { cells: [...tr.children].map(x => (x.textContent || '').trim()), logo: img ? img.getAttribute('src') : null };
    }));
  return rows.map(({ cells: c, logo }) => ({
    pos: Number(c[0]) || 0,
    team: titleCase(c[1]),
    logo: isLogo(logo) ? logo : null,
    sp: Number(c[2]) || 0,
    punkte: c[3] || '0:0',
    diff: c[4] || '',
    isSelf: /varel/i.test(c[1]),
  })).filter(r => r.team && !/^PL/i.test(String(r.pos)));
}

// card = { text, logos:[{alt,src}] }. Namen aus dem Kartentext (zuverlaessig via
// Wiederholungs-Muster "HOME<zeit|score>AWAY HOME AWAY..."); Logos per Name zugeordnet.
const norm = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function parseMatch(card) {
  const raw = card.text;
  const logos = (card.logos || []).filter(l => isLogo(l.src) && l.alt);
  const dm = raw.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
  const date = dm ? iso(dm[1]) : null;
  const finished = /BEENDET|ENDE(?!R)/i.test(raw);
  const live = /\bLIVE\b/i.test(raw);

  // Prefix (Datum, Liga, Status) abschneiden
  let rest = raw.replace(/^.*?(ANSTEHEND|BEENDET|LIVE|VORSCHAU|ENDE)\s*/i, '');
  if (rest === raw) rest = raw.replace(/^.*?Nord-West\s*/i, '').replace(/^.*?\d{4}\s*/, '');

  let home = null, away = null, time = null, hg = null, ag = null;
  let m = rest.match(/^(.+?)(\d{2}:\d{2})\s*UHR(.+?)\1/);           // geplant, wiederholt
  if (m) { home = m[1].trim(); time = m[2]; away = m[3].trim(); }
  else if ((m = rest.match(/^(.+?)(\d{1,2}):(\d{1,2})(.+?)\1/))) {  // gespielt, wiederholt
    home = m[1].trim(); hg = Number(m[2]); ag = Number(m[3]); away = m[4].trim();
  } else if ((m = rest.match(/^(.+?)(\d{2}:\d{2})\s*UHR(.+?)$/))) { // geplant, einmalig
    home = m[1].trim(); time = m[2]; away = m[3].trim();
  }
  if (!time) { const tm = raw.match(/(\d{2}:\d{2})\s*UHR/i); if (tm) time = tm[1]; }
  // Fallback: Namen aus Logo-Alts, falls Text nichts lieferte
  if (!home && logos[0]) home = logos[0].alt;
  if (!away && logos[1]) away = logos[1].alt;

  // Logos per Name zuordnen (exakt, sonst Teilstring) - fehlt eins, bleibt es null (Badge)
  const logoFor = name => {
    const n = norm(name); if (!n) return null;
    const hit = logos.find(l => norm(l.alt) === n)
      || logos.find(l => norm(l.alt).includes(n) || n.includes(norm(l.alt)));
    return hit ? hit.src : null;
  };
  const homeLogo = logoFor(home), awayLogo = logoFor(away);

  const compM = raw.match(/(\d\.\s*Liga[^]*?)(?:ANSTEHEND|BEENDET|LIVE|ENDE|\d{2}:\d{2})/);
  const competition = compM ? compM[1].trim().replace(/\s+/g, ' ') : '3. Liga';
  return {
    date, time, competition,
    home: titleCase(home), away: titleCase(away), homeLogo, awayLogo,
    homeGoals: finished ? hg : null, awayGoals: finished ? ag : null,
    status: finished ? 'finished' : (live ? 'live' : 'scheduled'),
  };
}

async function scrapeSchedule(page) {
  await clickTab(page, /spielplan/i);
  await page.waitForTimeout(1000);
  const prev = page.locator('button.nav-arrow.prev:visible').first();
  const next = page.locator('button.nav-arrow.next:visible').first();
  for (let i = 0; i < WEEKS_BACK; i++) { try { await prev.click({ timeout: 5000 }); await page.waitForTimeout(1300); } catch { break; } }
  const seen = new Set(); const matches = [];
  for (let i = 0; i < WEEKS_BACK + WEEKS_FWD; i++) {
    const cards = await page.evaluate(() => [...document.querySelectorAll('.card-main-trigger')].map(el => {
      const logos = [];
      for (const img of el.querySelectorAll('img')) {
        const src = img.getAttribute('src') || '', alt = (img.getAttribute('alt') || '').trim();
        if (/^https?:/.test(src) && alt && !logos.some(l => l.alt === alt)) logos.push({ alt, src });
      }
      return { text: (el.textContent || '').replace(/\s+/g, ' ').trim(), logos };
    }));
    for (const card of cards) {
      if (!/varel/i.test(card.text)) continue;
      const key = card.text.slice(0, 60);
      if (seen.has(key)) continue; seen.add(key);
      const mt = parseMatch(card);
      if (mt.date && mt.home && mt.away) matches.push(mt);
    }
    try { await next.click({ timeout: 5000 }); await page.waitForTimeout(1300); } catch { break; }
  }
  matches.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return matches;
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ locale: 'de-DE', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500); await consent(page); await page.waitForTimeout(1500);

  const standings = await scrapeTable(page);
  const matches = await scrapeSchedule(page);

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = matches.filter(m => m.status !== 'finished' && (m.date >= today));
  const finished = matches.filter(m => m.status === 'finished' || (m.date < today && m.homeGoals != null));

  const data = {
    lastUpdated: new Date().toISOString(),
    source: URL,
    team: { id: Number(TEAM), name: 'HSG Varel' },
    season: { id: Number(SEASON), name: 'Saison 2026/2027' },
    nextMatch: upcoming[0] || null,
    lastMatch: finished.at(-1) || null,
    matches,
    standings: standings.length ? standings : null,
  };
  writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8');
  console.log(`OK: ${matches.length} Spiele, ${standings.length} Tabellenzeilen -> ${OUT}`);
  if (matches[0]) console.log('Beispiel-Spiel:', JSON.stringify(matches.find(m=>m.home) || matches[0]));
  if (standings.find(s=>s.isSelf)) console.log('HSG-Zeile:', JSON.stringify(standings.find(s=>s.isSelf)));
} finally {
  await browser.close();
}
