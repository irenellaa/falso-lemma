'use strict';

/**
 * Falso Lemma - server.
 *
 * Nessuna dipendenza esterna: solo moduli integrati di Node (18 o più recente).
 * - Le stanze vivono in memoria: se il server si riavvia, le partite in corso
 *   si perdono.
 * - Gli aggiornamenti arrivano ai telefoni con Server-Sent Events; le azioni
 *   dei giocatori arrivano con richieste POST.
 * - Tutta la logica sta qui: ogni giocatore riceve solo ciò che può vedere
 *   (la definizione vera resta nascosta fino al risultato).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { calcolaPunteggi } = require('./punteggio');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIN_GIOCATORI = 3;
const MAX_GIOCATORI = 12;
const MAX_STANZE = 500;
const LIM = { nome: 16, parola: 40, definizione: 240 };
const ALFABETO = 'BCDFGHJKLMNPRSTVWZ';
const GRAZIA_HOST_MS = 25_000;
const SCADENZA_STANZA_MS = 6 * 60 * 60 * 1000;
const SCADENZA_LOBBY_OFFLINE_MS = 2 * 60 * 1000;
const LIMITE_RICHIESTE_AL_MINUTO = 600;

const SICUREZZA = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const TIPI = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** @type {Map<string, any>} */
const stanze = new Map();

class Errore extends Error {
  constructor(messaggio, stato = 400) {
    super(messaggio);
    this.stato = stato;
  }
}

function richiedi(condizione, messaggio, stato = 400) {
  if (!condizione) throw new Errore(messaggio, stato);
}

