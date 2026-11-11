# Falso Lemma

Il gioco del dizionario da fare in gruppo, ognuno dal proprio telefono.
Una persona crea una stanza, manda il link agli amici, e si gioca.

## Come funziona il gioco

1. A turno, un giocatore è il **narratore**: sceglie dal dizionario una parola poco conosciuta e la dice ad alta voce.
2. Il narratore scrive la definizione vera, riscritta con parole sue. Gli altri inventano una definizione credibile.
3. Le definizioni vengono mescolate e mostrate a tutti. Ognuno vota quella che crede vera (non si vota la propria).

**Punti**

- Se tutti indovinano la definizione vera, o se non la indovina nessuno: il narratore prende 0 punti, gli altri 2 a testa.
- Negli altri casi: il narratore prende 3 punti e chi ha indovinato prende 3 punti.
- Sempre: 1 punto per ogni voto ricevuto dalla propria definizione (il narratore escluso).

Ogni giocatore fa il narratore una volta, poi compare la classifica finale. Servono da 3 a 12 giocatori.
Per chi non ha un dizionario a portata di mano, il narratore può pescare una parola da un piccolo elenco (`public/parole.js`, puoi aggiungerne altre).

## Provarlo sul tuo computer

Serve [Node.js](https://nodejs.org) 18 o più recente. Non ci sono pacchetti da installare.

```
npm start
```

Poi apri http://localhost:3000. Per provarlo con i telefoni collegati alla stessa rete Wi-Fi, apri
`http://IP-DEL-TUO-COMPUTER:3000` dal telefono.

Per far girare i test: `npm test`.

## Metterlo online (così basta un link)

Il sito è un normale programma Node, quindi va bene qualsiasi servizio che esegue Node.
Un esempio con Render (ha un piano gratuito; le condizioni possono cambiare, controlla sul loro sito):

1. Crea un repository su GitHub e caricaci tutti i file di questa cartella.
2. Su render.com scegli **New → Web Service** e collega il repository.
   In alternativa **New → Blueprint**: il file `render.yaml` fa tutto da solo.
3. Se compili a mano: Runtime `Node`, Build Command `npm install`, Start Command `npm start`.
4. Quando il deploy è finito ottieni un indirizzo tipo `https://falso-lemma.onrender.com`.
   Aprilo, crea una stanza e usa **Invita gli amici**: il link porta direttamente alla stanza.

Nei piani gratuiti il servizio di solito va in pausa dopo un po' di inattività, e il primo caricamento può richiedere
qualche decina di secondi. Conviene aprire il sito un minuto prima di iniziare a giocare.

## Cose da sapere

- Le stanze stanno in memoria: se il server si riavvia, le partite in corso si perdono.
- Le stanze inattive vengono eliminate dopo 6 ore.
- Se chiudi la scheda o il telefono si blocca, riaprendo il link rientri nella stessa stanza con lo stesso nome.
- Dopo l'inizio della partita non possono entrare nuovi giocatori; chi era già dentro può rientrare.
- L'host (chi ha creato la stanza) può passare al voto o chiudere il voto prima del tempo, saltare un round o terminare la partita. Se l'host resta offline per qualche secondo, il ruolo passa a un altro giocatore.
- Chi non vota (per esempio se l'host chiude il voto in anticipo) non prende i punti del round.
- La definizione vera resta sul server fino al risultato: i telefoni degli altri giocatori non la ricevono prima.

## Com'è fatto

- `server.js`: server HTTP, stanze, fasi del gioco, aggiornamenti in tempo reale (Server-Sent Events).
- `punteggio.js`: il calcolo dei punti, isolato e coperto da test.
- `public/`: la pagina (`index.html`), lo stile (`stile.css`), la logica del telefono (`gioco.js`) e le parole (`parole.js`).
- `test/`: test del punteggio e di una partita completa con giocatori simulati.
