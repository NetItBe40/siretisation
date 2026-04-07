'use strict';
const https = require('https');
const { poolSirene } = require('../config/database');

const FIRECRAWL_API_HOST = 'api.firecrawl.dev';
const FIRECRAWL_API_PATH = '/v1/search';
const FIRECRAWL_KEY = 'fc-e148b6e97c474d47bfa7687bb4eb1b6a';
const DELAY_MS = 1500;

const TRUSTED_DOMAINS = [
  'societe.com', 'pappers.fr', 'societeinfo.com', 'infogreffe.fr',
  'verif.com', 'manageo.fr', 'entreprise.data.gouv.fr', 'annuaire-entreprises.data.gouv.fr',
  'scoreit.fr', 'pagesjaunes.fr', 'sirene.fr', 'bilans-entreprises.fr',
  'bodacc.fr', 'journal-officiel.gouv.fr',
  'api-avis-situation-sirene.insee.fr', 'vis-cotisation.com'
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Retry with exponential backoff
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;
const REQUEST_TIMEOUT_MS = 30000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT after ' + ms + 'ms')), ms);
    promise.then(val => { clearTimeout(timer); resolve(val); })
           .catch(err => { clearTimeout(timer); reject(err); });
  });
}

async function firecrawlSearchWithRetry(query) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await withTimeout(firecrawlSearch(query), REQUEST_TIMEOUT_MS);
      return result;
    } catch (err) {
      lastError = err;
      const isRetryable = err.message.includes('TIMEOUT') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('429') ||
        err.message.includes('500') ||
        err.message.includes('502') ||
        err.message.includes('503');
      if (!isRetryable || attempt === MAX_RETRIES) {
        console.error('[Firecrawl] Echec definitif apres ' + attempt + ' tentative(s): ' + err.message);
        return [];
      }
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn('[Firecrawl] Tentative ' + attempt + '/' + MAX_RETRIES + ' echouee (' + err.message + '), retry dans ' + delay + 'ms');
      await sleep(delay);
    }
  }
  return [];
}

function normaliserAdresse(str) {
  if (!str) return '';
  return str.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normaliserCommune(str) {
  if (!str) return '';
  return str.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/SAINT/g, 'ST').replace(/SAINTE/g, 'STE')
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractCPFromAddress(adresse) {
  if (!adresse) return null;
  const m = adresse.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

function extractNumeroRue(adresse) {
  if (!adresse) return { numero: '', rue: '' };
  const m = adresse.match(/^(\d+)\s*(.*)/);
  return m ? { numero: m[1], rue: m[2] } : { numero: '', rue: adresse };
}

// --- Firecrawl API call
function firecrawlSearch(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: query, limit: 20, lang: 'fr', country: 'FR', location: 'France' });
    const opts = {
      hostname: FIRECRAWL_API_HOST, path: FIRECRAWL_API_PATH, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FIRECRAWL_KEY, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('Firecrawl HTTP ' + res.statusCode + ': ' + data.substring(0, 200)));
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.success && json.data) resolve(json.data);
          else resolve([]);
        } catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.write(body);
    req.end();
  });
}

// --- Extract SIRENs from trusted domain results
function extractSirens(results) {
  const candidates = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const url = (r.url || '').toLowerCase();
    const domain = TRUSTED_DOMAINS.find(d => url.includes(d));
    if (!domain) continue;
    const siretMatch = url.match(/(\d{14})/);
    const sirenMatch = url.match(/(\d{9})/);
    let siren = null;
    if (siretMatch) { siren = siretMatch[1].substring(0, 9); }
    else if (sirenMatch) { siren = sirenMatch[1]; }
    if (!siren) {
      const text = (r.markdown || r.description || '');
      const ts = text.match(/\b(\d{14})\b/);
      const tsn = text.match(/\b(\d{9})\b/);
      if (ts) siren = ts[1].substring(0, 9);
      else if (tsn) siren = tsn[1];
    }
    if (siren && siren.length === 9 && !siren.match(/^0{9}$/)) {
      candidates.push({ siren: siren, domain: domain, rank: i + 1, url: url });
    }
  }
  return candidates;
}

// --- Group and rank candidates by SIREN
function scoreSirens(candidates) {
  const groups = {};
  for (const c of candidates) {
    if (!groups[c.siren]) {
      groups[c.siren] = { siren: c.siren, sources: [], bestRank: c.rank, domains: new Set() };
    }
    groups[c.siren].sources.push(c);
    groups[c.siren].domains.add(c.domain);
    if (c.rank < groups[c.siren].bestRank) groups[c.siren].bestRank = c.rank;
  }
  return Object.values(groups).sort((a, b) => {
    if (b.domains.size !== a.domains.size) return b.domains.size - a.domains.size;
    return a.bestRank - b.bestRank;
  });
}

