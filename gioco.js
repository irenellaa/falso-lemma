(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Utilità                                                             */
  /* ------------------------------------------------------------------ */

  const $ = (selettore, radice = document) => radice.querySelector(selettore);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (testo) => String(testo).replace(/[&<>"']/g, (c) => ESC[c]);

  const app = $('#app');
  const barra = $('#barra');
  const bannerOffline = $('#offline');
  const foglio = $('#classifica');
  const toastEl = $('#toast');

  const LETTERE = 'ABCDEFGHIJKL';

  const memoria = {
    leggi(chiave) {
      try {
        return JSON.parse(localStorage.getItem(chiave));
      } catch {
        return null;
      }
    },
    scrivi(chiave, valore) {
      try {
        localStorage.setItem(chiave, JSON.stringify(valore));
      } catch {
        /* archiviazione non disponibile: si gioca lo stesso */
      }
    },
    rimuovi(chiave) {
      try {
        localStorage.removeItem(chiave);
      } catch {
        /* niente da fare */
      }
    },
  };
  const chiaveSessione = (codice) => `falsolemma:stanza:${codice}`;

  const codiceDaUrl = () => {
    const m = location.pathname.match(/^\/([A-Za-z]{4})\/?$/);
    return m ? m[1].toUpperCase() : null;
  };
  const linkStanza = (codice) => `${location.origin}/${codice}`;

  const elenco = (nomi) => {
    const n = nomi.map(esc);
    if (n.length <= 1) return n.join('');
    return `${n.slice(0, -1).join(', ')} e ${n[n.length - 1]}`;
  };

  let timerAvviso;
  function avviso(testo) {
    toastEl.textContent = testo;
    toastEl.hidden = false;
    clearTimeout(timerAvviso);
    timerAvviso = setTimeout(() => {
      toastEl.hidden = true;
    }, 3800);
  }

  async function api(metodo, url, corpo) {
    const risposta = await fetch(url, {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json' } : {},
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    let dati = {};
    try {
      dati = await risposta.json();
    } catch {
      /* risposta senza corpo */
    }
    if (!risposta.ok) {
      throw Object.assign(new Error(dati.errore || 'Qualcosa non ha funzionato. Riprova.'), {
        stato: risposta.status,
      });
    }
    return dati;
  }

  /* ------------------------------------------------------------------ */
  /* Stato locale                                                        */
  /* ------------------------------------------------------------------ */

  let sessione = null; // { codice, key, id }
  let stato = null; // ultimo stato ricevuto dal server
  let fonte = null; // EventSource
  let chiaveSchermo = '';
  let selezione = null; // definizione scelta nel voto, prima della conferma
  let bozza = { turno: -1 }; // testi in scrittura, per non perderli
  let pesca = null; // parola pescata dall'elenco
  let paroleUsate = new Set();
  let occupato = false;
  let timerRiconnessione = null;

  const nomeDi = (id) => stato.giocatori.find((p) => p.id === id)?.nome ?? 'Qualcuno';
  const narratore = () => stato.giocatori.find((p) => p.narratore);
  const host = () => stato.giocatori.find((p) => p.host);

  function avatar(giocatore) {
    const i = Math.max(
      stato.giocatori.findIndex((p) => p.id === giocatore.id),
      0
    );
    const iniziale = [...giocatore.nome.trim()][0]?.toUpperCase() || '?';
    return `<span class="av av-${i % 8}" aria-hidden="true">${esc(iniziale)}</span>`;
  }

  /* ------------------------------------------------------------------ */
  /* Collegamento al server                                              */
  /* ------------------------------------------------------------------ */

  function chiudiFonte() {
    clearTimeout(timerRiconnessione);
    if (fonte) {
      fonte.close();
      fonte = null;
    }
  }

  function connetti(azzera = true) {
    chiudiFonte();
    if (azzera) {
      stato = null;
      chiaveSchermo = '';
      app.className = 'app';
      app.innerHTML = '<section class="schermo attesa"><p class="eti">Un attimo</p><h1>Entro nella stanza…</h1><div class="puntini"><span></span><span></span><span></span></div></section>';
      renderBarra();
    }
    fonte = new EventSource(
      `/api/stanze/${sessione.codice}/eventi?key=${encodeURIComponent(sessione.key)}`
    );
    fonte.addEventListener('stato', (e) => applica(JSON.parse(e.data)));
    fonte.onopen = () => {
      bannerOffline.hidden = true;
    };
    fonte.onerror = () => {
      if (stato) bannerOffline.hidden = false;
      if (fonte && fonte.readyState === EventSource.CLOSED) verificaStanza();
    };
  }

  async function verificaStanza() {
    if (!sessione) return;
    try {
      await api(
        'GET',
        `/api/stanze/${sessione.codice}/stato?key=${encodeURIComponent(sessione.key)}`
      );
      timerRiconnessione = setTimeout(() => connetti(false), 2500);
    } catch (e) {
      if (e.stato === 404 || e.stato === 403) {
        avviso('Questa stanza non esiste più.');
        dimenticaStanza();
      } else {
        timerRiconnessione = setTimeout(() => connetti(false), 4000);
      }
    }
  }

  function riconnettiSeServe() {
    if (sessione && (!fonte || fonte.readyState !== EventSource.OPEN)) connetti(false);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) riconnettiSeServe();
  });
  window.addEventListener('online', riconnettiSeServe);

  function dimenticaStanza() {
    if (sessione) memoria.rimuovi(chiaveSessione(sessione.codice));
    chiudiFonte();
    sessione = null;
    stato = null;
    bannerOffline.hidden = true;
    history.replaceState(null, '', '/');
    mostraHome(null);
  }

  function applica(nuovo) {
    if (stato && nuovo.codice === stato.codice && nuovo.v < stato.v) return;
    stato = nuovo;
    render();
  }

  async function azione(tipo, extra = {}) {
    if (occupato) return false;
    occupato = true;
    try {
      const r = await api('POST', `/api/stanze/${sessione.codice}/azione`, {
        key: sessione.key,
        tipo,
        ...extra,
      });
      if (r.stato) applica(r.stato);
      return true;
    } catch (e) {
      avviso(e.message);
      return false;
    } finally {
      occupato = false;
    }
  }

  async function entra(codice, nome) {
    const r = await api('POST', `/api/stanze/${codice}/entra`, { nome });
    memoria.scrivi(chiaveSessione(r.codice), { key: r.key, id: r.id });
    memoria.scrivi('falsolemma:nome', nome);
    sessione = { codice: r.codice, key: r.key, id: r.id };
    history.replaceState(null, '', `/${r.codice}`);
    connetti();
  }

  async function crea(nome) {
    const r = await api('POST', '/api/stanze', { nome });
    memoria.scrivi(chiaveSessione(r.codice), { key: r.key, id: r.id });
    memoria.scrivi('falsolemma:nome', nome);
    sessione = { codice: r.codice, key: r.key, id: r.id };
    history.replaceState(null, '', `/${r.codice}`);
    connetti();
  }

  /* ------------------------------------------------------------------ */
  /* Schermate                                                           */
  /* ------------------------------------------------------------------ */

  function regoleHtml(aperto = false) {
    return `
      <details class="regole"${aperto ? ' open' : ''}>
        <summary>Come si gioca</summary>
        <h3>Il round</h3>
        <ol>
          <li>A turno, un giocatore è il narratore: sceglie dal dizionario una parola poco conosciuta e la dice ad alta voce.</li>
          <li>Il narratore scrive la definizione vera, riscritta con parole sue. Gli altri inventano una definizione credibile.</li>
          <li>Le definizioni vengono mescolate. Ognuno vota quella che crede vera, tranne la propria.</li>
        </ol>
        <h3>I punti</h3>
        <ul>
          <li>Se tutti indovinano la definizione vera, o se non la indovina nessuno: il narratore prende 0 punti e gli altri 2 a testa.</li>
          <li>Negli altri casi: il narratore prende 3 punti, come chi ha indovinato.</li>
          <li>Sempre: 1 punto per ogni voto ricevuto dalla propria definizione (il narratore escluso).</li>
        </ul>
      </details>`;
  }

  function vistaHome(codice) {
    const nome = memoria.leggi('falsolemma:nome') || '';
    return `
      <section class="schermo">
        <p class="eti">Il gioco del dizionario</p>
        <h1 class="titolo-grande">Una parola vera, tante <span class="evid">definizioni false.</span></h1>
        <p class="lead">Ognuno gioca dal proprio telefono. Crea una stanza e manda il link agli amici.</p>
        <div class="campo">
          <label for="nome">Il tuo nome</label>
          <input id="nome" type="text" maxlength="16" autocomplete="nickname" autocapitalize="words" spellcheck="false" enterkeyhint="go" value="${esc(nome)}">
        </div>
        ${
          codice
            ? `<p class="entrando">Stai per entrare nella stanza <strong class="mono">${esc(codice)}</strong></p>
               <button class="btn btn-primario" data-az="entra" data-codice="${esc(codice)}">Entra nella stanza</button>
               <button class="btn btn-link" data-az="home">Crea invece una nuova stanza</button>`
            : `<button class="btn btn-primario" data-az="crea">Crea una stanza</button>
               <div class="oppure"><span>oppure entra con un codice</span></div>
               <div class="riga-codice">
                 <div class="campo">
                   <label class="sr" for="codice">Codice della stanza</label>
                   <input id="codice" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" placeholder="ABCD" enterkeyhint="go">
                 </div>
                 <button class="btn" data-az="entra-codice">Entra</button>
               </div>`
        }
        ${regoleHtml()}
      </section>`;
  }

  function vistaLobby() {
    const { giocatori, io, codice, minGiocatori, maxGiocatori } = stato;
    const n = giocatori.length;
    const righe = giocatori
      .map(
        (p) => `
        <li class="giocatore${p.online ? '' : ' assente'}">
          ${avatar(p)}
          <span class="nome">${esc(p.nome)}</span>
          ${p.id === io.id ? '<span class="etichetta tu">tu</span>' : ''}
          ${p.host ? '<span class="etichetta">host</span>' : ''}
          ${p.online ? '' : '<span class="etichetta">offline</span>'}
        </li>`
      )
      .join('');

    const avvio = io.host
      ? `<div class="azioni-fisse">
           <button class="btn btn-primario" data-az="avvia"${n < minGiocatori ? ' disabled' : ''}>Inizia la partita</button>
           <p class="nota">${
             n < minGiocatori
               ? `Servono almeno ${minGiocatori} giocatori. Ne ${minGiocatori - n === 1 ? 'manca 1' : `mancano ${minGiocatori - n}`}.`
               : `Siete in ${n}: ogni giocatore farà il narratore una volta.`
           }</p>
         </div>`
      : `<p class="nota">Aspettiamo che ${esc(host()?.nome ?? 'l’host')} avvii la partita.</p>`;

    return `
      <section class="schermo">
        <p class="eti">Codice stanza</p>
        <div class="codice" role="img" aria-label="Codice stanza: ${[...codice].join(' ')}">
          ${[...codice].map((c) => `<span>${esc(c)}</span>`).join('')}
        </div>
        <div class="invita">
          <button class="btn btn-pieno" data-az="condividi">Invita gli amici</button>
          <button class="btn btn-pieno" data-az="copia">Copia il link</button>
        </div>
        <h2>Giocatori <small>${n} su ${maxGiocatori}</small></h2>
        <ul class="giocatori">${righe}</ul>
        ${regoleHtml()}
        <button class="btn btn-link" data-az="esci">Esci dalla stanza</button>
        ${avvio}
      </section>`;
  }

  const intestazioneRound = (extra = '') =>
    `<p class="eti">Round ${stato.turno} di ${stato.turni}${extra ? ` · ${extra}` : ''}</p>`;

  function controlliHostHtml() {
    if (!stato.io.host) return '';
    const { fase, giocatori } = stato;
    const altri = giocatori.filter((p) => !p.narratore);
    let primario = '';
    if (fase === 'scrittura') {
      const scritte = altri.filter((p) => p.fatto).length;
      primario = `<button class="btn btn-pieno" data-az="vai_al_voto"${scritte < 1 ? ' disabled' : ''}>Passa al voto adesso</button>`;
    } else if (fase === 'voto') {
      const votati = altri.filter((p) => p.fatto).length;
      primario = `<button class="btn btn-pieno" data-az="chiudi_voto"${votati < 1 ? ' disabled' : ''}>Chiudi il voto adesso</button>`;
    }
    return `
      <div class="host-box">
        <p class="eti">Controlli dell’host</p>
        ${primario}
        <button class="btn btn-link" data-az="salta">Salta questo round</button>
      </div>`;
  }

  function progressoHtml() {
    const { fase, giocatori } = stato;
    if (fase !== 'scrittura' && fase !== 'voto') return '';
    const altri = giocatori.filter((p) => !p.narratore);
    const fatti = altri.filter((p) => p.fatto).length;
    const verbo = fase === 'scrittura' ? 'hanno scritto' : 'hanno votato';
    const chips = altri
      .map(
        (p) => `
        <li class="chip${p.fatto ? ' fatto' : ''}${p.online ? '' : ' offline'}">
          ${avatar(p)}
          <span class="nome">${esc(p.nome)}</span>
          <span class="stato" aria-label="${p.fatto ? 'fatto' : 'in attesa'}">${p.fatto ? '✓' : '…'}</span>
        </li>`
      )
      .join('');
    return `<p class="conteggio"><strong>${fatti} su ${altri.length}</strong> ${verbo}</p><ul class="chips">${chips}</ul>`;
  }

  function statoScritturaHtml() {
    if (stato.fase === 'scrittura' && !stato.io.narratore && stato.miaDefinizione) {
      return '<p class="ok">Definizione inviata. Puoi ancora modificarla finché non hanno finito tutti.</p>';
    }
    return '';
  }

  const regioniDinamiche = () =>
    `<div id="dyn-status">${statoScritturaHtml()}</div>
     <div id="dyn-progress">${progressoHtml()}</div>
     <div id="dyn-host">${controlliHostHtml()}</div>`;

  function vistaParolaNarratore() {
    return `
      <section class="schermo">
        ${intestazioneRound('tocca a te')}
        <h1>Scegli una parola poco conosciuta</h1>
        <p class="lead">Aprila sul dizionario e dilla ad alta voce. Poi scrivi qui la parola e la sua definizione, riscritta con parole tue.</p>
        <div class="campo">
          <label for="parola">La parola</label>
          <input id="parola" type="text" maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="next">
        </div>
        <div class="campo">
          <label for="definizione">La definizione vera, con parole tue</label>
          <textarea id="definizione" rows="4" maxlength="240" autocomplete="off"></textarea>
          <span class="conta">0/240</span>
        </div>
        <details class="pesca" id="pesca">
          <summary>Non hai un dizionario?</summary>
          <p>Pesca una parola da un piccolo elenco. La definizione del dizionario la vedi solo tu: riscrivila prima di inviarla.</p>
          <button class="btn btn-pieno" data-az="pesca">Pesca una parola</button>
          <div id="pesca-esito"></div>
        </details>
        <div id="dyn-host">${controlliHostHtml()}</div>
        <div class="azioni-fisse">
          <button class="btn btn-primario" data-az="invia-parola">Continua</button>
        </div>
      </section>`;
  }

  function vistaAttesaParola() {
    const n = narratore();
    return `
      <section class="schermo attesa">
        ${intestazioneRound()}
        <h1>${esc(n?.nome ?? 'Il narratore')} sta scegliendo una parola</h1>
        <p class="lead">Tra poco la vedrai comparire qui. La dirà anche ad alta voce.</p>
        <div class="puntini" aria-hidden="true"><span></span><span></span><span></span></div>
        ${controlliHostHtml()}
      </section>`;
  }

  const lemmaBox = () => `
    <div class="lemma-box">
      <p class="eti">La parola</p>
      <h1 class="lemma"><span>${esc(stato.parola)}</span></h1>
    </div>`;

  function vistaScrittura() {
    const { io } = stato;
    const n = narratore();
    if (io.narratore) {
      return `
        <section class="schermo">
          ${intestazioneRound('sei il narratore')}
          ${lemmaBox()}
          <p class="lead">La tua definizione è già dentro. Aspetta che gli altri scrivano la loro.</p>
          ${regioniDinamiche()}
        </section>`;
    }
    return `
      <section class="schermo">
        ${intestazioneRound(`narratore: ${esc(n?.nome ?? '')}`)}
        ${lemmaBox()}
        <div class="campo">
          <label for="testo">La tua definizione</label>
          <textarea id="testo" rows="4" maxlength="240" autocomplete="off" placeholder="Scrivila come la scriverebbe un dizionario"></textarea>
          <span class="conta">0/240</span>
        </div>
        ${regioniDinamiche()}
        <div class="azioni-fisse">
          <button class="btn btn-primario" data-az="invia-def">${stato.miaDefinizione ? 'Aggiorna la definizione' : 'Invia la definizione'}</button>
        </div>
      </section>`;
  }

  function vistaVoto() {
    const { io, schede, mioVoto } = stato;
    const n = narratore();
    const votato = Boolean(mioVoto);
    const scelta = votato ? mioVoto : selezione;
    const lead = io.narratore
      ? 'Gli altri stanno votando. Tu conosci già la risposta.'
      : votato
        ? 'Voto inviato. Aspettiamo gli altri.'
        : 'Quale pensi sia la definizione vera? La tua non si può votare.';

    const cards = schede
      .map((s, i) => {
        const bloccata = io.narratore || votato || s.mia;
        const classi = ['scheda'];
        if (scelta === s.id) classi.push('sel');
        if (s.mia) classi.push('mia');
        if (votato) classi.push('bloccata');
        return `
        <li>
          <button class="${classi.join(' ')}" data-az="sel" data-id="${esc(s.id)}" aria-pressed="${scelta === s.id}"${bloccata ? ' disabled' : ''}>
            <span class="lettera" aria-hidden="true">${LETTERE[i] ?? i + 1}</span>
            <span class="testo">${esc(s.testo)}</span>
            ${s.mia ? `<span class="tag">${io.narratore ? 'La tua, quella vera' : 'La tua'}</span>` : ''}
          </button>
        </li>`;
      })
      .join('');

    const conferma =
      !io.narratore && !votato
        ? `<div class="azioni-fisse"><button class="btn btn-primario" data-az="vota"${selezione ? '' : ' disabled'}>Conferma il voto</button></div>`
        : '';

    return `
      <section class="schermo">
        ${intestazioneRound(io.narratore ? 'sei il narratore' : `narratore: ${esc(n?.nome ?? '')}`)}
        ${lemmaBox()}
        <p class="lead">${lead}</p>
        <ol class="schede">${cards}</ol>
        ${progressoHtml()}
        ${controlliHostHtml()}
        ${conferma}
      </section>`;
  }

  function spiegazione(caso, nomeNarratore) {
    const n = esc(nomeNarratore);
    switch (caso) {
      case 'tutti':
        return `Hanno indovinato tutti. ${n} non prende punti, gli altri prendono 2 punti a testa.`;
      case 'nessuno':
        return `Non ha indovinato nessuno. ${n} non prende punti, gli altri prendono 2 punti a testa.`;
      case 'misto':
        return `Qualcuno ha indovinato e qualcuno no. ${n} prende 3 punti, come chi ha indovinato.`;
      default:
        return 'Nessun voto in questo round.';
    }
  }

  function rigaPunteggio(p, { posto, delta, dettaglio, totale }) {
    return `
      <li class="riga-punti${posto === 1 ? ' pos-1' : ''}">
        ${posto !== undefined ? `<span class="posto">${posto}</span>` : ''}
        ${avatar(p)}
        <span class="corpo">
          <span class="nome">${esc(p.nome)}</span>
          ${dettaglio ? `<span class="dettaglio">${dettaglio}</span>` : ''}
        </span>
        ${delta !== undefined ? `<span class="delta${delta > 0 ? ' pos' : ''}">+${delta}</span>` : ''}
        ${totale !== undefined ? `<span class="totale">${totale}</span>` : ''}
      </li>`;
  }

  function vistaRisultato() {
    const { risultato, io, giocatori, turno, turni } = stato;
    const n = narratore();
    const ultimo = turno >= turni;

    const esiti = risultato.schede
      .map((s) => {
        const autore = giocatori.find((p) => p.id === s.autoreId);
        const votanti = s.votanti.map(nomeDi);
        return `
        <li class="esito${s.vera ? ' vera' : ''}">
          <div class="esito-testa">
            <span class="scheda-tag"><span class="etichetta${s.vera ? ' tag-vera' : ''}">${s.vera ? 'Definizione vera' : 'Falsa'}</span></span>
            <span class="autore">${autore ? avatar(autore) : ''}${esc(autore?.nome ?? '')}</span>
          </div>
          <p class="testo">${esc(s.testo)}</p>
          <p class="votanti">${votanti.length ? `Votata da ${elenco(votanti)}` : 'Nessun voto'}</p>
        </li>`;
      })
      .join('');

    const righeRound = [...giocatori]
      .sort((a, b) => risultato.punti[b.id].totale - risultato.punti[a.id].totale)
      .map((p) => {
        const r = risultato.punti[p.id];
        const parti = [];
        if (r.base > 0) parti.push(`+${r.base} per il round`);
        if (r.voti > 0) parti.push(`+${r.voti} per i voti ricevuti`);
        return rigaPunteggio(p, {
          delta: r.totale,
          dettaglio: parti.join(' · ') || (p.narratore ? 'narratore' : ''),
        });
      })
      .join('');

    const ordinati = [...giocatori].sort((a, b) => b.punti - a.punti);
    const righeClassifica = ordinati
      .map((p) =>
        rigaPunteggio(p, {
          posto: 1 + ordinati.filter((q) => q.punti > p.punti).length,
          totale: p.punti,
        })
      )
      .join('');

    let controlli;
    if (io.host || io.narratore) {
      controlli = `
        <div class="azioni-fisse">
          <button class="btn btn-primario" data-az="prossimo">${ultimo ? 'Vedi la classifica finale' : 'Prossimo round'}</button>
          ${io.host && !ultimo ? '<button class="btn btn-link" data-az="termina">Termina la partita</button>' : ''}
        </div>`;
    } else {
      controlli = `<p class="nota">Aspettiamo che ${esc(n?.nome ?? host()?.nome ?? '')} continui.</p>`;
    }

    return `
      <section class="schermo">
        ${intestazioneRound('risultato')}
        ${lemmaBox()}
        <p class="esito-caso">${spiegazione(risultato.caso, n?.nome ?? 'Il narratore')}</p>
        <ol class="esiti">${esiti}</ol>
        <p class="nota">Ogni voto preso da una definizione falsa vale 1 punto per chi l’ha scritta.</p>
        <h2>Punti del round</h2>
        <ul class="punti-round">${righeRound}</ul>
        <h2>Classifica</h2>
        <ol class="classifica">${righeClassifica}</ol>
        ${controlli}
      </section>`;
  }

  function vistaFinale() {
    const { classifica, io } = stato;
    const vincitori = classifica.filter((r) => r.pos === 1);
    const titolo =
      vincitori.length === 1
        ? `Vince ${esc(vincitori[0].nome)}`
        : `Pareggio in testa: ${elenco(vincitori.map((v) => v.nome))}`;
    const righe = classifica
      .map((r) => {
        const p = stato.giocatori.find((g) => g.id === r.id);
        return `
        <li class="riga-punti pos-${Math.min(r.pos, 4)}">
          <span class="posto">${r.pos}</span>
          ${avatar(p)}
          <span class="corpo"><span class="nome">${esc(r.nome)}</span></span>
          <span class="totale">${r.punti}</span>
        </li>`;
      })
      .join('');

    return `
      <section class="schermo">
        <p class="eti">Partita finita</p>
        <h1>${titolo}</h1>
        <p class="lead">${vincitori[0].punti} punti. Ecco come è andata.</p>
        <ol class="podio">${righe}</ol>
        <div class="azioni-fisse">
          ${io.host ? '<button class="btn btn-primario" data-az="nuova">Nuova partita con gli stessi giocatori</button>' : '<p class="nota">Se l’host ricomincia, la partita riparte da qui.</p>'}
          <button class="btn btn-link" data-az="esci">Lascia la stanza</button>
        </div>
      </section>`;
  }

  function vistaCorrente() {
    const { fase, io } = stato;
    switch (fase) {
      case 'lobby':
        return vistaLobby();
      case 'parola':
        return io.narratore ? vistaParolaNarratore() : vistaAttesaParola();
      case 'scrittura':
        return vistaScrittura();
      case 'voto':
        return vistaVoto();
      case 'risultato':
        return vistaRisultato();
      case 'finale':
        return vistaFinale();
      default:
        return '';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Disegno                                                             */
  /* ------------------------------------------------------------------ */

  function renderBarra() {
    const inRound = stato && ['parola', 'scrittura', 'voto', 'risultato'].includes(stato.fase);
    const conClassifica = stato && stato.fase !== 'lobby';
    barra.innerHTML = `
      <div class="barra-in">
        <span class="marchio">Falso <span class="evid">Lemma</span></span>
        <div class="barra-az">
          ${inRound ? `<span class="round">Round ${stato.turno}/${stato.turni}</span>` : ''}
          ${conClassifica ? '<button class="btn btn-mini" data-az="classifica">Classifica</button>' : ''}
        </div>
      </div>`;
    if (foglio.open) riempiFoglio();
  }

  function riempiFoglio() {
    if (!stato) return;
    const ordinati = [...stato.giocatori].sort((a, b) => b.punti - a.punti);
    const righe = ordinati
      .map((p) =>
        rigaPunteggio(p, {
          posto: 1 + ordinati.filter((q) => q.punti > p.punti).length,
          totale: p.punti,
        })
      )
      .join('');
    foglio.innerHTML = `
      <div class="foglio-in">
        <h2>Classifica</h2>
        <ol class="classifica">${righe}</ol>
        <button class="btn btn-pieno" data-az="chiudi-foglio">Chiudi</button>
      </div>`;
  }

  function aggiornaConta(campo) {
    const conta = campo.closest('.campo')?.querySelector('.conta');
    if (conta) conta.textContent = `${campo.value.length}/${campo.maxLength}`;
  }

  function pescaHtml() {
    if (!pesca) return '';
    return `<div class="vocabolo"><p class="eti">Dal dizionario, solo per te</p><p><strong>${esc(pesca.p)}</strong>: ${esc(pesca.d)}</p></div>`;
  }

  function montaCompositore() {
    const { fase, io, turno } = stato;
    if (bozza.turno !== turno) bozza = { turno };
    const imposta = (id, valore) => {
      const el = $(`#${id}`);
      if (!el) return;
      el.value = valore ?? '';
      aggiornaConta(el);
    };
    if (fase === 'parola' && io.narratore) {
      imposta('parola', bozza.parola);
      imposta('definizione', bozza.definizione);
      if (pesca) {
        $('#pesca-esito').innerHTML = pescaHtml();
        $('#pesca').open = true;
      }
    }
    if (fase === 'scrittura' && !io.narratore) {
      imposta('testo', bozza.testo ?? stato.miaDefinizione);
    }
  }

  function aggiornaDinamici() {
    const imposta = (id, html) => {
      const el = $(`#${id}`);
      if (el && el.innerHTML !== html) el.innerHTML = html;
    };
    imposta('dyn-status', statoScritturaHtml());
    imposta('dyn-progress', progressoHtml());
    imposta('dyn-host', controlliHostHtml());
    const invia = $('[data-az="invia-def"]');
    if (invia) {
      invia.textContent = stato.miaDefinizione ? 'Aggiorna la definizione' : 'Invia la definizione';
    }
  }

  function render() {
    if (!stato) return;
    renderBarra();
    const { fase, io, turno } = stato;
    const compositore =
      (fase === 'parola' && io.narratore) || (fase === 'scrittura' && !io.narratore);
    const chiave = `${fase}|${turno}|${io.narratore}`;
    const nuovo = chiave !== chiaveSchermo;

    // Mentre qualcuno scrive, non si ridisegna: il testo e la tastiera restano com'erano.
    if (!nuovo && compositore) {
      aggiornaDinamici();
      return;
    }

    if (nuovo) {
      selezione = null;
      if (fase === 'parola') pesca = null;
    }
    const y = nuovo ? 0 : window.scrollY;
    chiaveSchermo = chiave;
    app.className = nuovo ? 'app anim' : 'app';
    app.innerHTML = vistaCorrente();
    montaCompositore();
    window.scrollTo(0, y);
  }

  function mostraHome(codice) {
    stato = null;
    chiaveSchermo = 'home';
    app.className = 'app anim';
    app.innerHTML = vistaHome(codice);
    renderBarra();
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* Interazione                                                         */
  /* ------------------------------------------------------------------ */

  function pescaParola() {
    const elencoParole = window.PAROLE || [];
    if (!elencoParole.length) return;
    if (paroleUsate.size >= elencoParole.length) paroleUsate = new Set();
    let i;
    do {
      i = Math.floor(Math.random() * elencoParole.length);
    } while (paroleUsate.has(i));
    paroleUsate.add(i);
    pesca = elencoParole[i];
    $('#parola').value = pesca.p;
    bozza.parola = pesca.p;
    $('#pesca-esito').innerHTML = pescaHtml();
  }

  async function copiaLink() {
    const link = linkStanza(stato.codice);
    try {
      await navigator.clipboard.writeText(link);
      avviso('Link copiato. Mandalo agli amici.');
    } catch {
      avviso(`Copia questo link: ${link}`);
    }
  }

  async function condividi() {
    const dati = {
      title: 'Falso Lemma',
      text: `Vieni a giocare a Falso Lemma! Codice stanza: ${stato.codice}`,
      url: linkStanza(stato.codice),
    };
    if (navigator.share) {
      try {
        await navigator.share(dati);
      } catch (e) {
        if (e.name !== 'AbortError') copiaLink();
      }
    } else {
      copiaLink();
    }
  }

  async function provaEntra(codice) {
    const nome = $('#nome').value.trim();
    if (!nome) {
      avviso('Scrivi il tuo nome per continuare.');
      $('#nome').focus();
      return;
    }
    if (!/^[A-Za-z]{4}$/.test(codice)) {
      avviso('Il codice della stanza ha 4 lettere.');
      return;
    }
    try {
      await entra(codice.toUpperCase(), nome);
    } catch (e) {
      avviso(e.message);
    }
  }

  async function gestisciClic(el) {
    const az = el.dataset.az;
    switch (az) {
      case 'crea': {
        const nome = $('#nome').value.trim();
        if (!nome) {
          avviso('Scrivi il tuo nome per continuare.');
          $('#nome').focus();
          return;
        }
        try {
          await crea(nome);
        } catch (e) {
          avviso(e.message);
        }
        return;
      }
      case 'entra':
        return provaEntra(el.dataset.codice);
      case 'entra-codice':
        return provaEntra($('#codice').value.trim());
      case 'home':
        history.replaceState(null, '', '/');
        return mostraHome(null);
      case 'condividi':
        return condividi();
      case 'copia':
        return copiaLink();
      case 'classifica':
        riempiFoglio();
        return foglio.showModal();
      case 'chiudi-foglio':
        return foglio.close();
      case 'pesca':
        return pescaParola();
      case 'sel':
        selezione = el.dataset.id;
        return render();
      case 'vota':
        if (!selezione) return;
        return azione('voto', { scheda: selezione });
      case 'invia-parola':
        return azione('parola', {
          parola: $('#parola').value,
          definizione: $('#definizione').value,
        });
      case 'invia-def':
        return azione('definizione', { testo: $('#testo').value });
      case 'salta':
        if (!confirm('Saltare questo round? Nessuno prende punti.')) return;
        return azione('salta');
      case 'termina':
        if (!confirm('Terminare la partita e vedere la classifica finale?')) return;
        return azione('termina');
      case 'esci': {
        if (!confirm('Vuoi lasciare la stanza?')) return;
        if (stato?.fase === 'lobby') {
          try {
            await api('POST', `/api/stanze/${sessione.codice}/azione`, {
              key: sessione.key,
              tipo: 'esci',
            });
          } catch {
            /* esci comunque */
          }
        }
        return dimenticaStanza();
      }
      default:
        // avvia, vai_al_voto, chiudi_voto, prossimo, nuova
        return azione(az);
    }
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-az]');
    if (el && !el.disabled) gestisciClic(el);
    if (e.target === foglio) foglio.close();
  });

  document.addEventListener('input', (e) => {
    const campo = e.target;
    if (campo.id === 'codice') {
      campo.value = campo.value.toUpperCase().replace(/[^A-Z]/g, '');
      return;
    }
    if (campo.id === 'parola' || campo.id === 'definizione' || campo.id === 'testo') {
      bozza[campo.id] = campo.value;
      aggiornaConta(campo);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const id = e.target.id;
    if (id === 'nome' || id === 'codice') {
      e.preventDefault();
      const principale = $('[data-az="entra"]') || (id === 'codice' ? $('[data-az="entra-codice"]') : $('[data-az="crea"]'));
      principale?.click();
    } else if (id === 'parola') {
      e.preventDefault();
      $('#definizione')?.focus();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Avvio                                                               */
  /* ------------------------------------------------------------------ */

  async function avvio() {
    const codice = codiceDaUrl();
    if (codice) {
      const salvata = memoria.leggi(chiaveSessione(codice));
      if (salvata?.key) {
        try {
          const r = await api('POST', `/api/stanze/${codice}/entra`, { key: salvata.key });
          sessione = { codice: r.codice, key: r.key, id: r.id };
          connetti();
          return;
        } catch (e) {
          memoria.rimuovi(chiaveSessione(codice));
          if (e.stato === 404) {
            avviso(e.message);
            history.replaceState(null, '', '/');
            mostraHome(null);
            return;
          }
        }
      }
    }
    mostraHome(codice);
  }

  avvio();
})();