const nuovoId = (byte) => crypto.randomBytes(byte).toString('hex');
const pulisci = (valore, max) => String(valore ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function mescola(lista) {
  const a = [...lista];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nuovoCodice() {
  for (;;) {
    let codice = '';
    for (let i = 0; i < 4; i++) codice += ALFABETO[crypto.randomInt(ALFABETO.length)];
    if (!stanze.has(codice)) return codice;
  }
}

/* ------------------------------------------------------------------ */
/* Modello                                                             */
/* ------------------------------------------------------------------ */

function nuovoGiocatore(nome) {
  return { id: nuovoId(4), key: nuovoId(16), nome, punti: 0, conn: 0, offlineDa: Date.now() };
}

function nuovaStanza(host) {
  return {
    codice: nuovoCodice(),
    v: 0,
    attivita: Date.now(),
    hostId: host.id,
    fase: 'lobby', // lobby | parola | scrittura | voto | risultato | finale
    turno: 0,
    ordine: [],
    narratoreId: null,
    parola: '',
    definizioni: new Map(), // giocatoreId -> testo (quella del narratore è la vera)
    schede: [], // [{id, autoreId, testo}] nell'ordine mostrato durante il voto
    voti: new Map(), // votanteId -> schedaId
    risultato: null,
    giocatori: [host],
    clients: new Set(), // {res, giocatoreId}
    timerHost: null,
  };
}

const trovaGiocatore = (st, key) =>
  typeof key === 'string' && key ? st.giocatori.find((p) => p.key === key) : undefined;

function fatto(st, p) {
  if (st.fase === 'scrittura') return p.id === st.narratoreId || st.definizioni.has(p.id);
  if (st.fase === 'voto') return p.id === st.narratoreId || st.voti.has(p.id);
  if (st.fase === 'risultato') return true;
  return false;
}

/** Lo stato personalizzato che riceve un singolo giocatore. */
function vista(st, me) {
  const inPartita = st.fase !== 'lobby' && st.fase !== 'finale';
  const giocatori = st.giocatori.map((p) => ({
    id: p.id,
    nome: p.nome,
    punti: p.punti,
    online: p.conn > 0,
    host: p.id === st.hostId,
    narratore: inPartita && p.id === st.narratoreId,
    fatto: fatto(st, p),
  }));

  let classifica = null;
  if (st.fase === 'finale') {
    const ordinati = [...st.giocatori].sort((a, b) => b.punti - a.punti);
    classifica = ordinati.map((p) => ({
      id: p.id,
      nome: p.nome,
      punti: p.punti,
      pos: 1 + ordinati.filter((q) => q.punti > p.punti).length,
    }));
  }

  return {
    v: st.v,
    codice: st.codice,
    fase: st.fase,
    turno: st.turno,
    turni: st.ordine.length,
    minGiocatori: MIN_GIOCATORI,
    maxGiocatori: MAX_GIOCATORI,
    io: {
      id: me.id,
      nome: me.nome,
      host: me.id === st.hostId,
      narratore: inPartita && me.id === st.narratoreId,
    },
    giocatori,
    parola: ['scrittura', 'voto', 'risultato'].includes(st.fase) ? st.parola : null,
    miaDefinizione: st.fase === 'scrittura' ? st.definizioni.get(me.id) || null : null,
    schede:
      st.fase === 'voto'
        ? st.schede.map((s) => ({ id: s.id, testo: s.testo, mia: s.autoreId === me.id }))
        : null,
    mioVoto: st.fase === 'voto' ? st.voti.get(me.id) || null : null,
    risultato: st.fase === 'risultato' ? st.risultato : null,
    classifica,
  };
}

function trasmetti(st) {
  st.v += 1;
  st.attivita = Date.now();
  for (const c of st.clients) {
    const g = st.giocatori.find((p) => p.id === c.giocatoreId);
    if (!g) continue;
    try {
      c.res.write(`event: stato\ndata: ${JSON.stringify(vista(st, g))}\n\n`);
    } catch {
      /* connessione già chiusa: la pulizia avviene nell'evento 'close' */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Host                                                                */
/* ------------------------------------------------------------------ */

/** Se l'host è offline da un po', passa il ruolo al primo giocatore online. */
function controllaHost(st) {
  const host = st.giocatori.find((p) => p.id === st.hostId);
  if (host && (host.conn > 0 || Date.now() - host.offlineDa < GRAZIA_HOST_MS - 500)) return false;
  const nuovo = st.giocatori.find((p) => p.conn > 0);
  if (!nuovo || nuovo.id === st.hostId) return false;
  st.hostId = nuovo.id;
  return true;
}

function programmaHost(st, giocatore) {
  if (giocatore.id !== st.hostId || giocatore.conn > 0) return;
  clearTimeout(st.timerHost);
  st.timerHost = setTimeout(() => {
    if (stanze.get(st.codice) === st && controllaHost(st)) trasmetti(st);
  }, GRAZIA_HOST_MS);
  st.timerHost.unref?.();
}

function eliminaStanza(st) {
  clearTimeout(st.timerHost);
  for (const c of st.clients) {
    try {
      c.res.end();
    } catch {
      /* niente da fare */
    }
  }
  st.clients.clear();
  stanze.delete(st.codice);
}

/* ------------------------------------------------------------------ */
/* Fasi di gioco                                                       */
/* ------------------------------------------------------------------ */

function azzeraRound(st) {
  st.parola = '';
  st.definizioni = new Map();
  st.schede = [];
  st.voti = new Map();
  st.risultato = null;
}

function avanzaTurno(st) {
  azzeraRound(st);
  if (st.turno >= st.ordine.length) {
    st.fase = 'finale';
    st.narratoreId = null;
    return;
  }
  st.turno += 1;
  st.narratoreId = st.ordine[st.turno - 1];
  st.fase = 'parola';
}

function passaAlVoto(st) {
  st.schede = mescola(
    [...st.definizioni].map(([autoreId, testo]) => ({ id: nuovoId(3), autoreId, testo }))
  );
  st.voti = new Map();
  st.fase = 'voto';
}

function chiudiVoto(st) {
  const voti = [...st.voti].map(([votanteId, schedaId]) => ({
    votanteId,
    autoreId: st.schede.find((s) => s.id === schedaId).autoreId,
  }));
  const { caso, punti } = calcolaPunteggi({
    narratoreId: st.narratoreId,
    giocatoriIds: st.giocatori.map((p) => p.id),
    voti,
  });
  for (const p of st.giocatori) p.punti += punti[p.id].totale;

  st.risultato = {
    caso,
    punti,
    schede: st.schede
      .map((s) => ({
        id: s.id,
        testo: s.testo,
        autoreId: s.autoreId,
        vera: s.autoreId === st.narratoreId,
        votanti: voti.filter((v) => v.autoreId === s.autoreId).map((v) => v.votanteId),
      }))
      .sort((a, b) => Number(b.vera) - Number(a.vera) || b.votanti.length - a.votanti.length),
  };
  st.fase = 'risultato';
}

const altriGiocatori = (st) => st.giocatori.filter((p) => p.id !== st.narratoreId);

function eseguiAzione(st, g, corpo) {
  const sono = {
    host: g.id === st.hostId,
    narratore: g.id === st.narratoreId,
  };

  switch (corpo.tipo) {
    case 'avvia': {
      richiedi(sono.host, 'Solo chi ha creato la stanza può avviare la partita.', 403);
      richiedi(st.fase === 'lobby', 'La partita è già iniziata.');
      richiedi(st.giocatori.length >= MIN_GIOCATORI, `Servono almeno ${MIN_GIOCATORI} giocatori.`);
      for (const p of st.giocatori) p.punti = 0;
      st.ordine = mescola(st.giocatori.map((p) => p.id));
      st.turno = 0;
      avanzaTurno(st);
      return;
    }

    case 'parola': {
      richiedi(st.fase === 'parola' && sono.narratore, 'Non è il momento di scegliere la parola.');
      const parola = pulisci(corpo.parola, LIM.parola);
      const definizione = pulisci(corpo.definizione, LIM.definizione);
      richiedi(parola, 'Scrivi la parola che hai scelto.');
      richiedi(definizione, 'Scrivi la definizione, riscritta con parole tue.');
      st.parola = parola;
      st.definizioni = new Map([[g.id, definizione]]);
      st.fase = 'scrittura';
      return;
    }

    case 'definizione': {
      richiedi(st.fase === 'scrittura', 'Il tempo per scrivere è finito.');
      richiedi(!sono.narratore, 'Il narratore ha già scritto la sua definizione.');
      const testo = pulisci(corpo.testo, LIM.definizione);
      richiedi(testo, 'Scrivi una definizione.');
      st.definizioni.set(g.id, testo);
      if (altriGiocatori(st).every((p) => st.definizioni.has(p.id))) passaAlVoto(st);
      return;
    }

    case 'vai_al_voto': {
      richiedi(sono.host, 'Solo chi ha creato la stanza può farlo.', 403);
      richiedi(st.fase === 'scrittura', 'Non è il momento di passare al voto.');
      richiedi(
        altriGiocatori(st).some((p) => st.definizioni.has(p.id)),
        'Serve almeno una definizione degli altri giocatori.'
      );
      passaAlVoto(st);
      return;
    }

    case 'voto': {
      richiedi(st.fase === 'voto', 'La votazione non è aperta.');
      richiedi(!sono.narratore, 'Il narratore non vota.');
      richiedi(!st.voti.has(g.id), 'Hai già votato.');
      const scheda = st.schede.find((s) => s.id === corpo.scheda);
      richiedi(scheda, 'Definizione non trovata.');
      richiedi(scheda.autoreId !== g.id, 'Non puoi votare la tua definizione.');
      st.voti.set(g.id, scheda.id);
      if (altriGiocatori(st).every((p) => st.voti.has(p.id))) chiudiVoto(st);
      return;
    }

    case 'chiudi_voto': {
      richiedi(sono.host, 'Solo chi ha creato la stanza può farlo.', 403);
      richiedi(st.fase === 'voto', 'La votazione non è aperta.');
      richiedi(st.voti.size >= 1, 'Aspetta almeno un voto.');
      chiudiVoto(st);
      return;
    }

    case 'prossimo': {
      richiedi(sono.host || sono.narratore, 'Può continuare solo l’host o il narratore.', 403);
      richiedi(st.fase === 'risultato', 'Il round non è ancora finito.');
      avanzaTurno(st);
      return;
    }

    case 'termina': {
      richiedi(sono.host, 'Solo chi ha creato la stanza può terminare la partita.', 403);
      richiedi(st.fase === 'risultato', 'Puoi terminare la partita dopo il risultato di un round.');
      azzeraRound(st);
      st.narratoreId = null;
      st.fase = 'finale';
      return;
    }

    case 'salta': {
      richiedi(sono.host, 'Solo chi ha creato la stanza può saltare il round.', 403);
      richiedi(['parola', 'scrittura', 'voto'].includes(st.fase), 'Non c’è nessun round da saltare.');
      avanzaTurno(st);
      return;
    }

    case 'nuova': {
      richiedi(sono.host, 'Solo chi ha creato la stanza può ricominciare.', 403);
      richiedi(st.fase === 'finale', 'La partita non è finita.');
      for (const p of st.giocatori) p.punti = 0;
      azzeraRound(st);
      st.ordine = [];
      st.turno = 0;
      st.narratoreId = null;
      st.fase = 'lobby';
      return;
    }

    default:
      throw new Errore('Azione sconosciuta.');
  }
}

/** Esce dalla stanza (solo in lobby). Ritorna true se la stanza è stata eliminata. */
function esci(st, g) {
  richiedi(st.fase === 'lobby', 'Non si può uscire a partita in corso.');
  st.giocatori = st.giocatori.filter((p) => p.id !== g.id);
  for (const c of [...st.clients]) {
    if (c.giocatoreId === g.id) {
      st.clients.delete(c);
      try {
        c.res.end();
      } catch {
        /* niente da fare */
      }
    }
  }
  if (st.giocatori.length === 0) {
    eliminaStanza(st);
    return true;
  }
  if (st.hostId === g.id) st.hostId = (st.giocatori.find((p) => p.conn > 0) || st.giocatori[0]).id;
  return false;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const contatori = new Map();
function troppeRichieste(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim();
  const minuto = Math.floor(Date.now() / 60_000);
  const c = contatori.get(ip);
  if (!c || c.minuto !== minuto) {
    contatori.set(ip, { minuto, n: 1 });
    return false;
  }
  c.n += 1;
  return c.n > LIMITE_RICHIESTE_AL_MINUTO;
}

async function leggiJson(req) {
  const pezzi = [];
  let dimensione = 0;
  for await (const pezzo of req) {
    dimensione += pezzo.length;
    if (dimensione > 10_000) throw new Errore('Richiesta troppo grande.', 413);
    pezzi.push(pezzo);
  }
  if (!pezzi.length) return {};
  try {
    const dati = JSON.parse(Buffer.concat(pezzi).toString('utf8'));
    return dati && typeof dati === 'object' ? dati : {};
  } catch {
    throw new Errore('Richiesta non valida.');
  }
}

function rispondi(res, stato, oggetto) {
  res.writeHead(stato, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SICUREZZA,
  });
  res.end(JSON.stringify(oggetto));
}

function creaStanza(corpo) {
  const nome = pulisci(corpo.nome, LIM.nome);
  richiedi(nome, 'Scrivi il tuo nome.');
  richiedi(stanze.size < MAX_STANZE, 'Ci sono troppe stanze attive, riprova tra poco.', 503);
  const host = nuovoGiocatore(nome);
  const st = nuovaStanza(host);
  stanze.set(st.codice, st);
  return { codice: st.codice, key: host.key, id: host.id };
}

function entraInStanza(st, corpo) {
  const esistente = trovaGiocatore(st, corpo.key);
  if (esistente) return { codice: st.codice, key: esistente.key, id: esistente.id, nome: esistente.nome };

  const nome = pulisci(corpo.nome, LIM.nome);
  richiedi(nome, 'Scrivi il tuo nome.');
  richiedi(st.fase === 'lobby', 'La partita è già iniziata: non si può più entrare.', 409);
  richiedi(st.giocatori.length < MAX_GIOCATORI, 'La stanza è piena.', 409);
  richiedi(
    !st.giocatori.some((p) => p.nome.toLowerCase() === nome.toLowerCase()),
    'In stanza c’è già qualcuno con questo nome. Scegline un altro.',
    409
  );
  const g = nuovoGiocatore(nome);
  st.giocatori.push(g);
  trasmetti(st);
  return { codice: st.codice, key: g.key, id: g.id, nome: g.nome };
}

function apriEventi(req, res, st, g) {
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SICUREZZA,
  });
  res.write('retry: 2000\n\n');

  const client = { res, giocatoreId: g.id };
  st.clients.add(client);
  g.conn += 1;
  controllaHost(st);
  trasmetti(st);

  req.on('close', () => {
    st.clients.delete(client);
    g.conn = Math.max(0, g.conn - 1);
    g.offlineDa = Date.now();
    if (stanze.get(st.codice) !== st || !st.giocatori.includes(g)) return;
    programmaHost(st, g);
    trasmetti(st);
  });
}

function servi(req, res, pathname) {
  const relativo =
    pathname === '/' || /^\/[A-Za-z]{4}\/?$/.test(pathname) ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, relativo));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, SICUREZZA).end('Vietato');
    return;
  }
  fs.readFile(file, (err, dati) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SICUREZZA });
      res.end('Pagina non trovata');
      return;
    }
    const estensione = path.extname(file);
    res.writeHead(200, {
      'Content-Type': TIPI[estensione] || 'application/octet-stream',
      'Cache-Control': estensione === '.html' ? 'no-cache' : 'public, max-age=300',
      ...SICUREZZA,
    });
    res.end(dati);
  });
}

