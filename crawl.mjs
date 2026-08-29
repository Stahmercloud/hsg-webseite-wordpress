// crawl.mjs - liest Spielplan + Tabelle der HSG Varel (1. Herren, 3. Liga) von handball.net
// und schreibt handball-data.json im HSG-Schema. Laeuft in GitHub Actions (headless).
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const TEAM = '87310';
const SEASON = '2627';
const URL = `https://www.handball.net/team/${TEAM}?season_id=${SEASON}`;
const OUT = process.env.OUT || 'handball-data.json';
const WEEKS_BACK = 45;  // bis Saisonbeginn zurueck (kompletter Spielplan)
const WEEKS_FWD = 45;   // bis Saisonende voraus

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

// card = { text, logos, date, league, status, home:{name,logo}, away:{name,logo}, score, time }
// Namen, Logos, Zeit und Ergebnis kommen aus dem DOM der Spielkarte (.match-desktop).
// Der alte Textparser ist nur noch Notnagel, falls handball.net die Struktur umbaut: er
// verliess sich auf das Wiederholungs-Muster "HOME<zeit|score>AWAY HOME AWAY" und zerlegte
// Live-/Beendet-Karten falsch, weil dort Uhrzeit und Spielstand ineinander rutschen.
const norm = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const badName = n => !n || n.trim().length < 2 || n.length > 60 || /\d{1,2}:\d{2}|\bUHR\b/i.test(n);

function parseFromText(raw) {
  let rest = raw.replace(/^.*?(ANSTEHEND|BEENDET|LIVE|VORSCHAU|ENDE)\s*/i, '');
  if (rest === raw) rest = raw.replace(/^.*?Nord-West\s*/i, '').replace(/^.*?\d{4}\s*/, '');
  let out = {}, m;
  if ((m = rest.match(/^(.+?)(\d{2}:\d{2})\s*UHR(.+?)\1/))) out = { home: m[1], time: m[2], away: m[3] };
  else if ((m = rest.match(/^(.+?)(\d{1,2}):(\d{1,2})(.+?)\1/))) out = { home: m[1], hg: Number(m[2]), ag: Number(m[3]), away: m[4] };
  else if ((m = rest.match(/^(.+?)(\d{2}:\d{2})\s*UHR(.+?)$/))) out = { home: m[1], time: m[2], away: m[3] };
  if (out.home) out.home = out.home.trim();
  if (out.away) out.away = out.away.trim();
  return out;
}

function parseMatch(card) {
  const raw = card.text || '';
  const state = (card.status || '') + ' ' + raw;
  const finished = /BEENDET|\bfinished\b|ENDE(?!R)/i.test(state);
  const live = !finished && /\bLIVE\b/i.test(state);

  const dm = (card.date || raw).match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
  const date = dm ? iso(dm[1]) : null;

  let home = card.home && card.home.name, away = card.away && card.away.name;
  let homeLogo = (card.home && card.home.logo) || null, awayLogo = (card.away && card.away.logo) || null;
  const tm = (card.time || '').match(/(\d{1,2}:\d{2})/);
  let time = tm ? tm[1] : null;
  const sm = (card.score || '').match(/(\d{1,3})\s*:\s*(\d{1,3})/);
  let hg = sm ? Number(sm[1]) : null, ag = sm ? Number(sm[2]) : null;

  if (badName(home) || badName(away)) {          // DOM unbrauchbar -> Textparser als Notnagel
    const t = parseFromText(raw);
    home = badName(t.home) ? null : t.home;
    away = badName(t.away) ? null : t.away;
    homeLogo = awayLogo = null;                  // Logos dann ueber die Alt-Texte zuordnen
    if (!time && t.time) time = t.time;
    if (hg == null && t.hg != null) { hg = t.hg; ag = t.ag; }
  }

  // Logos per Name zuordnen (exakt, sonst Teilstring) - fehlt eins, bleibt es null (Badge)
  const logos = (card.logos || []).filter(l => isLogo(l.src) && l.alt);
  const logoFor = name => {
    const n = norm(name); if (!n) return null;
    const hit = logos.find(l => norm(l.alt) === n)
      || logos.find(l => norm(l.alt).includes(n) || n.includes(norm(l.alt)));
    return hit ? hit.src : null;
  };
  if (!home && logos[0]) home = logos[0].alt;
  if (!away && logos[1]) away = logos[1].alt;
  if (!homeLogo) homeLogo = logoFor(home);
  if (!awayLogo) awayLogo = logoFor(away);
  if (!time) { const t2 = raw.match(/(\d{1,2}:\d{2})\s*UHR/i); if (t2) time = t2[1]; }

  const compM = raw.match(/(\d\.\s*Liga[^]*?)(?:ANSTEHEND|BEENDET|LIVE|ENDE|\d{2}:\d{2})/);
  const competition = (card.league || (compM ? compM[1] : '3. Liga')).trim().replace(/\s+/g, ' ');
  const withScore = (finished || live) && hg != null;
  return {
    date, time, competition,
    home: titleCase(home), away: titleCase(away), homeLogo, awayLogo,
    homeGoals: withScore ? hg : null, awayGoals: withScore ? ag : null,
    status: finished ? 'finished' : (live ? 'live' : 'scheduled'),
  };
}

