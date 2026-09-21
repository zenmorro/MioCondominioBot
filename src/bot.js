import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { portal } from './portal.js';
import { loadState, saveState, buildSnapshot } from './state.js';
import { sendWhatsApp, sendWhatsAppDocument, toPlainText, whatsappEnabled, whatsappMaxBytes } from './whatsapp.js';

const FILES_PER_PAGE = 8;

// ---- cache in memoria (unico utente: l'owner) ----
let docCache = []; // cartelle documenti dell'ultimo caricamento
const dlCache = new Map(); // token -> {name, query}  (per i bottoni "Scarica" delle notifiche)
let dlSeq = 0;

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sanitize = (s) => s.replace(/[^\w.\- ]+/g, '_').slice(0, 120);

// =================== VISTE (testo + tastiera) ===================
function mainMenu() {
  const text =
    '🏢 <b>MioCondominio</b>\n\nCosa vuoi vedere?';
  const kb = new InlineKeyboard()
    .text('📅 Scadenze e pagamenti', 'm:rate').row()
    .text('🔧 Guasti e problemi', 'm:seg').row()
    .text('📄 Documenti', 'm:doc').row()
    .text('🔄 Controlla aggiornamenti', 'm:check');
  return { text, kb };
}

function backKb(to = 'm:main') {
  return new InlineKeyboard().text('⬅️ Menu principale', to);
}

async function rateView() {
  const rate = portal.parseRate(await portal.fetchPage('rate.asp'));
  let text = '📅 <b>Scadenze e pagamenti</b>\n';
  const t = rate.totali;
  if (t) {
    text += `\nDovuto: <b>€ ${esc(t.dovuto)}</b>\nVersato: € ${esc(t.versato)}\n` +
      `Saldo: <b>€ ${esc(t.saldo)}</b>\nScaduta: <b>€ ${esc(t.scaduta)}</b>\n`;
  }
  if (rate.righe.length) {
    text += '\n<b>Rate pianificate:</b>\n';
    for (const r of rate.righe) {
      text += `• ${esc(r.desc)} — dovuto € ${esc(r.dovuto)}, saldo € ${esc(r.saldo)}` +
        (r.scaduta && r.scaduta !== '0,00' ? ` ⚠️ scaduta € ${esc(r.scaduta)}` : '') + '\n';
    }
  } else {
    text += '\n<i>Nessuna rata pianificata al momento.</i>';
  }
  return { text, kb: backKb() };
}

async function segView() {
  const seg = portal.parseSegnalazioni(await portal.fetchPage('segnalazioni.asp'));
  let text = `🔧 <b>Guasti e problemi</b> (${seg.length})\n`;
  if (!seg.length) text += '\n<i>Nessuna segnalazione.</i>';
  for (const s of seg.slice(0, 25)) {
    const chiuso = /chiuso/i.test(s.stato);
    text += `\n${chiuso ? '✅' : '🔴'} <b>${esc(s.titolo)}</b>\n` +
      `   ${esc(s.tipo)} · aperto ${esc(s.aperto)} · ${esc(s.richiedente)}\n` +
      `   Stato: ${esc(s.stato)}\n`;
  }
  return { text, kb: backKb() };
}

async function docFoldersView() {
  docCache = portal.parseDocumenti(await portal.fetchPage('documenti.asp'));
  const text = docCache.length
    ? '📄 <b>Documenti</b>\n\nScegli una cartella:'
    : '📄 <b>Documenti</b>\n\n<i>Nessun documento disponibile.</i>';
  const kb = new InlineKeyboard();
  docCache.forEach((f, i) => {
    kb.text(`📁 ${f.name} (${f.files.length})`, `d:f:${i}:0`).row();
  });
  kb.text('⬅️ Menu principale', 'm:main');
  return { text, kb };
}

