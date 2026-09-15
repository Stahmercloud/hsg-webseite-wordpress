// crawl.mjs - liest Spielplan + Tabelle der HSG Varel (1. Herren, 3. Liga) von handball.net
// und schreibt handball-data.json im HSG-Schema. Laeuft in GitHub Actions (headless).
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const TEAM = '87310';
const SEASON = '2627';
const URL = `https://www.handball.net/team/${TEAM}?season_id=${SEASON}`;
const OUT = process.env.OUT || 'handball-data.json';
const SEASON_START = `20${SEASON.slice(0, 2)}-07-01`;  // "2627" -> 2026-07-01
const SEASON_END = `20${SEASON.slice(2)}-07-31`;       // "2627" -> 2027-07-31

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

const firstLine = s => String(s || '').split('\n')[0];

const isLogo = s => typeof s === 'string' && /^https?:/.test(s) && !/\.svg(\?|$)/i.test(s);

// Rueckfallebene: die Tabelle so aus dem DOM lesen, wie es bis zum 15.09.2026
// der Normalweg war. Der Klick kann am Consent-Layer scheitern - dann bleibt es
// bei einer leeren Liste, statt den ganzen Lauf abzubrechen.
async function scrapeTableDom(page) {
  try { await clickTab(page, /tabelle/i); } catch (e) { console.error('Tabellen-Tab nicht klickbar:', firstLine(e.message)); }
  const rows = await page.evaluate(() => [...document.querySelectorAll('table tr')]
    .filter(tr => tr.querySelectorAll('td').length >= 5)
    .map(tr => {
      const img = tr.querySelector('img');
      return { cells: [...tr.children].map(x => (x.textContent || '').trim()), logo: img ? img.getAttribute('src') : null };
    }));
  const parsed = rows.map(({ cells: c, logo }) => ({
    pos: Number(c[0]) || 0,
    team: titleCase(c[1]),
    logo: isLogo(logo) ? logo : null,
    sp: Number(c[2]) || 0,
    punkte: c[3] || '0:0',
    diff: c[4] || '',
    isSelf: /varel/i.test(c[1]),
  })).filter(r => r.team && !/^PL/i.test(String(r.pos)));
  return rankStandings(parsed);
}