async function scrapeSchedule(page) {
  await clickTab(page, /spielplan/i);
  await page.waitForTimeout(1000);
  const prev = page.locator('button.nav-arrow.prev:visible').first();
  const next = page.locator('button.nav-arrow.next:visible').first();
  for (let i = 0; i < WEEKS_BACK; i++) { try { await prev.click({ timeout: 5000 }); await page.waitForTimeout(900); } catch { break; } }
  const seen = new Set(); const matches = [];
  for (let i = 0; i < WEEKS_BACK + WEEKS_FWD; i++) {
    const cards = await page.evaluate(() => {
      const txt = el => el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const logoSrc = img => {
        if (!img) return null;
        const s = img.getAttribute('src') || img.getAttribute('data-cmp-src') || '';
        return /^https?:/.test(s) ? s : null;
      };
      return [...document.querySelectorAll('.card-main-trigger')].map(el => {
        const logos = [];
        for (const img of el.querySelectorAll('img')) {
          const src = img.getAttribute('src') || '', alt = (img.getAttribute('alt') || '').trim();
          if (/^https?:/.test(src) && alt && !logos.some(l => l.alt === alt)) logos.push({ alt, src });
        }
        // Desktop-Block: eindeutige Heim-/Gastseite. Fehlt er, dienen die Mobil-Zeilen
        // in der Reihenfolge Heim, Gast als Ersatz.
        const box = el.querySelector('.match-desktop') || el;
        const rows = [...box.querySelectorAll('.team-row')];
        const side = (cls, idx) => {
          const a = box.querySelector('a.' + cls) || (rows[idx] ? rows[idx].querySelector('a.team-link') : null);
          if (!a) return null;
          const img = a.querySelector('img.team-logo');
          return {
            name: txt(a.querySelector('.team-name')) || (img ? (img.getAttribute('alt') || '').trim() : ''),
            logo: logoSrc(img),
          };
        };
        const sc = box.querySelector('.score-container');
        const badge = el.querySelector('.match-status-badge');
        return {
          text: txt(el),
          logos,
          date: txt(el.querySelector('.match-date')),
          league: txt(el.querySelector('.league-name')),
          status: txt(badge) + ' ' + (badge ? badge.className : '') + ' ' + (sc ? sc.className : ''),
          home: side('home-team', 0),
          away: side('away-team', 1),
          score: txt(sc && sc.querySelector('.score-text')),
          time: txt(sc && sc.querySelector('.time')),
        };
      });
    });
    for (const card of cards) {
      if (!/varel/i.test(card.text)) continue;
      const mt = parseMatch(card);
      if (!mt.date || !mt.home || !mt.away) continue;
      const key = mt.date + '|' + mt.home + '|' + mt.away;   // Live-Karten aendern ihren Text
      if (seen.has(key)) continue; seen.add(key);
      matches.push(mt);
    }
    try { await next.click({ timeout: 5000 }); await page.waitForTimeout(900); } catch { break; }
  }
  matches.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return matches;
}

const normTeam = s => (s || '').toUpperCase().replace(/ß/g, 'SS').replace(/[^A-Z0-9]/g, '');

// ---- Ticket-Events (ditix, oeffentlich, kein Token) ----
// Liefert Heimspiel-Tickets UND Fanfahrten (Events mit "Fanfahrt" im Namen, meist Auswaertsspiele).
// Volles Event-Objekt (Halle, Bild, Zeiten) landet als ticketEvents-Block in der JSON
// und wird von der Ticketshop-Seite nativ gerendert.
const berlinParts = ts => new Date(ts).toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }); // "2026-09-05 19:30:00"
async function fetchTicketEvents() {
  try {
    const html = await (await fetch('https://anker.ditix.shop/shop', { headers: { 'user-agent': 'Mozilla/5.0' } })).text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const props = m ? (JSON.parse(m[1])?.props?.pageProps || {}) : {};
    const list = props.initialEvents?.getEventList || {};
    const events = list.data || [];
    if (list.total > events.length) console.error(`Tickets-Warnung: Shop meldet ${list.total} Events, Seite 1 liefert nur ${events.length}`);
    const IMG_BASE = 'https://crud.production.ditix-production.services.ditix.app/file/image';
    return events.filter(e => e.code && e.isPublished !== false && e.state !== 'CANCELED').map(e => ({
      name: e.name || '',
      opponent: (e.name || '').replace(/^HSG Varel\s*[-–]\s*/i, '').trim(),
      date: e.timestampStart ? berlinParts(e.timestampStart).slice(0, 10) : null,
      time: e.timestampStart && !e.hideEventDatesInShop ? berlinParts(e.timestampStart).slice(11, 16) : null,
      timestampStart: e.timestampStart || null,
      timestampEnd: e.timestampEnd || null,
      venue: e.location?.name || null,
      image: props.tenantId && e.coverImage?.id ? `${IMG_BASE}/${props.tenantId}/${e.coverImage.id}` : null,
      url: `https://anker.ditix.shop/event/${e.code}`,
      isFanfahrt: /fanfahrt/i.test(e.name || ''),
    }));
  } catch (e) { console.error('Tickets-Fehler:', e.message); return []; }
}

