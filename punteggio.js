'use strict';

/**
 * Calcolo dei punti di un round di Falso Lemma.
 *
 * Regole:
 * - Se tutti i votanti indovinano la definizione vera, oppure nessuno la
 *   indovina: il narratore prende 0 punti e ogni altro giocatore che ha
 *   votato prende 2 punti.
 * - In tutti gli altri casi: il narratore prende 3 punti e ogni giocatore
 *   che ha indovinato prende 3 punti.
 * - In ogni caso, ogni giocatore (narratore escluso) prende 1 punto per
 *   ogni voto ricevuto dalla propria definizione.
 *
 * @param {object} args
 * @param {string} args.narratoreId
 * @param {string[]} args.giocatoriIds  tutti i giocatori della stanza
 * @param {Array<{votanteId: string, autoreId: string}>} args.voti
 *        un elemento per ogni voto; autoreId è l'autore della definizione
 *        votata (se coincide con il narratore, il voto è corretto)
 * @returns {{caso: string, punti: Record<string, {base: number, voti: number, totale: number}>}}
 */
function calcolaPunteggi({ narratoreId, giocatoriIds, voti }) {
  const punti = {};
  for (const id of giocatoriIds) punti[id] = { base: 0, voti: 0, totale: 0 };

  const votanti = voti.length;
  const corretti = voti.filter((v) => v.autoreId === narratoreId).length;

  let caso;
  if (votanti === 0) {
    caso = 'nessun_voto';
  } else if (corretti === votanti) {
    caso = 'tutti';
  } else if (corretti === 0) {
    caso = 'nessuno';
  } else {
    caso = 'misto';
  }

  if (caso === 'tutti' || caso === 'nessuno') {
    for (const v of voti) punti[v.votanteId].base = 2;
  } else if (caso === 'misto') {
    punti[narratoreId].base = 3;
    for (const v of voti) {
      if (v.autoreId === narratoreId) punti[v.votanteId].base = 3;
    }
  }

  for (const v of voti) {
    if (v.autoreId !== narratoreId) punti[v.autoreId].voti += 1;
  }

  for (const id of giocatoriIds) {
    punti[id].totale = punti[id].base + punti[id].voti;
  }

  return { caso, punti };
}

module.exports = { calcolaPunteggi };
