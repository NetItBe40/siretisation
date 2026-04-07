/**
 * PASSE I v8 - Siretisation via Firecrawl Search (Google)
 * Corrections v3:
 *  - Requete 1: nom + adresse (comme v2)
 *  - Requete 2 (fallback): adresse seule si Q1 insuffisante
 *  - Fusion des candidats des 2 requetes
 *  - Score base 55, commune matching, multi-source prioritaire
 *  - Comparaison commune en plus du CP
 *  - Firecrawl multi-sources (>=2) TOUJOURS prioritaire sur ancien score
 *  - Extraction SIREN depuis URL avec segments /xxx-SIREN ou /SIREN
 */
const https = require('https');
const mysql = require('mysql2/promise');
const fs = require('fs');

const FC_KEY = 'fc-e148b6e97c474d47bfa7687bb4eb1b6a';
const TRUSTED_DOMAINS = [
  'aubonheurdesdaf.fr',
  'www.mygarages.fr',
  'fr.kompass.com',
  'www.xerfi.com',
  'www.pagesjaunes.fr',
  'www.verif.com',
  'www.infogreffe.fr',
  'www.manageo.fr',
  'www.societe.ninja',
  'www.score3.fr',
  'annuaire-entreprises.data.gouv.fr',
  'www.societe.com',
  'www.pappers.fr',
  'entreprises.lefigaro.fr',
  'api-avis-situation-sirene.insee.fr',
  'www.societeinfo.com'
];
const DELAY_MS = 1500;

function firecrawlSearch(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, limit: 10, lang: "fr", country: "FR", location: "France" });
    const opts = {
      hostname: 'api.firecrawl.dev', path: '/v1/search', method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+FC_KEY, 'Content-Length':Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try{resolve(JSON.parse(data))}catch(e){reject(new Error('JSON parse: '+data.substring(0,200)))} });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body); req.end();
  });
}

