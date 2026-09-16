// Client HTTP per il portale miocondominio.eu (ASP classico, nessuna API).
// Fa login, mantiene il cookie di sessione e fa scraping delle pagine interne.
// Solo richieste HTTP (fetch nativo) + cheerio per il parsing. Niente browser.
import * as cheerio from 'cheerio';
import { config } from './config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MioCondominioBot/1.0';

export class Portal {
  constructor(cfg = config) {
    this.cfg = cfg;
    this.base = cfg.baseUrl;
    this.cookies = new Map();
    this.loggedIn = false;
    this._loginPromise = null;
  }

  // ---------- basso livello ----------
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  abs(loc) {
    return /^https?:\/\//i.test(loc) ? loc : `${this.base}/${loc.replace(/^\//, '')}`;
  }

  async raw(url) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Cookie: this.cookieHeader(), Accept: 'text/html,*/*' },
    });
    this.storeCookies(res);
    return res;
  }

  // ---------- login / sessione ----------
  async login(force = false) {
    if (this.loggedIn && !force) return;
    // evita login concorrenti
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = this._doLogin().finally(() => (this._loginPromise = null));
    return this._loginPromise;
  }

  async _doLogin() {
    this.cookies.clear();
    this.loggedIn = false;
    const url =
      `${this.base}/Default.asp?pid=${encodeURIComponent(this.cfg.pid)}` +
      `&login=${encodeURIComponent(this.cfg.user)}` +
      `&password=${encodeURIComponent(this.cfg.password)}`;
    let res = await this.raw(url);
    let loc = res.headers.get('location');
    let hops = 0;
    while (loc && hops++ < 6) {
      res = await this.raw(this.abs(loc));
      loc = res.headers.get('location');
    }
    const body = await res.text();
    if (!/Esci|logout|avvisi\.asp/i.test(body)) {
      throw new Error('Login al portale fallito (credenziali errate o portale non raggiungibile).');
    }
    this.loggedIn = true;
  }

  async ensureLogin() {
    if (!this.loggedIn) await this.login();
  }

  // Scarica una pagina interna; se la sessione è scaduta rifà il login una volta.
  async fetchPage(page, retry = true) {
    await this.ensureLogin();
    let res = await this.raw(`${this.base}/${page.replace(/^\//, '')}`);
    if (res.status !== 200) {
      if (!retry) return res.text();
      await this.login(true);
      res = await this.raw(`${this.base}/${page.replace(/^\//, '')}`);
    }
    return res.text();
  }

  // ---------- parser ----------
  // Guasti e problemi -> array {id, ultimaModifica, aperto, richiedente, tipo, titolo, stato}
  parseSegnalazioni(html) {
    const $ = cheerio.load(html);
    const items = [];
    $('table').each((_, t) => {
      const headers = $(t).find('th').map((i, e) => $(e).text().trim()).get().join('|');
      if (!/Ultima modifica/i.test(headers)) return;
      $(t).find('tbody tr, tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (tds.length < 7) return;
        const href = $(tr).find('a[href*="segnalazioneid="]').attr('href') || '';
        const idm = href.match(/segnalazioneid=(\d+)/);
        if (!idm) return;
        const cell = (i) => $(tds[i]).text().replace(/\s+/g, ' ').trim();
        items.push({
          id: idm[1],
          ultimaModifica: cell(0),
          aperto: cell(1),
          richiedente: cell(2),
          tipo: cell(3),
          titolo: cell(4),
          stato: cell(5),
        });
      });
    });
    return items;
  }

  // Documenti -> array cartelle [{name, files:[{name, query}]}]
  // query = "documenti_geturl.asp?FascicoloID=...&NomeFile=..."
  parseDocumenti(html) {
    const $ = cheerio.load(html);
    const folders = [];
    let current = null;
    $('tr').each((_, tr) => {
      const $tr = $(tr);
      const cls = $tr.attr('class') || '';
      if (cls.includes('parent-row')) {
        current = { name: $tr.find('a').first().text().replace(/\s+/g, ' ').trim(), files: [] };
        folders.push(current);
      } else if (cls.includes('child-row')) {
        const $a = $tr.find('a[onclick]');
        const onclick = $a.attr('onclick') || '';
        const m = onclick.match(/openDocument\(['"]([^'"]+)['"]\)/);
        const name = $a.text().replace(/\s+/g, ' ').trim();
        if (current && m && name) current.files.push({ name, query: m[1] });
      }
    });
    return folders;
  }

  // Scadenze/rate -> {totali:{dovuto,versato,saldo,scaduta}, righe:[{desc,dovuto,versato,saldo,scaduta}]}
  parseRate(html) {
    const $ = cheerio.load(html);
    const out = { totali: null, righe: [] };
    $('table').each((_, t) => {
      const head = $(t).find('th').map((i, e) => $(e).text().trim()).get().join('|');
      if (!/Rate pianificate/i.test(head)) return;
      $(t).find('tbody tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (tds.length < 5) return;
        const cell = (i) => $(tds[i]).text().replace(/\s+/g, ' ').trim();
        // ultima colonna eventuale (bottone) ignorata
        const desc = cell(0);
        const row = {
          desc,
          dovuto: cell(1),
          versato: cell(2),
          saldo: cell(3),
          scaduta: cell(4),
        };
        if (desc) out.righe.push(row);
        else out.totali = { dovuto: row.dovuto, versato: row.versato, saldo: row.saldo, scaduta: row.scaduta };
      });
    });
    return out;
  }

  // ---------- documenti: risoluzione URL e download ----------
  async resolveDocumentUrl(query) {
    await this.ensureLogin();
    let res = await this.raw(`${this.base}/${query.replace(/^\//, '')}`);
    let txt = (await res.text()).trim();
    if (!/^https?:\/\//i.test(txt)) {
      // sessione forse scaduta: riprova
      await this.login(true);
      res = await this.raw(`${this.base}/${query.replace(/^\//, '')}`);
      txt = (await res.text()).trim();
    }
    if (!/^https?:\/\//i.test(txt)) throw new Error('Impossibile ottenere il link del documento.');
    return txt;
  }

  // Scarica il PDF (URL S3 pre-firmato) e restituisce il buffer in memoria.
  async downloadDocument(query, name) {
    const url = await this.resolveDocumentUrl(query);
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Download fallito (HTTP ${res.status}).`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, filename: name };
  }
}

export const portal = new Portal();