// --- Validate SIREN in SIRENE DB
async function validateSiren(siren) {
  const sql = 'SELECT e.siret, e.siren, e.enseigne_1, e.denomination_usuelle, ' +
    'e.code_postal, e.libelle_commune, e.libelle_voie, e.numero_voie, e.type_voie, ' +
    'e.activite_principale, e.etat_administratif, e.etablissement_siege, ' +
    'ent.denomination, ent.denomination_usuelle_1, ent.categorie_juridique, ent.tranche_effectif_salarie ' +
    'FROM etablissements e LEFT JOIN entreprises ent ON e.siren = ent.siren ' +
    'WHERE e.siren = ? ORDER BY e.etat_administratif ASC, e.date_creation DESC LIMIT 20';
  const [rows] = await poolSirene.execute(sql, [siren]);
  return rows;
}

// --- v10 scoring algorithm
function computeScore(candidate, validationRows, inputData) {
  if (!validationRows || validationRows.length === 0) return { score: 0, details: 'SIREN non trouve dans SIRENE' };
  let bestScore = 0;
  let bestRow = null;
  let bestDetails = '';
  const inputCP = inputData.code_postal || extractCPFromAddress(inputData.adresse);
  const inputCommune = normaliserCommune(inputData.ville);
  const inputAdresse = normaliserAdresse(inputData.adresse);
  for (const row of validationRows) {
    let score = 50;
    let details = [];
    const srcCount = candidate.domains.size;
    if (srcCount >= 3) { score += 20; details.push('sources:+20(' + srcCount + ')'); }
    else if (srcCount >= 2) { score += 15; details.push('sources:+15(' + srcCount + ')'); }
    else { details.push('sources:1'); }
    if (inputCP && row.code_postal) {
      if (inputCP === row.code_postal) { score += 20; details.push('CP:+20'); }
      else { score -= 10; details.push('CP:-10(mismatch ' + row.code_postal + ')'); }
    }
    if (inputCommune && row.libelle_commune) {
      const dbCommune = normaliserCommune(row.libelle_commune);
      if (dbCommune.includes(inputCommune) || inputCommune.includes(dbCommune)) {
        score += 15; details.push('commune:+15');
      }
    }
    if (inputAdresse && row.libelle_voie) {
      const dbAdr = normaliserAdresse((row.numero_voie || '') + ' ' + (row.type_voie || '') + ' ' + row.libelle_voie);
      const inputParts = inputAdresse.split(' ').filter(w => w.length >= 3);
      const matchCount = inputParts.filter(w => dbAdr.includes(w)).length;
      if (inputParts.length > 0 && matchCount / inputParts.length >= 0.5) {
        score += 15; details.push('adresse:+15');
      }
    }
    if (candidate.bestRank === 1) { score += 10; details.push('rank:+10'); }
    else if (candidate.bestRank <= 3) { score += 5; details.push('rank:+5'); }
    if (row.etablissement_siege === 'true' || row.etablissement_siege === 1) {
      score += 2; details.push('siege:+2');
    }
    
    // --- FILTRE ANTI-FAUX-POSITIFS: verifier que le nom correspond ---
    if (inputData && inputData.nom) {
      const nomNormFC = (inputData.nom || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9\s]/g, '');
      const villeNormFC = (inputData.ville || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9\s]/g, '');
      const stopWordsFC = new Set(['SAS','SARL','SCI','SA','EURL','SNC','ETS','AND','THE','LES','DES','POUR','AVEC','PAR','SOCIETE','GROUPE','FRANCE','ENTREPRISE','SERVICES','INTERNATIONAL']);
      const motsSignificatifs = nomNormFC.split(/\s+/).filter(m => m.length >= 3 && !stopWordsFC.has(m) && m !== villeNormFC);
      if (motsSignificatifs.length > 0) {
        const denomCandidat = [row.denomination||'', row.denomination_usuelle_1||'', row.denomination_usuelle||'', row.enseigne_1||'', row.sigle||''].join(' ').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
        const nbMotsTrouves = motsSignificatifs.filter(m => denomCandidat.includes(m)).length;
        if (nbMotsTrouves === 0) {
          score -= 40;
          details.push('NOM_MISMATCH(-40,[' + motsSignificatifs.join(',') + '])');
        } else if (nbMotsTrouves < motsSignificatifs.length) {
          const ratio = nbMotsTrouves / motsSignificatifs.length;
          if (ratio < 0.5) { score -= 20; details.push('NOM_PARTIEL(-20,' + nbMotsTrouves + '/' + motsSignificatifs.length + ')'); }
          else { score += 5; details.push('NOM_PARTIEL(+5,' + nbMotsTrouves + '/' + motsSignificatifs.length + ')'); }
        } else {
          score += 10;
          details.push('NOM_OK(+10)');
        }
      }
    }