// ---- Livestreams (sporteurope, oeffentliche Assets-API, kein Token) ----
const SE_PROFILE = '9f57a72b-284f-4a38-888f-8f271fdd8b1a'; // Profil hsg-varel-maenner
const SE_CHANNEL = 'https://sporteurope.tv/hsg-varel-maenner';
async function fetchStreams() {
  try {
    const r = await fetch(`https://api.sporteurope.tv/api/web/public/profiles/${SE_PROFILE}/assets?page=1&per_page=100&lang=de`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const assets = (await r.json()).data || [];
    return assets
      .filter(a => a.home_team?.slug === 'hsg-varel-maenner' || a.guest_team?.slug === 'hsg-varel-maenner')
      .map(a => ({
        date: (a.content_start_date || '').slice(0, 10),
        url: a.profile?.slug && a.slug ? `https://sporteurope.tv/${a.profile.slug}/${a.slug}` : null,
        live: !!a.currently_live,
      }))
      .filter(a => a.date && a.url);
  } catch (e) { console.error('Streams-Fehler:', e.message); return []; }
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ locale: 'de-DE', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500); await consent(page); await page.waitForTimeout(1500);

  const standings = await scrapeTable(page);
  const matches = await scrapeSchedule(page);

  // Tickets + Fanfahrten + Livestreams anreichern (alle oeffentlich, ohne Token)
  const events = await fetchTicketEvents();
  const tickets = events.filter(t => !t.isFanfahrt);
  const fanfahrten = events.filter(t => t.isFanfahrt);
  const streams = await fetchStreams();
  // Ortsname-Stems des Gegners (>=5 Zeichen, auf 6 gekuerzt): "Wilhelmshavener HV" -> WILHEL
  // matcht so auch "Fanfahrt nach Wilhelmshaven" trotz abweichender Endung.
  const nameStems = s => (s || '').toUpperCase().replace(/ß/g, 'SS')
    .split(/[^A-Z0-9]+/).filter(w => w.length >= 5).map(w => w.slice(0, 6));
  for (const mt of matches) {
    if (/varel/i.test(mt.home)) { // Ticket nur bei Heimspielen
      const opp = normTeam(mt.away);
      const t = tickets.find(x => x.date === mt.date)
        || tickets.find(x => { const o = normTeam(x.opponent); return o && (opp.includes(o) || o.includes(opp)); });
      if (t) mt.ticketUrl = t.url;
    }
    else { // Fanfahrt nur bei Auswaertsspielen: per Datum, sonst Gastgeber-Stem im Eventnamen
      const f = fanfahrten.find(x => x.date === mt.date)
        || fanfahrten.find(x => { const n = normTeam(x.name); return nameStems(mt.home).some(st => n.includes(st)); });
      if (f) mt.fanfahrtUrl = f.url;
    }
    const s = streams.find(x => x.date === mt.date); // Stream per Spieltag
    if (s) { mt.streamUrl = s.url; if (s.live) mt.live = true; }
  }

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = matches.filter(m => m.status !== 'finished' && (m.date >= today));
  const finished = matches.filter(m => m.status === 'finished' || (m.date < today && m.homeGoals != null));
  const liveStream = streams.find(s => s.live);

  const data = {
    lastUpdated: new Date().toISOString(),
    source: URL,
    team: { id: Number(TEAM), name: 'HSG Varel' },
    season: { id: Number(SEASON), name: 'Saison 2026/2027' },
    stream: {
      channel: SE_CHANNEL,
      live: !!liveStream,
      liveUrl: liveStream ? liveStream.url : null,
      nextUrl: (upcoming[0] && upcoming[0].streamUrl) || null,
    },
    nextMatch: upcoming[0] || null,
    lastMatch: finished.at(-1) || null,
    ticketEvents: events,
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
