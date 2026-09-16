// Persistenza dello stato per il confronto (diff) tra un controllo e l'altro.
import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../state.json', import.meta.url);

export async function loadState() {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    return null; // primo avvio
  }
}

export async function saveState(state) {
  await writeFile(FILE, JSON.stringify(state, null, 2), 'utf8');
}

// Costruisce lo snapshot confrontabile a partire dai dati scaricati.
export function buildSnapshot(seg, folders, rate) {
  const snapshot = { seg: {}, docs: {}, rate: { totali: rate.totali, righe: {} } };
  for (const s of seg) {
    snapshot.seg[s.id] = { titolo: s.titolo, stato: s.stato, ultimaModifica: s.ultimaModifica, aperto: s.aperto };
  }
  for (const folder of folders) {
    for (const f of folder.files) {
      const key = `${folder.name}||${f.name}`;
      snapshot.docs[key] = { folder: folder.name, name: f.name, query: f.query };
    }
  }
  for (const r of rate.righe) snapshot.rate.righe[r.desc] = r;
  return snapshot;
}
