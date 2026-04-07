/**
 * PASSE I - Siretisation via Firecrawl Search (Google)
 * Pour les fiches avec score < 80 apres les passes A-H
 * Recherche Google via Firecrawl, extraction SIRET depuis domaines de confiance,
 * validation croisee avec base SIRENE locale
 */
const https = require('https');
const mysql = require('mysql2/promise');
const fs = require('fs');

const FC_KEY = 'fc-e148b6e97c474d47bfa7687bb4eb1b6a';
const TRUSTED_DOMAINS = [
  'annuaire-entreprises.data.gouv.fr',
  'www.societe.com',
  'www.pappers.fr',
  'entreprises.lefigaro.fr',
  'api-avis-situation-sirene.insee.fr'
];
const DELAY_MS = 1500; // pause entre requetes

// --- Firecrawl Search ---
function firecrawlSearch(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, limit: 5 });
    const opts = {
      hostname: 'api.firecrawl.dev', path: '/v1/search', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + FC_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// --- Extraction SIREN/SIRET depuis resultats ---
function extractSirens(results) {
  const found = [];
  if (!results.data) return found;
  for (const r of results.data) {
    const url = r.url || '';
    const title = r.title || '';
    const desc = r.description || '';
    const markdown = r.markdown || '';
    const text = url + ' ' + title + ' ' + desc + ' ' + markdown.substring(0, 2000);

    const domain = TRUSTED_DOMAINS.find(d => url.includes(d));
    if (!domain) continue;

    // Extraire tous les nombres de 9 ou 14 chiffres
    const nums = new Set();
    // Depuis URL (patterns /entreprise-331216903 ou /mrs-953539475)
    const urlNums = url.match(/\d{9,14}/g) || [];
    urlNums.forEach(n => nums.add(n));
    // Depuis texte (SIRET: 12345678901234, SIREN: 123456789, etc.)
    const textNums = text.match(/\b\d{9}\b|\b\d{14}\b/g) || [];
    textNums.forEach(n => nums.add(n));
    // Depuis texte avec espaces (123 456 789)
    const spaced = text.match(/\b\d{3}\s\d{3}\s\d{3}(?:\s\d{5})?\b/g) || [];
    spaced.forEach(n => nums.add(n.replace(/\s/g, '')));

    for (const n of nums) {
      if (n.length === 9 || n.length === 14) {
        found.push({
          siren: n.substring(0, 9),
          siret: n.length === 14 ? n : null,
          domain,
          url: url.substring(0, 100),
          rank: results.data.indexOf(r)
        });
      }
    }
  }
  return found;
}

// --- Scoring Passe I ---
function scoreFiche(candidates, rec) {
  if (candidates.length === 0) return null;

  // Compter les occurrences de chaque SIREN
  const sirenInfo = {};
  for (const c of candidates) {
    if (!sirenInfo[c.siren]) {
      sirenInfo[c.siren] = { count: 0, siret: null, domains: new Set(), bestRank: 99 };
    }
    sirenInfo[c.siren].count++;
    sirenInfo[c.siren].domains.add(c.domain);
    if (c.siret) sirenInfo[c.siren].siret = c.siret;
    if (c.rank < sirenInfo[c.siren].bestRank) sirenInfo[c.siren].bestRank = c.rank;
  }

  // Trier par: nombre de sources > rang dans Google
  const sorted = Object.entries(sirenInfo)
    .sort((a, b) => b[1].count - a[1].count || a[1].bestRank - b[1].bestRank);

  return sorted.map(([siren, info]) => ({
    siren,
    siret: info.siret,
    sourceCount: info.count,
    domains: [...info.domains],
    bestRank: info.bestRank
  }));
}

// --- Validation SIRENE ---
async function validateSiren(conn, siren, gbRec) {
  const [rows] = await conn.query(
    `SELECT e.siren, et.siret, e.denomination, 
     COALESCE(e.denomination_usuelle_1, '') as denom_usuelle,
     COALESCE(et.enseigne_1, '') as enseigne,
     et.libelle_commune, et.code_postal,
     CONCAT(COALESCE(et.numero_voie,''),' ',COALESCE(et.type_voie,''),' ',COALESCE(et.libelle_voie,'')) as adresse,
     et.activite_principale as naf
     FROM entreprises e 
     JOIN etablissements et ON e.siren = et.siren
     WHERE e.siren = ? AND et.etat_administratif = 'A'
     ORDER BY et.etablissement_siege DESC
     LIMIT 5`,
    [siren]
  );
  if (rows.length === 0) return null;

  // Chercher le meilleur etablissement (CP match > siege > premier)
  let best = rows[0];
  for (const row of rows) {
    if (row.code_postal === gbRec.gb_code_postal) { best = row; break; }
  }

  const cpMatch = best.code_postal === gbRec.gb_code_postal;
  const communeMatch = best.libelle_commune && gbRec.gb_ville &&
    best.libelle_commune.toLowerCase().includes(gbRec.gb_ville.toLowerCase().split(' ')[0]);

  return {
    ...best,
    cpMatch,
    communeMatch,
    geoMatch: cpMatch || communeMatch
  };
}

// --- Calcul score final Passe I ---
function computeScoreI(candidates, validations, gbRec) {
  if (!candidates || candidates.length === 0) return { score: 0, statut: 'ECHOUEE', siret: null, siren: null, methode: null, denomination: null };

  let bestScore = 0;
  let bestMatch = null;

  for (const cand of candidates) {
    const val = validations[cand.siren];
    if (!val) continue; // pas dans SIRENE

    let score = 40; // base: trouvé sur Google + dans SIRENE

    // Bonus sources multiples
    if (cand.sourceCount >= 3) score += 20;
    else if (cand.sourceCount >= 2) score += 10;

    // Bonus CP match
    if (val.cpMatch) score += 25;
    else if (val.communeMatch) score += 15;

    // Bonus rang Google
    if (cand.bestRank === 0) score += 15;
    else if (cand.bestRank === 1) score += 10;
    else if (cand.bestRank <= 3) score += 5;

    // Cap a 100
    score = Math.min(100, score);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { ...cand, validation: val, score };
    }
  }

  if (!bestMatch) return { score: 0, statut: 'ECHOUEE', siret: null, siren: null, methode: null, denomination: null };

  const statut = bestScore >= 80 ? 'MATCHEE' : bestScore >= 50 ? 'INCERTAINE' : 'ECHOUEE';
  return {
    score: bestScore,
    statut,
    siren: bestMatch.siren,
    siret: bestMatch.validation.siret,
    methode: 'passe_I_firecrawl',
    denomination: bestMatch.validation.denomination,
    details: {
      sources: bestMatch.sourceCount,
      domains: bestMatch.domains,
      cpMatch: bestMatch.validation.cpMatch,
      rank: bestMatch.bestRank
    }
  };
}