// ---- Tabellenreihenfolge selbst herstellen ----
// handball.net liefert die Zeilen zeitweise unsortiert und nummeriert sie
// trotzdem stumpf von 1 durch: am 09.09.2026 stand ein Team mit 4:0 Punkten
// hinter einem mit 2:2, die HSG mit 0:4 vor einem Team mit 2:2. Die Werte der
// Zeilen stimmen, nur ihre Reihenfolge nicht - also sortieren wir nach den
// Kriterien der Spielordnung selbst und vergeben die Platzziffern neu:
// Pluspunkte, dann weniger Minuspunkte, dann Tordifferenz, dann mehr geworfene
// Tore. Der direkte Vergleich laesst sich aus der Tabelle nicht ableiten -
// bleibt danach alles gleich, behalten wir die Reihenfolge von handball.net.
const scorePair = s => {
  const m = String(s == null ? '' : s).match(/(-?\d+)\s*:\s*(-?\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};
function rankStandings(rows) {
  // Vor dem ersten Spieltag zeigt handball.net keine Plaetze (pos 0) - dann
  // gibt es nichts zu sortieren, und erfundene Ziffern wuerden im Frontend die
  // Auf-/Abstiegszonen einfaerben.
  if (!rows.some(r => r.pos > 0)) return rows;
  return rows
    .map((r, i) => {
      const [plus, minus] = scorePair(r.punkte);
      const [tore, gegentore] = scorePair(r.diff);
      return { r, i, plus, minus, diff: tore - gegentore, tore };
    })
    .sort((a, b) => b.plus - a.plus || a.minus - b.minus
      || b.diff - a.diff || b.tore - a.tore || a.i - b.i)
    .map((x, i) => ({ ...x.r, pos: i + 1 }));
}

// ---- Zugriff auf die JSON-API von handball.net ----
// Die API antwortet nur aus dem Seitenkontext heraus (direkt: HTTP 403), darum
// laeuft jeder Aufruf als fetch() in der schon geladenen Team-Seite.
async function apiJson(page, url, label) {
  const res = await page.evaluate(async u => {
    const r = await fetch(u, { headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  }, url);
  if (res.status !== 200) throw new Error(`${label}: HTTP ${res.status} - ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

// ---- Tabelle: seit 15.09.2026 ebenfalls aus der API statt aus dem DOM ----
// Die Team-Seite fragt die Tabelle seit dem 15.09.2026 mit einem round-Parameter
// ab und setzt darin die *letzte* Runde der Serie ein (round=30) statt der
// laufenden (round=4). Die Antwort ist leer, die Seite schreibt "Keine
// Tabellendaten verfuegbar" - und im DOM stand danach keine Tabelle mehr, die
// sich auslesen liesse. Ohne round liefert dieselbe API alle Runden am Stueck;
// die Runde mit den meisten gespielten Spielen ist der aktuelle Stand.
const MAX_TABLE_ROUNDS = 80; // Plausibilitaetsgrenze: mehr Runden hat keine Serie

function pickCurrentRound(rows) {
  const rounds = new Map();
  for (const r of rows) {
    const no = Number(r.round) || 0;
    const e = rounds.get(no) || { no, rows: [], played: 0 };
    e.rows.push(r);
    e.played += Number(r.played) || 0;
    rounds.set(no, e);
  }
  if (!rounds.size || rounds.size > MAX_TABLE_ROUNDS) return [];
  // Meiste ausgetragene Spiele gewinnt; bei Gleichstand (noch kein Spieltag,
  // alle Runden bei 0) die hoechste Rundennummer - die traegt den Endstand.
  const best = [...rounds.values()].sort((a, b) => b.played - a.played || b.no - a.no)[0];
  return best.rows;
}

function mapStandingRow(r) {
  const team = r.team || {};
  const name = String(team.name || '').trim();
  const sp = Number(r.played) || 0;
  const plus = Number(r.points) || 0;
  return {
    pos: Number(r.position) || 0,
    team: titleCase(name),
    logo: team.club && isLogo(team.club.logo) ? team.club.logo : null,
    sp,
    // handball.net zeigt Plus:Minus - die API kennt nur die Pluspunkte.
    punkte: `${plus}:${Math.max(0, sp * 2 - plus)}`,
    diff: `${Number(r.goals_for) || 0}:${Number(r.goals_against) || 0}`,
    isSelf: /varel/i.test(name),
  };
}

async function fetchStandings(page) {
  const comps = await apiJson(page, `/api/new/teams/${TEAM}/competitions?season_id=${SEASON}`, 'Wettbewerbs-API');
  const phases = comps.data || [];
  const phase = phases.find(c => c.has_standings) || phases[0];
  if (!phase || !phase.id) throw new Error('Wettbewerbs-API nennt keine Staffel mit Tabelle');
  const all = (await apiJson(page, `/api/new/standings?phase_id=${phase.id}`, 'Tabellen-API')).data || [];
  const rows = pickCurrentRound(all).map(mapStandingRow).filter(r => r.team);
  return rankStandings(rows);
}

// ---- Spielplan: die JSON-API, die handball.net selbst benutzt ----
// Frueher wurde der Spielplan-Tab Woche fuer Woche durchgeklickt. Seit dem
// 06.09.2026 listet der Tab nur noch kommende Spiele und die Pfeile schieben
// einen Datumsbereich statt einer Woche - das Abklappern lieferte danach still
// nur noch ein einziges Spiel. Die API gibt die komplette Saison in einem Rutsch
// aus; sie antwortet aber nur aus dem Seitenkontext heraus (direkt: HTTP 403).
function mapMatch(m) {
  const st = m.status || {};
  const finished = !!st.is_finished;
  const live = !finished && !!st.is_live;
  const res = m.result || {};
  const withScore = (finished || live) && res.local != null && res.visitor != null;
  const phase = m.phase || {};
  const competition = [phase.competition && phase.competition.name, phase.name].filter(Boolean).join(' - ');
  const side = t => ({
    name: titleCase(((t && t.name) || '').trim()),
    logo: t && t.club && isLogo(t.club.logo) ? t.club.logo : null,
  });
  const home = side(m.local), away = side(m.visitor);
  // "2026-09-12T19:30:00+00:00" ist bereits Ortszeit - der Offset ist gelogen,
  // also den String zerlegen statt ihn durch new Date() zu schicken.
  const stamp = String(m.date || '');
  return {
    date: stamp.slice(0, 10) || null,
    time: stamp.slice(11, 16) || null,
    competition: competition || '3. Liga',
    home: home.name || null,
    away: away.name || null,
    homeLogo: home.logo,
    awayLogo: away.logo,
    homeGoals: withScore ? Number(res.local) : null,
    awayGoals: withScore ? Number(res.visitor) : null,
    status: finished ? 'finished' : (live ? 'live' : 'scheduled'),
  };
}

async function scrapeSchedule(page) {
  const raw = [];
  let total = null;
  for (let no = 1; no <= 20; no++) {
    const url = `/api/new/matches?team_id=${TEAM}&date_from=${SEASON_START}&date_to=${SEASON_END}&per_page=100&page=${no}`;
    const json = await apiJson(page, url, 'Spielplan-API');
    const pg = json.pagination || {};
    if (pg.total != null) total = pg.total;
    for (const m of json.data || []) raw.push(m);
    if (!pg.last_page || no >= pg.last_page) break;
  }
  // Abbruch statt halber Wahrheit: eine unvollstaendig geladene Seite wuerde
  // sonst als "neuer Spielplan" hochgeladen werden.
  if (total != null && raw.length !== total) {
    throw new Error(`Spielplan unvollstaendig: ${raw.length} von ${total} Spielen geladen`);
  }
  const matches = raw.map(mapMatch).filter(m => m.date && m.home && m.away);
  if (matches.length !== raw.length) {
    console.error(`Spielplan-Warnung: ${raw.length - matches.length} Eintraege ohne Datum oder Team verworfen`);
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

  let standings = [];
  try { standings = await fetchStandings(page); }
  catch (e) { console.error('Tabellen-API-Fehler:', e.message); }
  if (!standings.length) {
    console.error('Tabelle: API liefert keine Zeilen - Rueckfall auf den Tabellen-Tab');
    standings = await scrapeTableDom(page);
  }
  const matches = await scrapeSchedule(page);

  // Laeuft die Liga (Tabelle steht), muss es auch Spiele geben. Ohne diese Bremse
  // waere ein leergelaufener Spielplan als gueltige JSON hochgeladen worden - genau
  // das hat am 06.09.2026 "TSV Anderten" (Saisonfinale) in den Startseiten-Hero geholt.
  if (!matches.length && standings.length) {
    throw new Error('Spielplan leer, obwohl die Tabelle ' + standings.length + ' Zeilen liefert - Abbruch ohne Upload');
  }

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

  // Letzter Rettungsanker: liefert weder API noch DOM eine Tabelle, bleibt der
  // Stand des vorigen Laufs stehen. Sonst verschwindet die Tabelle bei jedem
  // Ausrutscher der Quelle sofort von der Seite (15.09.2026).
  if (!standings.length) {
    try {
      const prev = JSON.parse(readFileSync(OUT, 'utf8'));
      if (prev.standings && prev.standings.length) {
        standings = prev.standings;
        console.error(`Tabelle: uebernehme den Stand des letzten Laufs (${prev.lastUpdated})`);
      }
    } catch (e) { console.error('Tabelle: kein alter Stand vorhanden:', e.message); }
  }

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
