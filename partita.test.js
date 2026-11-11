'use strict';

// Partita completa con 4 giocatori simulati, contro il server vero.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { creaServer, stanze } = require('../server');

let server;
let base;

test.before(async () => {
  server = creaServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  for (const st of [...stanze.values()]) {
    for (const c of st.clients) c.res.end();
  }
  server.closeAllConnections?.();
  await new Promise((ok) => server.close(ok));
});

async function chiama(metodo, percorso, corpo) {
  const r = await fetch(base + percorso, {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { stato: r.status, dati: await r.json() };
}

const azione = (codice, g, tipo, extra = {}) =>
  chiama('POST', `/api/stanze/${codice}/azione`, { key: g.key, tipo, ...extra });
const vedi = async (codice, g) =>
  (await chiama('GET', `/api/stanze/${codice}/stato?key=${g.key}`)).dati;

async function nuovaPartita(nomi) {
  const { dati: host } = await chiama('POST', '/api/stanze', { nome: nomi[0] });
  const giocatori = [{ ...host, nome: nomi[0] }];
  for (const nome of nomi.slice(1)) {
    const r = await chiama('POST', `/api/stanze/${host.codice}/entra`, { nome });
    assert.equal(r.stato, 200);
    giocatori.push({ ...r.dati, nome });
  }
  return { codice: host.codice, giocatori };
}

test('la lobby: nomi unici, minimo di giocatori, solo l’host avvia', async () => {
  const { codice, giocatori } = await nuovaPartita(['Anna', 'Luca']);

  const doppio = await chiama('POST', `/api/stanze/${codice}/entra`, { nome: 'anna' });
  assert.equal(doppio.stato, 409);

  const troppoPresto = await azione(codice, giocatori[0], 'avvia');
  assert.equal(troppoPresto.stato, 400);

  const r = await chiama('POST', `/api/stanze/${codice}/entra`, { nome: 'Marta' });
  const marta = { ...r.dati, nome: 'Marta' };
  const nonHost = await azione(codice, marta, 'avvia');
  assert.equal(nonHost.stato, 403);

  const ok = await azione(codice, giocatori[0], 'avvia');
  assert.equal(ok.stato, 200);
  assert.equal(ok.dati.stato.fase, 'parola');

  const tardivo = await chiama('POST', `/api/stanze/${codice}/entra`, { nome: 'Pietro' });
  assert.equal(tardivo.stato, 409);

  const stanzaInesistente = await chiama('POST', '/api/stanze/ZZZZ/entra', { nome: 'X' });
  assert.equal(stanzaInesistente.stato, 404);
});

test('un round intero: definizione vera nascosta, voto, punteggio, giro dei narratori', async () => {
  const { codice, giocatori } = await nuovaPartita(['Anna', 'Luca', 'Marta', 'Pietro']);
  const [host] = giocatori;

  let s = (await azione(codice, host, 'avvia')).dati.stato;
  assert.equal(s.fase, 'parola');
  assert.equal(s.turni, 4);

  const stati = await Promise.all(giocatori.map((g) => vedi(codice, g)));
  const narr = giocatori[stati.findIndex((x) => x.io.narratore)];
  const altri = giocatori.filter((g) => g.id !== narr.id);

  // Chi non è narratore non può scegliere la parola
  assert.equal((await azione(codice, altri[0], 'parola', { parola: 'x', definizione: 'y' })).stato, 400);

  s = (await azione(codice, narr, 'parola', { parola: 'ubbia', definizione: 'Un timore senza fondamento.' })).dati.stato;
  assert.equal(s.fase, 'scrittura');
  assert.equal(s.parola, 'ubbia');

  // Il narratore non può riscrivere, gli altri scrivono
  assert.equal((await azione(codice, narr, 'definizione', { testo: 'altro' })).stato, 400);
  await azione(codice, altri[0], 'definizione', { testo: 'Una specie di uccello notturno.' });
  await azione(codice, altri[1], 'definizione', { testo: 'Il rumore della pioggia sui tetti.' });
  // Si può correggere finché non finiscono tutti
  await azione(codice, altri[1], 'definizione', { testo: 'Il rumore della pioggia sui tetti di rame.' });
  s = (await azione(codice, altri[2], 'definizione', { testo: 'Una piccola ruga sulla fronte.' })).dati.stato;
  assert.equal(s.fase, 'voto');
  assert.equal(s.schede.length, 4);

  // Le schede non rivelano l'autore; ognuno vede solo la propria come "mia"
  for (const g of giocatori) {
    const v = await vedi(codice, g);
    assert.equal(v.schede.filter((x) => x.mia).length, 1);
    assert.ok(v.schede.every((x) => Object.keys(x).sort().join() === 'id,mia,testo'));
  }

  const schedaDi = async (g) => (await vedi(codice, g)).schede.find((x) => x.mia).id;
  const vera = await schedaDi(narr);
  const falsaA0 = await schedaDi(altri[0]);
  const falsaA1 = await schedaDi(altri[1]);

  // Non si vota la propria, il narratore non vota, non si vota due volte
  assert.equal((await azione(codice, altri[0], 'voto', { scheda: falsaA0 })).stato, 400);
  assert.equal((await azione(codice, narr, 'voto', { scheda: falsaA0 })).stato, 400);

  // altri[0] indovina; altri[1] vota la falsa di altri[0]; altri[2] vota la falsa di altri[1]
  await azione(codice, altri[0], 'voto', { scheda: vera });
  assert.equal((await azione(codice, altri[0], 'voto', { scheda: falsaA1 })).stato, 400);
  await azione(codice, altri[1], 'voto', { scheda: falsaA0 });
  s = (await azione(codice, altri[2], 'voto', { scheda: falsaA1 })).dati.stato;

  assert.equal(s.fase, 'risultato');
  assert.equal(s.risultato.caso, 'misto');
  const punti = Object.fromEntries(s.giocatori.map((p) => [p.id, p.punti]));
  assert.equal(punti[narr.id], 3); // qualcuno ha indovinato
  assert.equal(punti[altri[0].id], 3 + 1); // ha indovinato + un voto ricevuto
  assert.equal(punti[altri[1].id], 1); // un voto ricevuto
  assert.equal(punti[altri[2].id], 0);
  assert.equal(s.risultato.schede[0].vera, true); // la vera è la prima del risultato

  // Si passa al round successivo: cambia il narratore
  assert.equal((await azione(codice, altri[2], 'prossimo')).stato, 403);
  s = (await azione(codice, host, 'prossimo')).dati.stato;
  assert.equal(s.fase, 'parola');
  assert.equal(s.turno, 2);
  assert.notEqual(s.giocatori.find((p) => p.narratore).id, narr.id);
});

test('partita intera: ogni giocatore fa il narratore, poi classifica e nuova partita', async () => {
  const { codice, giocatori } = await nuovaPartita(['Anna', 'Luca', 'Marta']);
  const [host] = giocatori;
  await azione(codice, host, 'avvia');

  for (let turno = 1; turno <= 3; turno++) {
    const stati = await Promise.all(giocatori.map((g) => vedi(codice, g)));
    const narr = giocatori[stati.findIndex((x) => x.io.narratore)];
    const altri = giocatori.filter((g) => g.id !== narr.id);

    await azione(codice, narr, 'parola', { parola: `parola${turno}`, definizione: 'Quella vera.' });
    for (const g of altri) await azione(codice, g, 'definizione', { testo: `Falsa di ${g.nome}` });

    // Tutti votano la definizione vera: nessun punto al narratore, 2 a testa agli altri
    const vera = (await vedi(codice, narr)).schede.find((x) => x.mia).id;
    let s;
    for (const g of altri) s = (await azione(codice, g, 'voto', { scheda: vera })).dati.stato;
    assert.equal(s.risultato.caso, 'tutti');

    s = (await azione(codice, host, 'prossimo')).dati.stato;
    assert.equal(s.fase, turno < 3 ? 'parola' : 'finale');
  }

  const finale = await vedi(codice, host);
  assert.equal(finale.classifica.length, 3);
  // Ognuno è stato narratore una volta (0 punti) e votante due volte (2+2)
  assert.deepEqual(finale.classifica.map((r) => r.punti), [4, 4, 4]);
  assert.ok(finale.classifica.every((r) => r.pos === 1));

  const nuova = (await azione(codice, host, 'nuova')).dati.stato;
  assert.equal(nuova.fase, 'lobby');
  assert.ok(nuova.giocatori.every((p) => p.punti === 0));
});

test('l’host può forzare voto e chiusura e saltare un round', async () => {
  const { codice, giocatori } = await nuovaPartita(['Anna', 'Luca', 'Marta', 'Pietro']);
  const [host] = giocatori;
  await azione(codice, host, 'avvia');

  const stati = await Promise.all(giocatori.map((g) => vedi(codice, g)));
  const narr = giocatori[stati.findIndex((x) => x.io.narratore)];
  const altri = giocatori.filter((g) => g.id !== narr.id);

  await azione(codice, narr, 'parola', { parola: 'sinecura', definizione: 'Un incarico comodo.' });
  assert.equal((await azione(codice, host, 'vai_al_voto')).stato, 400); // nessuna definizione ancora
  await azione(codice, altri[0], 'definizione', { testo: 'Una cura per il mal di schiena.' });

  let s = (await azione(codice, host, 'vai_al_voto')).dati.stato;
  assert.equal(s.fase, 'voto');
  assert.equal(s.schede.length, 2);

  assert.equal((await azione(codice, host, 'chiudi_voto')).stato, 400); // serve almeno un voto
  const falsa = (await vedi(codice, altri[0])).schede.find((x) => x.mia).id;
  await azione(codice, altri[1], 'voto', { scheda: falsa });
  s = (await azione(codice, host, 'chiudi_voto')).dati.stato;
  assert.equal(s.fase, 'risultato');
  assert.equal(s.risultato.caso, 'nessuno');
  const punti = Object.fromEntries(s.giocatori.map((p) => [p.id, p.punti]));
  assert.equal(punti[altri[1].id], 2); // ha votato
  assert.equal(punti[altri[2].id], 0); // non ha votato
  assert.equal(punti[altri[0].id], 1); // un voto ricevuto

  await azione(codice, host, 'prossimo');
  s = (await azione(codice, host, 'salta')).dati.stato;
  assert.equal(s.turno, 3);
  assert.equal(s.fase, 'parola');
});

test('rientro con la stessa chiave dopo un refresh', async () => {
  const { codice, giocatori } = await nuovaPartita(['Anna', 'Luca', 'Marta']);
  await azione(codice, giocatori[0], 'avvia');
  const r = await chiama('POST', `/api/stanze/${codice}/entra`, { key: giocatori[1].key });
  assert.equal(r.stato, 200);
  assert.equal(r.dati.id, giocatori[1].id);
  const intruso = await chiama('GET', `/api/stanze/${codice}/stato?key=chiave-sbagliata`);
  assert.equal(intruso.stato, 403);
});

test('lo stream in tempo reale invia lo stato a ogni cambiamento', async () => {
  const { codice, giocatori } = await nuovaPartita(['Anna', 'Luca', 'Marta']);

  const eventi = [];
  const richiesta = http.get(`${base}/api/stanze/${codice}/eventi?key=${giocatori[1].key}`);
  const risposta = await new Promise((ok) => richiesta.on('response', ok));
  assert.match(risposta.headers['content-type'], /text\/event-stream/);
  risposta.setEncoding('utf8');
  let buffer = '';
  risposta.on('data', (pezzo) => {
    buffer += pezzo;
    let i;
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      const blocco = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const dati = blocco.split('\n').find((r) => r.startsWith('data: '));
      if (dati) eventi.push(JSON.parse(dati.slice(6)));
    }
  });

  const attendi = async (cond) => {
    for (let i = 0; i < 50; i++) {
      if (cond()) return;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    assert.fail('evento non arrivato');
  };

  await attendi(() => eventi.length >= 1);
  assert.equal(eventi.at(-1).fase, 'lobby');

  await azione(codice, giocatori[0], 'avvia');
  await attendi(() => eventi.at(-1).fase === 'parola');

  richiesta.destroy();
});

test('servono la pagina e i file, anche dal link con il codice della stanza', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Falso Lemma/);

  const conCodice = await fetch(base + '/BCDF');
  assert.equal(conCodice.status, 200);
  assert.match(conCodice.headers.get('content-type'), /text\/html/);

  const js = await fetch(base + '/gioco.js');
  assert.equal(js.status, 200);

  const fuori = await fetch(base + '/..%2fserver.js');
  assert.notEqual(fuori.status, 200);
});