function docFilesView(folderIdx, page) {
  const folder = docCache[folderIdx];
  if (!folder) return { text: '⚠️ Elenco scaduto, riapri i Documenti.', kb: backKb() };
  const pages = Math.max(1, Math.ceil(folder.files.length / FILES_PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const start = page * FILES_PER_PAGE;
  const slice = folder.files.slice(start, start + FILES_PER_PAGE);
  const text = `📁 <b>${esc(folder.name)}</b>\n\nPagina ${page + 1}/${pages} — tocca un file per riceverlo:`;
  const kb = new InlineKeyboard();
  slice.forEach((file, i) => {
    kb.text(`📄 ${file.name}`.slice(0, 60), `d:g:${folderIdx}:${start + i}`).row();
  });
  const nav = [];
  if (page > 0) nav.push(['⬅️', `d:f:${folderIdx}:${page - 1}`]);
  if (page < pages - 1) nav.push(['➡️', `d:f:${folderIdx}:${page + 1}`]);
  if (nav.length) { nav.forEach(([l, d]) => kb.text(l, d)); kb.row(); }
  kb.text('📂 Cartelle', 'm:doc').text('🏠 Menu', 'm:main');
  return { text, kb };
}

// =================== INVIO DOCUMENTO (scarica → invia → elimina) ===================
async function sendDocument(ctx, file) {
  const note = await ctx.reply(`⏳ Scarico «${esc(file.name)}»…`, { parse_mode: 'HTML' });
  let tmp = null;
  try {
    const { buffer, filename } = await portal.downloadDocument(file.query, file.name);
    tmp = join(tmpdir(), `mc_${Date.now()}_${sanitize(filename)}`);
    await writeFile(tmp, buffer);
    await ctx.replyWithDocument(new InputFile(tmp, filename), {
      caption: `📄 ${esc(filename)}`,
      parse_mode: 'HTML',
    });
    await ctx.api.deleteMessage(ctx.chat.id, note.message_id).catch(() => {});
  } catch (e) {
    await ctx.api
      .editMessageText(ctx.chat.id, note.message_id, `❌ Errore: ${esc(e.message)}`, { parse_mode: 'HTML' })
      .catch(() => {});
  } finally {
    if (tmp) await rm(tmp, { force: true }); // elimina sempre il file dalla macchina
  }
}

// =================== NOTIFICHE (diff) ===================
async function runCheck(bot, { notify }) {
  const [segHtml, docHtml, rateHtml] = await Promise.all([
    portal.fetchPage('segnalazioni.asp'),
    portal.fetchPage('documenti.asp'),
    portal.fetchPage('rate.asp'),
  ]);
  const seg = portal.parseSegnalazioni(segHtml);
  const folders = portal.parseDocumenti(docHtml);
  const rate = portal.parseRate(rateHtml);
  docCache = folders; // tieni fresca anche la cache del menu

  const snapshot = buildSnapshot(seg, folders, rate);
  const prev = await loadState();

  if (!prev) {
    await saveState(snapshot); // primo avvio: baseline, niente spam
    return { baseline: true, changes: 0 };
  }

  let changes = 0;
  // invia la notifica a tutti gli id abilitati
  const send = (text, kb) =>
    Promise.all(
      config.ownerIds.map((id) =>
        bot.api
          .sendMessage(id, text, { parse_mode: 'HTML', reply_markup: kb })
          .catch((e) => console.error(`Invio a ${id} fallito:`, e.message))
      )
    );

  // Invia la notifica su Telegram (con HTML/bottoni) e, se configurato,
  // anche su WhatsApp come testo semplice.
  const sendAll = async (text, kb) => {
    await send(text, kb);
    if (whatsappEnabled) await sendWhatsApp(toPlainText(text));
  };

  // --- Guasti: nuovi + cambi di stato --- (anche su WhatsApp)
  for (const s of seg) {
    const before = prev.seg?.[s.id];
    if (!before) {
      changes++;
      if (notify)
        await sendAll(`🔴 <b>Nuovo guasto/segnalazione</b>\n\n<b>${esc(s.titolo)}</b>\n${esc(s.tipo)} · aperto ${esc(s.aperto)}\nStato: ${esc(s.stato)}`);
    } else if (before.stato !== s.stato) {
      changes++;
      if (notify)
        await sendAll(`🔧 <b>Aggiornamento guasto</b>\n\n<b>${esc(s.titolo)}</b>\n${esc(before.stato)} → <b>${esc(s.stato)}</b>`);
    }
  }

  // --- Documenti: nuovi file (con bottone Scarica) --- (anche su WhatsApp)
  for (const [key, doc] of Object.entries(snapshot.docs)) {
    if (!prev.docs?.[key]) {
      changes++;
      if (notify) {
        const token = String(++dlSeq);
        dlCache.set(token, { name: doc.name, query: doc.query });
        const kb = new InlineKeyboard().text('⬇️ Scarica', `dl:${token}`);
        const text = `📄 <b>Nuovo documento</b>\n\n📁 ${esc(doc.folder)}\n${esc(doc.name)}`;
        await send(text, kb);
        // Su WhatsApp allego il file se rientra nel limite, altrimenti solo il testo.
        if (whatsappEnabled) {
          const caption = `📄 Nuovo documento\n📁 ${doc.folder}\n${doc.name}`;
          try {
            const { buffer, filename } = await portal.downloadDocument(doc.query, doc.name);
            if (buffer.length <= whatsappMaxBytes) {
              await sendWhatsAppDocument(buffer, filename, caption);
            } else {
              const mb = (buffer.length / 1024 / 1024).toFixed(1);
              await sendWhatsApp(
                `${caption}\n\n⚠️ Documento troppo grande per WhatsApp (${mb} MB).\nApri il bot Telegram per scaricarlo.`
              );
            }
          } catch (e) {
            console.error(`WhatsApp: download documento «${doc.name}» fallito:`, e.message);
            await sendWhatsApp(`${caption}\n\nApri il bot Telegram per scaricarlo.`);
          }
        }
      }
    }
  }

  // --- Scadenze: nuove rate o variazione di saldo/scaduta ---
  for (const [desc, r] of Object.entries(snapshot.rate.righe)) {
    const before = prev.rate?.righe?.[desc];
    if (!before) {
      changes++;
      if (notify) await send(`📅 <b>Nuova scadenza</b>\n\n${esc(desc)}\nDovuto € ${esc(r.dovuto)} · saldo € ${esc(r.saldo)}`);
    } else if (before.saldo !== r.saldo || before.scaduta !== r.scaduta) {
      changes++;
      if (notify) await send(`📅 <b>Scadenza aggiornata</b>\n\n${esc(desc)}\nSaldo € ${esc(r.saldo)} · scaduta € ${esc(r.scaduta)}`);
    }
  }
  const tPrev = prev.rate?.totali, tNow = snapshot.rate.totali;
  if (tNow && tPrev && tNow.scaduta !== tPrev.scaduta) {
    changes++;
    if (notify) await send(`📅 <b>Totale scaduto aggiornato</b>\n\n€ ${esc(tPrev.scaduta)} → <b>€ ${esc(tNow.scaduta)}</b>`);
  }

  await saveState(snapshot);
  return { baseline: false, changes };
}

// =================== BOT ===================
export function startBot() {
  const bot = new Bot(config.botToken);

  // Solo gli id abilitati possono usare il bot
  bot.use(async (ctx, next) => {
    if (!config.ownerIds.includes(ctx.from?.id)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery('Non autorizzato.');
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    const { text, kb } = mainMenu();
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  });

  // Test rapido delle notifiche WhatsApp verso i destinatari configurati.
  bot.command('testwa', async (ctx) => {
    if (!whatsappEnabled) {
      await ctx.reply('⚠️ Notifiche WhatsApp disattivate: configura OPENWA_* nel .env.');
      return;
    }
    const note = await ctx.reply('⏳ Invio messaggio di test su WhatsApp…');
    const res = await sendWhatsApp('🔔 Test notifica MioCondominio');
    let msg;
    if (res.ok === res.total) {
      msg = `✅ Test inviato a ${res.ok}/${res.total} destinatario/i WhatsApp.`;
    } else {
      const dett = res.failures.map((f) => `• ${esc(f.recipient)}: ${esc(f.error)}`).join('\n');
      msg = `⚠️ Inviato a ${res.ok}/${res.total}. Falliti:\n${dett}`;
    }
    await ctx.api
      .editMessageText(ctx.chat.id, note.message_id, msg, { parse_mode: 'HTML' })
      .catch(() => ctx.reply(msg, { parse_mode: 'HTML' }));
  });

  // Naviga editando lo stesso messaggio (back senza rifare /start)
  async function navigate(ctx, view) {
    const { text, kb } = view;
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch {
      // "message is not modified" o messaggio troppo vecchio: invia nuovo
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  }

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
      if (data === 'm:main') { await ctx.answerCallbackQuery(); return navigate(ctx, mainMenu()); }
      if (data === 'm:rate') { await ctx.answerCallbackQuery('Carico…'); return navigate(ctx, await rateView()); }
      if (data === 'm:seg') { await ctx.answerCallbackQuery('Carico…'); return navigate(ctx, await segView()); }
      if (data === 'm:doc') { await ctx.answerCallbackQuery('Carico…'); return navigate(ctx, await docFoldersView()); }

      if (data === 'm:check') {
        await ctx.answerCallbackQuery('Controllo in corso…');
        const res = await runCheck(bot, { notify: true });
        await ctx.reply(res.changes ? `✅ Trovate ${res.changes} novità.` : '✅ Nessuna novità.');
        return;
      }

      if (data.startsWith('d:f:')) {
        const [, , idx, page] = data.split(':');
        await ctx.answerCallbackQuery();
        return navigate(ctx, docFilesView(Number(idx), Number(page)));
      }

      if (data.startsWith('d:g:')) {
        const [, , idx, fidx] = data.split(':');
        const file = docCache[Number(idx)]?.files[Number(fidx)];
        if (!file) return ctx.answerCallbackQuery('File non più disponibile, riapri i Documenti.');
        await ctx.answerCallbackQuery('Invio il documento…');
        return sendDocument(ctx, file);
      }

      if (data.startsWith('dl:')) {
        const file = dlCache.get(data.slice(3));
        if (!file) return ctx.answerCallbackQuery('Link scaduto. Aprilo dal menu Documenti.');
        await ctx.answerCallbackQuery('Invio il documento…');
        return sendDocument(ctx, file);
      }

      await ctx.answerCallbackQuery();
    } catch (e) {
      console.error('Errore callback:', e);
      await ctx.answerCallbackQuery('Si è verificato un errore.').catch(() => {});
    }
  });

  bot.catch((err) => console.error('Errore bot:', err.error ?? err));

  // Scheduler notifiche
  function scheduleChecks() {
    const tick = async () => {
      try {
        const res = await runCheck(bot, { notify: true });
        if (res.baseline) console.log('Baseline iniziale salvata (nessuna notifica).');
      } catch (e) {
        console.error('Errore controllo periodico:', e.message);
      }
    };
    tick(); // subito all'avvio
    setInterval(tick, Math.max(1, config.pollMinutes) * 60_000);
  }

  bot.start({
    onStart: () => {
      console.log(`Bot avviato. Controllo ogni ${config.pollMinutes} min.`);
      console.log(
        whatsappEnabled
          ? `Notifiche WhatsApp attive (OpenWA) verso ${config.whatsapp.recipients.length} destinatario/i.`
          : 'Notifiche WhatsApp disattivate (OpenWA non configurato nel .env).'
      );
      scheduleChecks();
    },
  });
}
