import 'dotenv/config';

function req(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Variabile mancante nel .env: ${name}`);
  return v.trim();
}

// Uno o più id Telegram abilitati, separati da virgola (o spazio).
const ownerIds = req('TELEGRAM_ID_OWNER')
  .split(/[\s,;]+/)
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
if (!ownerIds.length) throw new Error('TELEGRAM_ID_OWNER non contiene id validi.');

// --- WhatsApp via OpenWA (opzionale) ---
// Uno o più destinatari, separati da virgola. Numeri (es. 393331234567)
// oppure chatId completi (393331234567@c.us / <gruppo>@g.us).
const waRecipients = (process.env.OPENWA_RECIPIENTS || '')
  .split(/[\s,;]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const waBaseUrl = (process.env.OPENWA_URL || '').replace(/\/$/, '');
const waApiKey = (process.env.OPENWA_API_KEY || '').trim();
const waSession = (process.env.OPENWA_SESSION || '').trim();
const whatsapp = {
  // Attivo solo se tutti i parametri necessari sono presenti nel .env.
  enabled: Boolean(waBaseUrl && waApiKey && waSession && waRecipients.length),
  baseUrl: waBaseUrl,
  apiKey: waApiKey,
  session: waSession,
  recipients: waRecipients,
};

export const config = {
  baseUrl: req('URL').replace(/\/$/, ''),
  pid: req('PORTAL_PID'),
  user: req('PORTAL_USER'),
  password: req('PORTAL_PASSWORD'),
  botToken: req('TELEGRAM_TOKEN_BOT'),
  // tutti gli id abilitati a usare il bot e a ricevere le notifiche
  ownerIds,
  // Ogni quanti minuti controllare il portale per le notifiche
  pollMinutes: Number(process.env.POLL_MINUTES || 15),
  // Notifiche WhatsApp via OpenWA (opzionale)
  whatsapp,
};
