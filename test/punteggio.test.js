'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calcolaPunteggi } = require('../punteggio');

const giocatoriIds = ['N', 'A', 'B', 'C'];
const totali = (r) => Object.fromEntries(Object.entries(r.punti).map(([id, p]) => [id, p.totale]));

test('tutti indovinano: narratore 0, gli altri 2 a testa', () => {
  const r = calcolaPunteggi({
    narratoreId: 'N',
    giocatoriIds,
    voti: [
      { votanteId: 'A', autoreId: 'N' },
      { votanteId: 'B', autoreId: 'N' },
      { votanteId: 'C', autoreId: 'N' },
    ],
  });
  assert.equal(r.caso, 'tutti');
  assert.deepEqual(totali(r), { N: 0, A: 2, B: 2, C: 2 });
});

test('nessuno indovina: narratore 0, gli altri 2 più 1 per ogni voto ricevuto', () => {
  // A vota B, B vota C, C vota B -> B riceve 2 voti, C ne riceve 1, A nessuno
  const r = calcolaPunteggi({
    narratoreId: 'N',
    giocatoriIds,
    voti: [
      { votanteId: 'A', autoreId: 'B' },
      { votanteId: 'B', autoreId: 'C' },
      { votanteId: 'C', autoreId: 'B' },
    ],
  });
  assert.equal(r.caso, 'nessuno');
  assert.deepEqual(totali(r), { N: 0, A: 2, B: 2 + 2, C: 2 + 1 });
});

test('caso misto: narratore 3, chi indovina 3, più i voti ricevuti', () => {
  // A indovina, B vota C, C vota B
  const r = calcolaPunteggi({
    narratoreId: 'N',
    giocatoriIds,
    voti: [
      { votanteId: 'A', autoreId: 'N' },
      { votanteId: 'B', autoreId: 'C' },
      { votanteId: 'C', autoreId: 'B' },
    ],
  });
  assert.equal(r.caso, 'misto');
  assert.deepEqual(totali(r), { N: 3, A: 3, B: 1, C: 1 });
});

test('caso misto: chi inganna più persone guadagna più punti', () => {
  // A e B indovinano, C no ma vota A: A prende 3 (indovinato) + 1 (voto di C)
  const r = calcolaPunteggi({
    narratoreId: 'N',
    giocatoriIds,
    voti: [
      { votanteId: 'A', autoreId: 'N' },
      { votanteId: 'B', autoreId: 'N' },
      { votanteId: 'C', autoreId: 'A' },
    ],
  });
  assert.equal(r.caso, 'misto');
  assert.deepEqual(totali(r), { N: 3, A: 3 + 1, B: 3, C: 0 });
});

test('chi non ha votato non prende punti di round', () => {
  // C non vota: solo A e B hanno votato e hanno indovinato entrambi
  const r = calcolaPunteggi({
    narratoreId: 'N',
    giocatoriIds,
    voti: [
      { votanteId: 'A', autoreId: 'N' },
      { votanteId: 'B', autoreId: 'N' },
    ],
  });
  assert.equal(r.caso, 'tutti');
  assert.deepEqual(totali(r), { N: 0, A: 2, B: 2, C: 0 });
});

test('nessun voto: nessun punto', () => {
  const r = calcolaPunteggi({ narratoreId: 'N', giocatoriIds, voti: [] });
  assert.equal(r.caso, 'nessun_voto');
  assert.deepEqual(totali(r), { N: 0, A: 0, B: 0, C: 0 });
});

test('il dettaglio separa punti di round e punti da voti', () => {
  const r = calcolaPunteggi({
    narratoreId: 'N',
    giocatoriIds,
    voti: [
      { votanteId: 'A', autoreId: 'N' },
      { votanteId: 'B', autoreId: 'A' },
      { votanteId: 'C', autoreId: 'A' },
    ],
  });
  assert.deepEqual(r.punti.A, { base: 3, voti: 2, totale: 5 });
  assert.deepEqual(r.punti.N, { base: 3, voti: 0, totale: 3 });
});
