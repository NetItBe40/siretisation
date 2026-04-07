const mysql = require('mysql2/promise');
const http = require('http');
const fs = require('fs');
const path = require('path');

function readEnv(fp) {
  const env = {};
  fs.readFileSync(fp,'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^([^#=][^=]*)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  });
  return env;
}
const fbEnv = readEnv(path.join(process.env.HOME, 'france-business-scraper/.env'));
const SIRENE_DB = { host:'localhost', user:'netit972_netit972_sirene_usr', password:'KjaQ5RjwHDAM3cA6fJyX', database:'netit972_netit972_sirene_db' };
const FB_DB = { host: fbEnv.DB_HOST||'localhost', user: fbEnv.DB_USER, password: fbEnv.DB_PASSWORD, database: fbEnv.DB_NAME };
const API_BASE = 'http://localhost:3005';
const API_KEY = 'be96b82258966d38b674de824e9675ce76321dd858808f85b9a2791bbb36ffd9';

// ===== TABLE DE CORRESPONDANCE CATEGORIE GB -> NAF =====
const CAT_NAF_MAP = {
  'centre de controle technique': ['71.20A','71.20B'],
  'controle technique': ['71.20A','71.20B'],
  'avocat': ['69.10Z'],
  'cabinet d\'avocats': ['69.10Z'],
  'restaurant': ['56.10A','56.10B','56.10C'],
  'restaurant francais': ['56.10A','56.10B','56.10C'],
  'restaurants': ['56.10A','56.10B','56.10C'],
  'brasserie': ['56.10A','56.10B'],
  'pizzeria': ['56.10A','56.10C'],
  'boulangerie': ['10.71C','10.71D'],
  'patisserie': ['10.71C','10.71D'],
  'boulangerie-patisserie': ['10.71C','10.71D'],
  'coiffeur': ['96.02A','96.02B'],
  'salon de coiffure': ['96.02A','96.02B'],
  'pharmacie': ['47.73Z'],
  'magasin de chaussures': ['47.72A','47.72B'],
  'attraction touristique': ['56.10A','55.10Z','93.29Z','91.02Z'],
  'architecte paysagiste': ['81.30Z','71.11Z'],
  'paysagiste': ['81.30Z'],
  'pompes funebres': ['96.03Z'],
  'fleuriste': ['47.76Z'],
  'garage automobile': ['45.20A','45.20B'],
  'agence immobiliere': ['68.31Z'],
  'supermarche': ['47.11B','47.11C','47.11D'],
  'hotel': ['55.10Z'],
  'plombier': ['43.22A'],
  'electricien': ['43.21A'],
  'serrurerie': ['43.32B'],
  'serrurier': ['43.32B'],
  'opticien': ['47.78A'],
  'dentiste': ['86.23Z'],
  'medecin': ['86.21Z'],
  'veterinaire': ['75.00Z'],
  'auto-ecole': ['85.53Z'],
  'enregistre': [],  // trop generique, pas de filtre NAF
};

// ===== MOTS GENERIQUES A DEPRIORITISER =====
const GENERIC_WORDS = new Set([
  'controle','technique','centre','pompes','funebres','marbrerie',
  'piscine','jardin','magasin','boutique','shop','restaurant',
  'brasserie','cafe','bar','hotel','garage','auto','salon',
  'coiffure','beaute','institut','agence','cabinet','atelier',
  'espace','maison','chez','la','le','les','de','du','des','et',
  'a','au','aux','en','sur','par','pour','avec','dans','son','sa'
]);
function apiSearch(endpoint, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    http.get(API_BASE + endpoint + '?' + qs, { timeout: 15000, headers: { 'X-API-Key': API_KEY } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ error: data.substring(0,200) }); } });
    }).on('error', reject);
  });
}

function getDept(cp) {
  if (!cp) return '';
  cp = cp.toString().padStart(5,'0');
  // DOM-TOM: 971, 972, 973, 974, 976
  if (cp.startsWith('97')) return cp.substring(0,3);
  return cp.substring(0,2);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase().replace(/[^a-z0-9\s\u00e0-\u00ff]/g,'').trim();
  b = b.toLowerCase().replace(/[^a-z0-9\s\u00e0-\u00ff]/g,'').trim();
  if (a === b) return 100;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 100;
  if (longer.includes(shorter)) return Math.round((shorter.length / longer.length) * 90);
  const wa = new Set(a.split(/\s+/)), wb = new Set(b.split(/\s+/));
  let common = 0;
  for (const w of wa) { if (wb.has(w)) common++; }
  const wordScore = (common / Math.max(wa.size, wb.size)) * 100;
  const maxLen = Math.max(a.length, b.length);
  let dp = Array.from({length: a.length + 1}, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = a[i-1] === b[j-1] ? prev : 1 + Math.min(prev, dp[i], dp[i-1]);
      prev = tmp;
    }
  }
  const levScore = ((maxLen - dp[a.length]) / maxLen) * 100;
  return Math.round(Math.max(wordScore, levScore));
}

