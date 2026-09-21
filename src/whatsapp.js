// Notifiche WhatsApp tramite OpenWA (https://github.com/rmyndharis/OpenWA).
// Usa la REST API: POST /api/sessions/{session}/messages/send-text
// con header X-API-Key. Solo testo semplice (niente HTML/bottoni).
import { config } from './config.js';

const wa = config.whatsapp;

// Converte un destinatario in chatId WhatsApp.
// Accetta: "393331234567", "+39 333 1234567", "...@c.us" o un gruppo "...@g.us".
function toChatId(recipient) {
  if (recipient.includes('@')) return recipient; // già chatId (c.us o g.us)
  const digits = recipient.replace(/\D/g, '');
  return `${digits}@c.us`;
}

// Rimuove i tag HTML e le entità usate nei messaggi Telegram,
// così lo stesso testo può essere inviato come testo semplice su WhatsApp.
export function toPlainText(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export const whatsappEnabled = wa.enabled;
export const whatsappMaxBytes = wa.maxBytes;

// Indovina il mimetype dall'estensione del file (i documenti del portale
// sono in pratica sempre PDF, ma copriamo i formati più comuni).
function guessMime(filename = '') {
  const ext = filename.toLowerCase().split('.').pop();
  const map = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    txt: 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

// Invia un documento (allegato) a tutti i destinatari configurati.
// buffer: Buffer con il contenuto del file. Non lancia eccezioni.
export async function sendWhatsAppDocument(buffer, filename, caption = '') {
  if (!wa.enabled) return;
  const url = `${wa.baseUrl}/api/sessions/${encodeURIComponent(wa.session)}/messages/send-document`;
  const base64 = buffer.toString('base64');
  const mimetype = guessMime(filename);
  await Promise.all(
    wa.recipients.map(async (recipient) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': wa.apiKey,
          },
          body: JSON.stringify({
            chatId: toChatId(recipient),
            base64,
            mimetype,
            filename: filename.slice(0, 255),
            caption: caption.slice(0, 1024),
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error(`WhatsApp: invio documento a ${recipient} fallito (HTTP ${res.status}) ${body.slice(0, 200)}`);
        }
      } catch (e) {
        console.error(`WhatsApp: invio documento a ${recipient} fallito:`, e.message);
      }
    })
  );
}

// Invia lo stesso testo a tutti i destinatari configurati.
// Non lancia eccezioni: eventuali errori vengono solo loggati, per non
// interrompere l'invio delle notifiche Telegram.
export async function sendWhatsApp(text) {
  if (!wa.enabled) return;
  const url = `${wa.baseUrl}/api/sessions/${encodeURIComponent(wa.session)}/messages/send-text`;
  await Promise.all(
    wa.recipients.map(async (recipient) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': wa.apiKey,
          },
          body: JSON.stringify({ chatId: toChatId(recipient), text }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error(`WhatsApp: invio a ${recipient} fallito (HTTP ${res.status}) ${body.slice(0, 200)}`);
        }
      } catch (e) {
        console.error(`WhatsApp: invio a ${recipient} fallito:`, e.message);
      }
    })
  );
}