if (score > 100) score = 100;
    if (score < 0) score = 0;
    if (score > bestScore) { bestScore = score; bestRow = row; bestDetails = details.join(', '); }
  }
  return { score: bestScore, row: bestRow, details: bestDetails };
}

// --- Main entry point
async function rechercher({ nom, adresse, code_postal, ville, telephone }) {
  const inputData = { nom, adresse, code_postal, ville, telephone };
  const q1Parts = [nom];
  if (ville) q1Parts.push(ville);
  if (code_postal) q1Parts.push(code_postal);
  const query1 = q1Parts.join(' ') + ' SIRET';
  const q2Parts = [nom];
  if (adresse) q2Parts.push(adresse);
  const query2 = q2Parts.join(' ') + ' SIREN';
  const results1 = await firecrawlSearchWithRetry(query1);
  await sleep(DELAY_MS);
  const results2 = await firecrawlSearchWithRetry(query2);
  let allResults = [].concat(results1, results2);

  // --- Requetes variantes: nom sans la ville ---
  const nomNorm = nom.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const villeNorm = (ville || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  if (villeNorm && villeNorm.length >= 3) {
    const villeEscaped = villeNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nomSansVille = nomNorm.replace(new RegExp(villeEscaped, "gi"), "").trim();
    if (nomSansVille && nomSansVille !== nomNorm && nomSansVille.length >= 2) {
      const query3 = nomSansVille + " " + (ville || "") + " " + (code_postal || "") + " SIRET";
      await sleep(DELAY_MS);
      const results3 = await firecrawlSearchWithRetry(query3);
      allResults = allResults.concat(results3);
      console.log("[firecrawl] Requete variante nom sans ville:", query3, results3.length, "resultats");
    }
  }
  // --- Requete variante: premier mot significatif + localisation ---
  const premierMot = nomNorm.split(/\s+/).filter(m => m.length >= 3 && m !== villeNorm)[0];
  if (premierMot && premierMot !== nomNorm) {
    const query4 = premierMot + " " + (code_postal || ville || "") + " SIREN SIRET";
    await sleep(DELAY_MS);
    const results4 = await firecrawlSearchWithRetry(query4);
    allResults = allResults.concat(results4);
    console.log("[firecrawl] Requete variante 1er mot:", query4, results4.length, "resultats");
  }
  const candidates = extractSirens(allResults);
  if (candidates.length === 0) {
    return null;
  }
  const scoredCandidates = scoreSirens(candidates);
  let bestMatch = null;
  let cpMatch = null;
  const inputCP = code_postal || extractCPFromAddress(adresse);
  for (let i = 0; i < Math.min(scoredCandidates.length, 5); i++) {
    const cand = scoredCandidates[i];
    const validationRows = await validateSiren(cand.siren);
    const result = computeScore(cand, validationRows, inputData);
    const match = {
      siren: cand.siren,
      siret: result.row ? result.row.siret : null,
      score: result.score,
      details: result.details,
      sources: cand.domains.size,
      row: result.row
    };
    if (!bestMatch || match.score > bestMatch.score) { bestMatch = match; }
    if (inputCP && result.row && result.row.code_postal === inputCP && !cpMatch) { cpMatch = match; }
  }
  // CP-priority re-ranking (v10 logic)
  if (cpMatch && cpMatch.siren !== bestMatch.siren) {
    if (cpMatch.score >= bestMatch.score || bestMatch.score < 80) { bestMatch = cpMatch; }
  }
  if (!bestMatch || !bestMatch.row) {
    return null;
  }
  const r = bestMatch.row;
  return {
    siren: bestMatch.siren,
    siret: r.siret,
    score: bestMatch.score,
    details: bestMatch.details,
    denomination: r.denomination || r.denomination_usuelle_1 || '',
    enseigne: r.enseigne_1 || r.denomination_usuelle || '',
    adresse_sirene: ((r.numero_voie || '') + ' ' + (r.type_voie || '') + ' ' + (r.libelle_voie || '')).trim(),
    cp_sirene: r.code_postal,
    ville_sirene: r.libelle_commune,
    activite: r.activite_principale,
    etat: r.etat_administratif,
    categorie_juridique: r.categorie_juridique,
    tranche_effectif: r.tranche_effectif_salarie,
    siege: r.etablissement_siege === 'true' || r.etablissement_siege === 1
  };
}

module.exports = { rechercher };