// --- MAIN ---
async function main() {
  const args = process.argv.slice(2);
  const inputFile = args[0] || '/home/netit972/siretisation_v12.json';
  const outputFile = args[1] || '/home/netit972/siretisation_v13_firecrawl.json';
  const maxRecords = parseInt(args[2]) || 999;

  console.log('=== PASSE I - FIRECRAWL SEARCH ===');
  console.log('Input:', inputFile);
  console.log('Output:', outputFile);

  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'netit972_netit972_sirene_usr',
    password: 'KjaQ5RjwHDAM3cA6fJyX',
    database: 'netit972_netit972_sirene_db'
  });

  const allRecords = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const toProcess = allRecords.filter(r => r.score < 80);
  const limited = toProcess.slice(0, maxRecords);

  console.log(`Total fiches: ${allRecords.length}, Score < 80: ${toProcess.length}, A traiter: ${limited.length}`);
  console.log('');

  let improved = 0, errors = 0, noResult = 0;
  const results = [...allRecords]; // copie
  const resultMap = new Map(results.map((r, i) => [r.gb_id, i]));

  for (let i = 0; i < limited.length; i++) {
    const rec = limited[i];
    const idx = resultMap.get(rec.gb_id);
    const query = `siren siret ${rec.gb_nom} ${rec.gb_adresse || ''} ${rec.gb_code_postal} ${rec.gb_ville || ''} ${rec.gb_categorie || ''}`.substring(0, 200).trim();

    process.stdout.write(`[${i + 1}/${limited.length}] #${rec.gb_id} ${rec.gb_nom.substring(0, 35)} ...`);

    try {
      const fcResults = await firecrawlSearch(query);
      if (!fcResults.success) {
        console.log(' ERR API:', fcResults.error?.substring(0, 50));
        errors++;
        continue;
      }

      const candidates = extractSirens(fcResults);
      const scored = scoreFiche(candidates, rec);

      if (!scored || scored.length === 0) {
        console.log(' aucun SIREN');
        noResult++;
        continue;
      }

      // Valider chaque candidat avec SIRENE
      const validations = {};
      for (const cand of scored.slice(0, 5)) { // max 5 candidats
        const val = await validateSiren(conn, cand.siren, rec);
        if (val) validations[cand.siren] = val;
      }

      const result = computeScoreI(scored, validations, rec);

      if (result.score > rec.score) {
        // Mise a jour
        results[idx] = {
          ...results[idx],
          sir_siren: result.siren,
          sir_siret: result.siret,
          sir_denomination: result.denomination,
          score: result.score,
          statut: result.statut,
          methode: result.methode,
          sir_denomination_usuelle: validations[result.siren]?.denom_usuelle || '',
          sir_enseigne_1: validations[result.siren]?.enseigne || '',
          sir_adresse: validations[result.siren]?.adresse || '',
          sir_code_postal: validations[result.siren]?.code_postal || '',
          sir_commune: validations[result.siren]?.libelle_commune || '',
          sir_naf: validations[result.siren]?.naf || ''
        };
        improved++;
        console.log(` ${rec.score}->${result.score} ${result.statut} (${result.siren}) CP:${result.details.cpMatch ? 'OUI' : 'NON'} src:${result.details.sources}`);
      } else {
        console.log(` score ${result.score} <= ancien ${rec.score}, conserve`);
      }
    } catch (err) {
      console.log(' ERR:', err.message?.substring(0, 60));
      errors++;
    }

    // Rate limit
    if (i < limited.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // Save results
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

  // Stats
  const stats = { MATCHEE: 0, INCERTAINE: 0, ECHOUEE: 0 };
  results.forEach(r => stats[r.statut]++);

  console.log('\n=== RESULTATS PASSE I ===');
  console.log(`Fiches traitees: ${limited.length}`);
  console.log(`Ameliorees: ${improved}`);
  console.log(`Sans resultat: ${noResult}`);
  console.log(`Erreurs: ${errors}`);
  console.log(`Distribution: MATCHEE:${stats.MATCHEE} INCERTAINE:${stats.INCERTAINE} ECHOUEE:${stats.ECHOUEE}`);
  console.log(`Resultats sauves: ${outputFile}`);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