// Score amÃ©liorÃ©: pondÃ©rer les mots distinctifs plus fort
function smartSimilarity(gbName, sireneName) {
  const baseSim = similarity(gbName, sireneName);
  if (!gbName || !sireneName) return baseSim;

  const wordsGB = gbName.toLowerCase().replace(/[^a-z0-9\s\u00e0-\u00ff]/g,'').trim().split(/\s+/);
  const wordsSIR = new Set(sireneName.toLowerCase().replace(/[^a-z0-9\s\u00e0-\u00ff]/g,'').trim().split(/\s+/));

  let distinctiveMatches = 0, distinctiveTotal = 0;
  for (const w of wordsGB) {
    if (w.length < 3) continue;
    if (!GENERIC_WORDS.has(w)) {
      distinctiveTotal++;
      if (wordsSIR.has(w)) distinctiveMatches++;
      // Aussi check inclusion partielle (ex: "chicauto" dans "chicautocontroles")
      else {
        for (const sw of wordsSIR) {
          if (sw.includes(w) || w.includes(sw)) { distinctiveMatches += 0.5; break; }
        }
      }
    }
  }

  // Bonus/malus basÃ© sur les mots distinctifs
  if (distinctiveTotal > 0) {
    const distinctiveRatio = distinctiveMatches / distinctiveTotal;
    if (distinctiveRatio === 0) return Math.round(baseSim * 0.4); // Aucun mot distinctif match: forte pÃ©nalitÃ©
    if (distinctiveRatio >= 0.5) return Math.round(Math.min(100, baseSim * 1.1)); // Bonus
  }
  return baseSim;
}