function extractSirens(results) {
  const found = [];
  if (!results.data) return found;
  for (const r of results.data) {
    const url = r.url || '', title = r.title || '', desc = r.description || '', markdown = r.markdown || '';
    const text = url + ' ' + title + ' ' + desc + ' ' + markdown.substring(0, 2000);
    const domain = TRUSTED_DOMAINS.find(d => url.includes(d));
    if (!domain) continue;
    const nums = new Set();
    // Extract from URL path segments (e.g. /entreprise/xxx-814811774 or /814811774)
    const urlSegments = url.match(/[\/-](\d{9,14})(?:[\/?\-#]|$)/g) || [];
    urlSegments.forEach(s => { const m = s.match(/(\d{9,14})/); if (m) nums.add(m[1]); });
    // Standard patterns
    (url.match(/\d{9,14}/g) || []).forEach(n => nums.add(n));
    (text.match(/\b\d{9}\b/g) || []).forEach(n => nums.add(n));
    (text.match(/\b\d{14}\b/g) || []).forEach(n => nums.add(n));
    // Spaced patterns: 814 811 774 or 814 811 774 00011
    (text.match(/\b\d{3}\s\d{3}\s\d{3}(?:\s\d{5})?\b/g) || []).forEach(n => nums.add(n.replace(/\s/g, '')));
    for (const n of nums) {
      if (n.length === 9 || n.length === 14) {
        found.push({ siren: n.substring(0, 9), siret: n.length === 14 ? n : null, domain, url: url.substring(0, 120), rank: results.data.indexOf(r) });
      }
    }
  }
  return found;
}

function scoreFiche(candidates) {
  if (candidates.length === 0) return null;
  const sirenInfo = {};
  for (const c of candidates) {
    if (!sirenInfo[c.siren]) sirenInfo[c.siren] = { count: 0, siret: null, domains: new Set(), bestRank: 99 };
    sirenInfo[c.siren].count++;
    sirenInfo[c.siren].domains.add(c.domain);
    if (c.siret) sirenInfo[c.siren].siret = c.siret;
    if (c.rank < sirenInfo[c.siren].bestRank) sirenInfo[c.siren].bestRank = c.rank;
  }
  return Object.entries(sirenInfo)
    .sort((a, b) => b[1].domains.size - a[1].domains.size || b[1].count - a[1].count || a[1].bestRank - b[1].bestRank)
    .map(([siren, info]) => ({ siren, siret: info.siret, sourceCount: info.domains.size, domains: [...info.domains], bestRank: info.bestRank }));
}


// --- Fallback: search SIRENE by name + CP ---
async function searchSireneByNameCp(conn, gbRec) {
  const nom = gbRec.gb_nom || gbRec.nom_gb || '';
  const cp = gbRec.gb_code_postal || gbRec.code_postal || '';
  const adresseCp = extractCpFromAdresse(gbRec.gb_adresse || gbRec.adresse_gb || '');
  const effectiveCp = cp || adresseCp;
  if (!nom || !effectiveCp) return [];
  
  // Extract keywords from nom (remove common words)
  const stopWords = ['le','la','les','de','du','des','et','en','au','aux','a','l','d','agence','chez','mr','mme'];
  const words = nom.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.includes(w));
  
  if (words.length === 0) return [];
  
  // Build LIKE conditions for denomination + enseigne
  const likeConditions = words.slice(0, 3).map(w => 
    `(e.denomination LIKE ? OR et.denomination_usuelle LIKE ? OR et.enseigne_1 LIKE ?)`
  ).join(' AND ');
  const params = [];
  words.slice(0, 3).forEach(w => { params.push(`%${w}%`, `%${w}%`, `%${w}%`); });
  
  const sql = `SELECT et.siret, et.siren, e.denomination, et.denomination_usuelle,
    et.enseigne_1, et.code_postal, et.libelle_commune,
    et.numero_voie, et.type_voie, et.libelle_voie,
    et.activite_principale, et.etat_administratif
    FROM etablissements et JOIN entreprises e ON et.siren = e.siren
    WHERE et.code_postal = ? AND ${likeConditions}
    ORDER BY et.etat_administratif ASC, et.etablissement_siege DESC LIMIT 5`;
  
  try {
    const [rows] = await conn.execute(sql, [effectiveCp, ...params]);
    return rows;
  } catch(e) { return []; }
}

// --- Extract CP from gb_adresse ---
function extractCpFromAdresse(adresse) {
  if (!adresse) return null;
  const m = adresse.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

// --- Normalisation adresse ---
function normalizeAdresse(s) {
  if (!s) return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractNumeroRue(adresse) {
  if (!adresse) return { numero: '', rue: '' };
  const norm = normalizeAdresse(adresse.split(',')[0]);
  const m = norm.match(/^(\d+)\s+(.+)/);
  if (m) return { numero: m[1], rue: m[2] };
  return { numero: '', rue: norm };
}


function normalizeCommune(s) {
  if (!s) return '';
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-']/g, ' ').replace(/\b(st|ste)\b/g, 'saint').replace(/\s+/g, ' ').trim();
}

async function validateSiren(conn, siren, gbRec) {
  const [rows] = await conn.query(
    `SELECT e.siren, et.siret, e.denomination, COALESCE(e.denomination_usuelle_1,'') as denom_usuelle,
     COALESCE(et.enseigne_1,'') as enseigne, et.libelle_commune, et.code_postal,
     CONCAT(COALESCE(et.numero_voie,''),' ',COALESCE(et.type_voie,''),' ',COALESCE(et.libelle_voie,'')) as adresse,
     et.activite_principale as naf
     FROM entreprises e JOIN etablissements et ON e.siren=et.siren
     WHERE e.siren=? ORDER BY et.etat_administratif ASC, et.etablissement_siege DESC LIMIT 5`, [siren]);
  if (!rows.length) return null;
  // Find best matching etablissement
  let best = rows[0];
  for (const row of rows) {
    const adresseCp = extractCpFromAdresse(gbRec.gb_adresse || gbRec.adresse_gb || '');
      if (row.code_postal === gbRec.gb_code_postal || (adresseCp && row.code_postal === adresseCp)) { best = row; break; }
  }
  const adresseCp2 = extractCpFromAdresse(gbRec.gb_adresse || gbRec.adresse_gb || '');
  const cpMatch = best.code_postal === gbRec.gb_code_postal || (adresseCp2 && best.code_postal === adresseCp2);
  // Commune comparison (handles code commune vs code postal mismatch)
  const gbVille = normalizeCommune(gbRec.gb_ville);
  const sirCommune = normalizeCommune(best.libelle_commune);
  const communeMatch = gbVille && sirCommune && (
    sirCommune.includes(gbVille.split(' ')[0]) || gbVille.includes(sirCommune.split(' ')[0])
  );
  // Also try: GB adresse contains commune name
  const gbAdresse = normalizeCommune(gbRec.gb_adresse || '');
  const adresseHasCommune = sirCommune && gbAdresse.includes(sirCommune.split(' ')[0]);
  // Exact address match
    const gbAddr = extractNumeroRue(gbRec.gb_adresse || gbRec.adresse_gb || '');
    const sirAddr = { numero: (best.numero_voie || '').toString(), rue: normalizeAdresse((best.type_voie || '') + ' ' + (best.libelle_voie || '')) };
    const adresseExacte = gbAddr.numero && sirAddr.numero && gbAddr.numero === sirAddr.numero && sirAddr.rue && gbAddr.rue.includes(sirAddr.rue.split(' ').pop());
    return { ...best, cpMatch, communeMatch: communeMatch || adresseHasCommune, geoMatch: cpMatch || communeMatch || adresseHasCommune, adresseExacte };
}

function computeScoreI(candidates, validations, gbRec) {
  if (!candidates || !candidates.length) return { score: 0, statut: 'ECHOUEE', siret: null, siren: null, methode: null, denomination: null, multiSource: false };
  
  // v8: Score ALL candidates independently, then pick best with CP-priority
  const allScored = [];
  
  for (const cand of candidates) {
    const val = validations[cand.siren];
    if (!val) continue;
    
    let score = 55; // Base score
    
    // Source count bonus
    if (cand.sourceCount >= 3) score += 20;
    else if (cand.sourceCount >= 2) score += 15;
    
    // Geo validation
    const gbCp = gbRec.gb_code_postal || gbRec.code_postal || '';
    const adresseCp = extractCpFromAdresse(gbRec.gb_adresse || gbRec.adresse_gb || '');
    const cpMatch = val.code_postal === gbCp || (adresseCp && val.code_postal === adresseCp);
    
    // Commune comparison
    const gbVille = normalizeCommune(gbRec.gb_ville);
    const sirCommune = normalizeCommune(val.libelle_commune);
    const communeMatch = gbVille && sirCommune && (
      sirCommune.includes(gbVille.split(' ')[0]) || gbVille.includes(sirCommune.split(' ')[0])
    );
    const gbAdresse = normalizeCommune(gbRec.gb_adresse || gbRec.adresse_gb || '');
    const adresseHasCommune = sirCommune && gbAdresse.includes(sirCommune.split(' ')[0]);
    const geoMatch = cpMatch || communeMatch || adresseHasCommune;
    
    if (cpMatch) score += 20;
    if (communeMatch || adresseHasCommune) score += 15;
    
    // Exact address match
    const gbAddr = extractNumeroRue(gbRec.gb_adresse || gbRec.adresse_gb || '');
    const sirAddr = { numero: (val.numero_voie || '').toString(), rue: normalizeAdresse((val.type_voie || '') + ' ' + (val.libelle_voie || '')) };
    const adresseExacte = gbAddr.numero && sirAddr.numero && gbAddr.numero === sirAddr.numero && sirAddr.rue && gbAddr.rue && sirAddr.rue.includes(gbAddr.rue.split(' ').pop());
    if (adresseExacte) score += 15;
    
    // Rank bonus
    if (cand.bestRank === 0) score += 10;
    else if (cand.bestRank <= 2) score += 5;
    
    // v8: Address mismatch penalty (from v7)
    const gbAddrNorm = normalizeAdresse(gbRec.gb_adresse || gbRec.adresse_gb || '').split(',')[0];
    const sirAddrNorm = normalizeAdresse((val.numero_voie||'') + ' ' + (val.type_voie||'') + ' ' + (val.libelle_voie||''));
    if (sirAddrNorm && gbAddrNorm && sirAddrNorm.length > 3 && gbAddrNorm.length > 3) {
      if (!gbAddrNorm.includes(sirAddrNorm.split(' ').pop()) && !sirAddrNorm.includes(gbAddrNorm.split(' ').pop())) {
        score -= 10;
      }
    }
    
    // v8: National entity penalty - if SIREN has many establishments in different CPs
    // Check if this is likely a national entity (many different postal codes)
    // We detect this by checking if the denomination contains national brand keywords
    // but the fiche name is different from SIRENE denomination
    
    allScored.push({
      score, siren: cand.siren, siret: cand.siret || val.siret,
      sourceCount: cand.sourceCount, domains: cand.domains, bestRank: cand.bestRank,
      validation: { cpMatch, communeMatch: communeMatch || adresseHasCommune, adresseExacte, geoMatch },
      val
    });
  }
  
  if (allScored.length === 0) return { score: 0, statut: 'ECHOUEE', siret: null, siren: null, methode: null, denomination: null, multiSource: false };
  
  // v8: CP-PRIORITY RE-RANKING
  // Sort by score descending
  allScored.sort((a, b) => b.score - a.score);
  
  let bestMatch = allScored[0];
  
  // v8: If best candidate has NO cpMatch, check if any other candidate HAS cpMatch
  // and has at least 1 trusted source. If so, prefer the CP-matching one.
  if (!bestMatch.validation.cpMatch) {
    const cpCandidate = allScored.find(c => c.validation.cpMatch && c.sourceCount >= 1);
    if (cpCandidate) {
      console.log(`  v8 CP-PRIORITY: switching from ${bestMatch.siren} (score:${bestMatch.score}, cpMatch:false) to ${cpCandidate.siren} (score:${cpCandidate.score}, cpMatch:true)`);
      bestMatch = cpCandidate;
      // Boost the CP-matching candidate score to at least 80
      if (bestMatch.score < 80) bestMatch.score = 80;
    }
  }
  
  const statut = bestMatch.score >= 80 ? 'MATCHEE' : bestMatch.score >= 50 ? 'INCERTAINE' : 'ECHOUEE';
  
  return {
    score: bestMatch.score, statut, siren: bestMatch.siren,
    siret: bestMatch.siret || bestMatch.val.siret,
    methode: 'PASSE I v8',
    denomination: bestMatch.val.denomination || bestMatch.val.denomination_usuelle || bestMatch.val.enseigne_1,
    sir_siren: bestMatch.siren, sir_siret: bestMatch.val.siret,
    sir_denomination: bestMatch.val.denomination, sir_denomination_usuelle: bestMatch.val.denomination_usuelle,
    sir_enseigne_1: bestMatch.val.enseigne_1,
    sir_adresse: ((bestMatch.val.numero_voie||'') + ' ' + (bestMatch.val.type_voie||'') + ' ' + (bestMatch.val.libelle_voie||'')).trim(),
    sir_code_postal: bestMatch.val.code_postal, sir_commune: bestMatch.val.libelle_commune,
    sir_naf: bestMatch.val.activite_principale, sir_etat: bestMatch.val.etat_administratif,
    naf: bestMatch.val.activite_principale, cp_sirene: bestMatch.val.code_postal,
    multiSource: bestMatch.sourceCount >= 2,
    details: { sources: bestMatch.sourceCount, domains: bestMatch.domains,
      cpMatch: bestMatch.validation.cpMatch, communeMatch: bestMatch.validation.communeMatch,
      rank: bestMatch.bestRank }
  };
}


async function main() {
  const inputFile = process.argv[2] || '/home/netit972/siretisation_v12.json';
  const scoreThreshold = parseInt(process.argv[3]) || 80;
  const outputFile = process.argv[4] || '/home/netit972/siretisation_v18_firecrawl.json';
  const maxRecords = parseInt(process.argv[5]) || 999;

  console.log('=== PASSE I v8 - FIRECRAWL SEARCH ===');
  console.log('Input:', inputFile);
  console.log('Output:', outputFile);

  const results = JSON.parse(fs.readFileSync(inputFile));
  const limited = results.filter(r => (r.score || 0) < scoreThreshold).slice(0, maxRecords);
  console.log(`Total fiches: ${results.length}, Score < 80: ${limited.length}, A traiter: ${limited.length}`);

  const conn = await mysql.createConnection({ host: 'localhost', user: 'netit972_netit972_sirene_usr', password: 'KjaQ5RjwHDAM3cA6fJyX', database: 'netit972_netit972_sirene_db' });

  let improved = 0, noResult = 0, errors = 0, forced = 0;

  for (let i = 0; i < limited.length; i++) {
    const rec = limited[i];
    const idx = results.indexOf(rec);
    const nom = rec.gb_nom || rec.nom_gb || '';
    const adresse = rec.gb_adresse || rec.adresse_gb || '';
    const cp = rec.gb_code_postal || rec.code_postal || '';
    const ville = rec.gb_ville || rec.ville || '';
    const cat = rec.gb_categorie || rec.categorie || '';

    // --- Requete 1: nom + adresse ---
      const query1 = `siren siret ${nom} ${adresse.split(',')[0]} ${cp} ${ville} ${cat}`.substring(0, 200);

    try {
      const fcResults1 = await firecrawlSearch(query1);
      let candidates = extractSirens(fcResults1);
      let scored = scoreFiche(candidates);

      // --- Requete 2 (fallback): adresse seule si Q1 insuffisante ---
      const bestQ1 = scored && scored.length > 0 ? scored[0].sourceCount : 0;
      if (bestQ1 < 2 && adresse) {
        const adressePart = adresse.split(',')[0].trim();
        const query2 = `siren siret ${adressePart} ${cp} ${ville}`.substring(0, 200);
        console.log(`  -> Fallback Q2: ${query2}`);
        await new Promise(r => setTimeout(r, DELAY_MS));
        const fcResults2 = await firecrawlSearch(query2);
        const candidates2 = extractSirens(fcResults2);
        // Fusionner: ajouter les candidats Q2 aux candidats Q1
        for (const c2 of candidates2) {
          const existing = candidates.find(c => c.siren === c2.siren);
          if (!existing) {
            candidates.push(c2);
          } else if (!existing.siret && c2.siret) {
            existing.siret = c2.siret;
          }
          // Le domain sera compté dans scoreFiche via le Set
        }
        // Fusionner les candidats bruts et re-scorer
        candidates = [...candidates, ...candidates2];
        scored = scoreFiche(candidates);
      }

      if (!scored || scored.length === 0) {
        console.log(`[${i+1}/${limited.length}] #${rec.gb_id||rec.id} ${nom.substring(0,40)} ... aucun SIREN`);
        noResult++;
        continue;
      }

      const validations = {};
      for (const cand of scored.slice(0, 10)) {
        const val = await validateSiren(conn, cand.siren, rec);
        if (val) validations[cand.siren] = val;
      }

      let result = computeScoreI(scored, validations, rec);

      // v7: Fallback - search SIRENE directly by name + CP
      if (!result.siren || result.score < 80) {
        const sireneRows = await searchSireneByNameCp(conn, rec);
        if (sireneRows.length > 0) {
          const bestSirene = sireneRows[0];
          const sireneFallbackScore = 70; // Base score for SIRENE direct match
          const cpOk = bestSirene.code_postal === (rec.gb_code_postal || rec.code_postal);
          const finalScore = sireneFallbackScore + (cpOk ? 15 : 0);
          if (finalScore > (result.score || 0)) {
            result = {
              siren: bestSirene.siren,
              siret: bestSirene.siret,
              denomination: bestSirene.denomination || bestSirene.denomination_usuelle || bestSirene.enseigne_1,
              score: finalScore,
              methode: 'passe_I_firecrawl_v7',
              multiSource: false,
              details: {
                sources: 0,
                domains: ['sirene_db_fallback'],
                cpMatch: cpOk,
                communeMatch: true,
                rank: -1,
                adresseExacte: false
              }
            };
            console.log(`  -> SIRENE DB fallback: ${bestSirene.siren} ${bestSirene.denomination} CP:${bestSirene.code_postal}`);
          }
        }
      }

      if (!result.siren) {
        console.log(`[${i+1}/${limited.length}] #${rec.gb_id||rec.id} ${nom.substring(0,40)} ... aucun SIREN valide`);
        noResult++;
        continue;
      }

      // v2: FORCE replacement if multi-source (>=2 trusted domains found same SIREN)
      const shouldReplace = result.score > (rec.score || 0) || (result.multiSource && result.siren !== (rec.sir_siren || rec.siren));
      
      if (shouldReplace) {
        const wasForced = result.score <= (rec.score || 0);
        results[idx] = {
          ...results[idx],
          sir_siren: result.siren,
          sir_siret: result.siret,
          sir_denomination: result.denomination,
          score: Math.max(result.score, wasForced ? 75 : result.score), // forced = min 75
          statut: result.score >= 80 ? 'MATCHEE' : (result.multiSource ? 'MATCHEE' : result.statut),
          methode: result.methode,
          sir_denomination_usuelle: validations[result.siren]?.denom_usuelle || '',
          sir_enseigne_1: validations[result.siren]?.enseigne || '',
          sir_adresse: validations[result.siren]?.adresse || '',
          sir_code_postal: validations[result.siren]?.code_postal || '',
          sir_commune: validations[result.siren]?.libelle_commune || '',
          sir_naf: validations[result.siren]?.naf || '',
          details: result.details
        };
        improved++;
        if (wasForced) forced++;
        const tag = wasForced ? 'FORCE' : '';
        console.log(` ${rec.score||0}->${results[idx].score} ${results[idx].statut} (${result.siren}) CP:${result.details.cpMatch?'OUI':'NON'} COM:${result.details.communeMatch?'OUI':'NON'} src:${result.details.sources} ${tag} [${i+1}/${limited.length}] #${rec.gb_id||rec.id} ${nom.substring(0,35)}`);
      } else {
        console.log(` score ${result.score} <= ancien ${rec.score}, conserve [${i+1}/${limited.length}] #${rec.gb_id||rec.id} ${nom.substring(0,35)}`);
      }
    } catch (err) {
      console.log(` ERR: ${err.message?.substring(0, 60)} [${i+1}/${limited.length}] #${rec.gb_id||rec.id}`);
      errors++;
    }

    if (i < limited.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

  const stats = { MATCHEE: 0, INCERTAINE: 0, ECHOUEE: 0 };
  results.forEach(r => stats[r.statut]++);

  console.log('\n=== RESULTATS PASSE I v8 ===');
  console.log(`Fiches traitees: ${limited.length}`);
  console.log(`Ameliorees: ${improved} (dont ${forced} forcees multi-source)`);
  console.log(`Sans resultat: ${noResult}`);
  console.log(`Erreurs: ${errors}`);
  console.log(`Distribution: MATCHEE:${stats.MATCHEE} INCERTAINE:${stats.INCERTAINE} ECHOUEE:${stats.ECHOUEE}`);
  console.log(`Resultats sauves: ${outputFile}`);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