async function gestisci(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  if (pathname === '/api/stanze' && req.method === 'POST') {
    if (troppeRichieste(req)) throw new Errore('Troppe richieste, aspetta un momento.', 429);
    return rispondi(res, 200, creaStanza(await leggiJson(req)));
  }

  const m = pathname.match(/^\/api\/stanze\/([A-Za-z]{4})\/(entra|azione|eventi|stato)$/);
  if (m) {
    const st = stanze.get(m[1].toUpperCase());
    if (!st) throw new Errore('Stanza non trovata. Controlla il codice.', 404);
    const azione = m[2];

    if (azione === 'entra' && req.method === 'POST') {
      if (troppeRichieste(req)) throw new Errore('Troppe richieste, aspetta un momento.', 429);
      return rispondi(res, 200, entraInStanza(st, await leggiJson(req)));
    }

    if ((azione === 'eventi' || azione === 'stato') && req.method === 'GET') {
      const g = trovaGiocatore(st, url.searchParams.get('key'));
      if (!g) throw new Errore('Non fai parte di questa stanza.', 403);
      if (azione === 'stato') return rispondi(res, 200, vista(st, g));
      return apriEventi(req, res, st, g);
    }

    if (azione === 'azione' && req.method === 'POST') {
      if (troppeRichieste(req)) throw new Errore('Troppe richieste, aspetta un momento.', 429);
      const corpo = await leggiJson(req);
      const g = trovaGiocatore(st, corpo.key);
      if (!g) throw new Errore('Non fai parte di questa stanza.', 403);
      if (corpo.tipo === 'esci') {
        const eliminata = esci(st, g);
        if (!eliminata) trasmetti(st);
        return rispondi(res, 200, { ok: true });
      }
      eseguiAzione(st, g, corpo);
      trasmetti(st);
      return rispondi(res, 200, { stato: vista(st, g) });
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') return servi(req, res, pathname);
  throw new Errore('Richiesta non supportata.', 405);
}

function pulizia() {
  const ora = Date.now();
  for (const st of [...stanze.values()]) {
    if (st.clients.size === 0 && ora - st.attivita > SCADENZA_STANZA_MS) {
      eliminaStanza(st);
      continue;
    }
    if (st.fase === 'lobby') {
      const prima = st.giocatori.length;
      st.giocatori = st.giocatori.filter(
        (p) => p.conn > 0 || ora - p.offlineDa < SCADENZA_LOBBY_OFFLINE_MS
      );
      if (st.giocatori.length === 0) {
        eliminaStanza(st);
        continue;
      }
      if (!st.giocatori.some((p) => p.id === st.hostId)) st.hostId = st.giocatori[0].id;
      if (st.giocatori.length !== prima) trasmetti(st);
    }
    if (controllaHost(st)) trasmetti(st);
  }
}

function creaServer() {
  const server = http.createServer((req, res) => {
    gestisci(req, res).catch((e) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof Errore) return rispondi(res, e.stato, { errore: e.message });
      console.error(e);
      rispondi(res, 500, { errore: 'Errore del server.' });
    });
  });

  // Un commento ogni 15 secondi tiene aperte le connessioni dietro ai proxy.
  const battito = setInterval(() => {
    for (const st of stanze.values()) {
      for (const c of st.clients) {
        try {
          c.res.write(': ping\n\n');
        } catch {
          /* gestito alla chiusura */
        }
      }
    }
  }, 15_000);
  const manutenzione = setInterval(pulizia, 60_000);
  battito.unref();
  manutenzione.unref();
  server.on('close', () => {
    clearInterval(battito);
    clearInterval(manutenzione);
  });
  return server;
}

if (require.main === module) {
  const porta = Number(process.env.PORT) || 3000;
  creaServer().listen(porta, '0.0.0.0', () => {
    console.log(`Falso Lemma in ascolto sulla porta ${porta}`);
  });
}

module.exports = { creaServer, stanze };