function nafMatch(gbCategorie, nafCode) {
  if (!gbCategorie || !nafCode) return false;
  const cat = gbCategorie.toLowerCase().replace(/[^a-z0-9\s\u00e0-\u00ff'-]/g,'').trim();
  const nafs = CAT_NAF_MAP[cat];
  if (nafs && nafs.length > 0) return nafs.includes(nafCode);
  // Aussi chercher en contenu partiel
  for (const [key, codes] of Object.entries(CAT_NAF_MAP)) {
    if (codes.length > 0 && (cat.includes(key) || key.includes(cat))) {
      if (codes.includes(nafCode)) return true;
    }
  }
  return false;
}

function computeScore(fiche, c, gbName) {
  const allNames = [
    c.denomination, c.denomination_usuelle, c.denomination_usuelle_1,
    c.denomination_usuelle_2, c.denomination_usuelle_3,
    c.enseigne_1, c.enseigne_2, c.enseigne_3, c.sigle
  ].filter(Boolean);

  let nameSim = 0;
  for (const n of allNames) {
    nameSim = Math.max(nameSim, smartSimilarity(gbName, n));
  }

  let score = nameSim;

  // === CORRESPONDANCE GEOGRAPHIQUE ===
  const deptGB = getDept(fiche.code_postal);
  const deptSIR = getDept(c.code_postal);

  if (fiche.code_postal && c.code_postal) {
    if (fiche.code_postal === c.code_postal) {
      score += 25; // Bonus fort: mÃªme code postal
    } else if (deptGB && deptSIR && deptGB === deptSIR) {
      score += 10; // Bonus modÃ©rÃ©: mÃªme dÃ©partement
    } else {
      score = Math.round(score * 0.5); // PÃ©nalitÃ© sÃ©vÃ¨re: dÃ©partement diffÃ©rent
    }
  }

  // === CORRESPONDANCE NAF ===
  const naf = c.naf_etablissement || c.naf_entreprise || c.activite_principale || '';
  if (nafMatch(fiche.categorie_gb, naf)) {
    score += 10; // Bonus NAF
  }

  return Math.min(100, score);
}

async function searchMultiEtab(sirConn, siren, codePostal, dept) {
  // Cherche un Ã©tablissement actif du mÃªme SIREN au bon CP ou dÃ©partement
  try {
    // D'abord par CP exact
    const [rows] = await sirConn.execute(
      `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
              e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
              e.activite_principale as naf_etablissement,
              ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
              ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique, ent.activite_principale as naf_entreprise
       FROM etablissements e
       LEFT JOIN entreprises ent ON e.siren = ent.siren
       WHERE e.siren = ? AND e.etat_administratif = 'A' AND e.code_postal = ?
       LIMIT 5`, [siren, codePostal]);
    if (rows.length > 0) return rows;

    // Sinon par dÃ©partement
    if (dept) {
      const [rows2] = await sirConn.execute(
        `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                e.activite_principale as naf_etablissement,
                ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique, ent.activite_principale as naf_entreprise
         FROM etablissements e
         LEFT JOIN entreprises ent ON e.siren = ent.siren
         WHERE e.siren = ? AND e.etat_administratif = 'A' AND e.code_postal LIKE ?
         LIMIT 5`, [siren, dept + '%']);
      if (rows2.length > 0) return rows2;
    }
  } catch(e) { console.error('  Multi-etab err:', e.message); }
  return [];
}

async function main() {
  let fbConn, sirConn;
  try {
    fbConn = await mysql.createConnection(FB_DB);
    sirConn = await mysql.createConnection(SIRENE_DB);

    // Les 6 fiches Ã  relancer
    const ids = [295640, 169073, 343989, 611433, 648716, 175049];
    const [fiches] = await fbConn.query(
      'SELECT id, nom_gb, adresse_gb, ville, code_postal, telephone, categorie_gb, site_web, note, avis FROM google_business_v2 WHERE id IN (?)', [ids]
    );

    console.log('=== SIRETISATION V9 - RETRY 6 FICHES ===');
    console.log('AmÃ©liorations: geo strict, multi-etab, NAF match, mots distinctifs\n');

    const output = [];

    for (const fiche of fiches) {
      console.log('--- #' + fiche.id + ' ' + fiche.nom_gb + ' ---');
      console.log('  Adresse: ' + fiche.adresse_gb + ' | CP: ' + fiche.code_postal + ' | Cat: ' + fiche.categorie_gb);

      let bestScore = 0, bestCandidat = null, methode = '';
      const terms = fiche.nom_gb.replace(/[^\w\s\u00e0-\u00ff]/g,' ').trim();
      const deptGB = getDept(fiche.code_postal);
      const sirensDejaVus = new Set();

      // ===== PASSE 0: FULLTEXT =====
      try {
        const [cands] = await sirConn.execute(
          `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                  e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                  ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                  ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique,
                  ent.activite_principale as naf_entreprise, e.activite_principale as naf_etablissement
           FROM etablissements e
           LEFT JOIN entreprises ent ON e.siren = ent.siren
           WHERE MATCH(e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3)
                 AGAINST(? IN NATURAL LANGUAGE MODE) AND e.etat_administratif = 'A'
           LIMIT 20`, [terms]);

        for (const c of cands) {
          const score = computeScore(fiche, c, fiche.nom_gb);
          sirensDejaVus.add(c.siren);
          console.log('  P0 candidat: ' + (c.enseigne_1||c.denomination||c.denomination_usuelle_1||'?') + ' [' + c.code_postal + '] score=' + score);
          if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_0_fulltext'; }

          // === MULTI-ETABLISSEMENT: si nom match bien mais geo non ===
          if (score < 80 && smartSimilarity(fiche.nom_gb, c.enseigne_1||'') > 60 || smartSimilarity(fiche.nom_gb, c.denomination_usuelle||'') > 60) {
            const localEtabs = await searchMultiEtab(sirConn, c.siren, fiche.code_postal, deptGB);
            for (const le of localEtabs) {
              const leScore = computeScore(fiche, le, fiche.nom_gb);
              console.log('  P0-multi: ' + (le.enseigne_1||le.denomination||'?') + ' [' + le.code_postal + '] SIREN=' + le.siren + ' score=' + leScore);
              if (leScore > bestScore) { bestScore = leScore; bestCandidat = le; methode = 'passe_0_multi_etab'; }
            }
          }
        }
      } catch(e) { console.error('  P0 err:', e.message); }

      // ===== PASSE 0b: LIKE entreprises =====
      if (bestScore < 80) {
        try {
          const [cands2] = await sirConn.execute(
            `SELECT ent.siren, ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                    ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique, ent.activite_principale as naf_entreprise,
                    e.siret, e.code_postal, e.libelle_commune, e.denomination_usuelle,
                    e.enseigne_1, e.enseigne_2, e.enseigne_3, e.numero_voie, e.type_voie, e.libelle_voie,
                    e.activite_principale as naf_etablissement
             FROM entreprises ent
             LEFT JOIN etablissements e ON ent.siren = e.siren AND e.etablissement_siege = '1'
             WHERE (ent.denomination LIKE ? OR ent.denomination_usuelle_1 LIKE ?
                    OR ent.denomination_usuelle_2 LIKE ? OR ent.sigle LIKE ?)
                   AND (e.etat_administratif = 'A' OR e.etat_administratif IS NULL)
             LIMIT 20`,
            ['%'+terms+'%','%'+terms+'%','%'+terms+'%','%'+terms+'%']);
          for (const c of cands2) {
            sirensDejaVus.add(c.siren);
            const score = computeScore(fiche, c, fiche.nom_gb);
            console.log('  P0b candidat: ' + (c.denomination||c.denomination_usuelle_1||'?') + ' [' + c.code_postal + '] score=' + score);
            if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_0b_like'; }

            // Multi-etab
            if (score < 80 && getDept(c.code_postal) !== deptGB) {
              const localEtabs = await searchMultiEtab(sirConn, c.siren, fiche.code_postal, deptGB);
              for (const le of localEtabs) {
                const leScore = computeScore(fiche, le, fiche.nom_gb);
                console.log('  P0b-multi: ' + (le.enseigne_1||le.denomination||'?') + ' [' + le.code_postal + '] score=' + leScore);
                if (leScore > bestScore) { bestScore = leScore; bestCandidat = le; methode = 'passe_0b_multi_etab'; }
              }
            }
          }
        } catch(e) { console.error('  P0b err:', e.message); }
      }

      // ===== PASSE 1: API SIRENE avec CP =====
      if (bestScore < 80) {
        try {
          const params = { denomination: fiche.nom_gb };
          if (fiche.code_postal) params.code_postal = fiche.code_postal;
          const r = await apiSearch('/api/recherche', params);
          if (r && r.resultats) {
            for (const e of r.resultats) {
              const score = computeScore(fiche, e, fiche.nom_gb);
              console.log('  P1 candidat: ' + (e.denomination||e.denomination_usuelle_1||e.enseigne_1||'?') + ' [' + (e.code_postal||'') + '] score=' + score);
              if (score > bestScore) { bestScore = score; bestCandidat = e; methode = 'passe_1_api'; }
              sirensDejaVus.add(e.siren);
            }
          }
        } catch(e) { console.error('  P1 err:', e.message); }
      }

      // ===== PASSE 2: API sans CP =====
      if (bestScore < 80 && fiche.code_postal) {
        try {
          const r = await apiSearch('/api/recherche', { denomination: fiche.nom_gb });
          if (r && r.resultats) {
            for (const e of r.resultats) {
              const score = computeScore(fiche, e, fiche.nom_gb);
              console.log('  P2 candidat: ' + (e.denomination||e.denomination_usuelle_1||e.enseigne_1||'?') + ' [' + (e.code_postal||'') + '] score=' + score);
              if (score > bestScore) { bestScore = score; bestCandidat = e; methode = 'passe_2_api_nat'; }

              // Multi-etab pour les rÃ©sultats API aussi
              if (score < 80 && !sirensDejaVus.has(e.siren)) {
                const localEtabs = await searchMultiEtab(sirConn, e.siren, fiche.code_postal, deptGB);
                for (const le of localEtabs) {
                  const leScore = computeScore(fiche, le, fiche.nom_gb);
                  console.log('  P2-multi: ' + (le.enseigne_1||le.denomination||'?') + ' [' + le.code_postal + '] score=' + leScore);
                  if (leScore > bestScore) { bestScore = leScore; bestCandidat = le; methode = 'passe_2_multi_etab'; }
                }
              }
              sirensDejaVus.add(e.siren);
            }
          }
        } catch(e) { console.error('  P2 err:', e.message); }
      }

      // ===== PASSE 3 (NOUVEAU): Recherche par adresse + NAF =====
      if (bestScore < 80 && fiche.code_postal) {
        console.log('  P3: Recherche par adresse + NAF...');
        try {
          // Extraire les mots de l'adresse (rue, numÃ©ro)
          const adresseWords = (fiche.adresse_gb || '').replace(/[,]/g,' ').split(/\s+/).filter(w => w.length > 2);
          // Chercher les Ã©tablissements au mÃªme CP
          const nafCodes = CAT_NAF_MAP[(fiche.categorie_gb||'').toLowerCase()] || [];

          let nafFilter = '';
          let params = [fiche.code_postal];
          if (nafCodes.length > 0) {
            nafFilter = ' AND e.activite_principale IN (' + nafCodes.map(()=>'?').join(',') + ')';
            params.push(...nafCodes);
          }

          const [localCands] = await sirConn.execute(
            `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                    e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                    e.activite_principale as naf_etablissement,
                    ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                    ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique, ent.activite_principale as naf_entreprise
             FROM etablissements e
             LEFT JOIN entreprises ent ON e.siren = ent.siren
             WHERE e.code_postal = ?${nafFilter} AND e.etat_administratif = 'A'
             LIMIT 50`, params);

          for (const c of localCands) {
            // Score combinÃ©: nom + adresse
            let score = computeScore(fiche, c, fiche.nom_gb);

            // Bonus adresse: vÃ©rifier si la voie correspond
            const adresseSirene = [c.numero_voie, c.type_voie, c.libelle_voie].filter(Boolean).join(' ').toLowerCase();
            if (adresseSirene) {
              const adresseGB = (fiche.adresse_gb||'').toLowerCase();
              const addrSim = similarity(adresseGB, adresseSirene);
              if (addrSim > 40) {
                score = Math.min(100, score + 15);
                console.log('  P3 addr match: ' + adresseSirene + ' sim=' + addrSim);
              }
            }

            if (score > bestScore) {
              console.log('  P3 candidat: ' + (c.enseigne_1||c.denomination||c.denomination_usuelle_1||c.denomination_usuelle||'?') + ' SIREN=' + c.siren + ' [' + c.code_postal + '] score=' + score);
              bestScore = score; bestCandidat = c; methode = 'passe_3_geo_naf';
            }
          }
        } catch(e) { console.error('  P3 err:', e.message); }
      }

      const statut = bestScore >= 80 ? 'MATCHEE' : bestScore >= 50 ? 'INCERTAINE' : 'ECHOUEE';
      const bc = bestCandidat || {};
      const adresseSirene = [bc.numero_voie, bc.type_voie, bc.libelle_voie].filter(Boolean).join(' ') || '';

      console.log('  => ' + statut + ' (score ' + bestScore + ') via ' + methode);
      console.log('     SIREN: ' + (bc.siren||'') + ' | Denom: ' + (bc.denomination||bc.denomination_usuelle_1||bc.enseigne_1||''));
      console.log('');

      output.push({
        gb_id: fiche.id,
        gb_nom: fiche.nom_gb || '',
        gb_adresse: fiche.adresse_gb || '',
        gb_ville: fiche.ville || '',
        gb_code_postal: fiche.code_postal || '',
        gb_telephone: fiche.telephone || '',
        gb_categorie: fiche.categorie_gb || '',
        gb_site_web: fiche.site_web || '',
        gb_note: fiche.note || '',
        gb_avis: fiche.avis || '',
        sir_siren: bc.siren || '',
        sir_siret: bc.siret || '',
        sir_denomination: bc.denomination || '',
        sir_denomination_usuelle_1: bc.denomination_usuelle_1 || '',
        sir_denomination_usuelle: bc.denomination_usuelle || '',
        sir_enseigne_1: bc.enseigne_1 || '',
        sir_enseigne_2: bc.enseigne_2 || '',
        sir_enseigne_3: bc.enseigne_3 || '',
        sir_sigle: bc.sigle || '',
        sir_adresse: adresseSirene,
        sir_code_postal: bc.code_postal || '',
        sir_commune: bc.libelle_commune || bc.commune || '',
        sir_naf: bc.naf_etablissement || bc.naf_entreprise || bc.activite_principale || '',
        sir_categorie_juridique: bc.categorie_juridique || '',
        score: bestScore,
        statut: statut,
        methode: methode || 'aucune'
      });
    }

    fs.writeFileSync('/tmp/siretisation_v9.json', JSON.stringify(output, null, 2));
    console.log('\n=== JSON exported to /tmp/siretisation_v9.json ===');
    // Also copy to home
    fs.copyFileSync('/tmp/siretisation_v9.json', path.join(process.env.HOME, 'siretisation_v9.json'));
  } catch(e) {
    console.error('ERREUR:', e.message);
  } finally {
    if (fbConn) await fbConn.end();
    if (sirConn) await sirConn.end();
  }
}
main();
