const mysql = require('mysql2/promise');
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

// ===== TABLE DE CORRESPONDANCE CATEGORIE GB -> NAF =====
const CAT_NAF_MAP = {
  'centre de controle technique': ['71.20A','71.20B'],
  'controle technique': ['71.20A','71.20B'],
  'avocat': ['69.10Z'],
  "cabinet d'avocats": ['69.10Z'],
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
};

// ===== MOTS GENERIQUES =====
const GENERIC_WORDS = new Set([
  'controle','technique','centre','pompes','funebres','marbrerie',
  'piscine','jardin','magasin','boutique','shop','restaurant',
  'brasserie','cafe','bar','hotel','garage','auto','salon',
  'coiffure','beaute','institut','agence','cabinet','atelier',
  'espace','maison','chez','la','le','les','de','du','des','et',
  'a','au','aux','en','sur','par','pour','avec','dans','son','sa'
]);

function getDept(cp) {
  if (!cp) return '';
  cp = cp.toString().padStart(5,'0');
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
      else {
        for (const sw of wordsSIR) {
          if (sw.includes(w) || w.includes(sw)) { distinctiveMatches += 0.5; break; }
        }
      }
    }
  }
  if (distinctiveTotal > 0) {
    const distinctiveRatio = distinctiveMatches / distinctiveTotal;
    if (distinctiveRatio === 0) return Math.round(baseSim * 0.4);
    if (distinctiveRatio >= 0.5) return Math.round(Math.min(100, baseSim * 1.1));
  }
  return baseSim;
}

function nafMatch(gbCategorie, nafCode) {
  if (!gbCategorie || !nafCode) return false;
  const cat = gbCategorie.toLowerCase().replace(/[^a-z0-9\s\u00e0-\u00ff'-]/g,'').trim();
  const nafs = CAT_NAF_MAP[cat];
  if (nafs && nafs.length > 0) return nafs.includes(nafCode);
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

  // === GEO ===
  const deptGB = getDept(fiche.code_postal);
  const deptSIR = getDept(c.code_postal);
  if (fiche.code_postal && c.code_postal) {
    if (fiche.code_postal === c.code_postal) {
      score += 25;
    } else if (deptGB && deptSIR && deptGB === deptSIR) {
      score += 10;
    } else {
      score = Math.round(score * 0.5);
    }
  }

  // === NAF ===
  const naf = c.naf_etablissement || c.naf_entreprise || c.activite_principale || '';
  if (nafMatch(fiche.categorie_gb, naf)) {
    score += 10;
  }

  // === ADRESSE ===
  const adresseSirene = [c.numero_voie, c.type_voie, c.libelle_voie].filter(Boolean).join(' ').toLowerCase();
  if (adresseSirene && fiche.adresse_gb) {
    const addrSim = similarity(fiche.adresse_gb.toLowerCase(), adresseSirene);
    if (addrSim > 40) {
      score += 15;
    }
  }

  return Math.min(100, score);
}

// Extraire les mots distinctifs d'un nom GB
function extractDistinctiveWords(name) {
  if (!name) return [];
  return name.toLowerCase()
    .replace(/[^a-z0-9\s\u00e0-\u00ff]/g,' ')
    .trim().split(/\s+/)
    .filter(w => w.length >= 3 && !GENERIC_WORDS.has(w));
}

async function main() {
  let fbConn, sirConn;
  try {
    fbConn = await mysql.createConnection(FB_DB);
    sirConn = await mysql.createConnection(SIRENE_DB);

    const ids = [295640, 169073, 343989, 611433, 648716, 175049];
    const [fiches] = await fbConn.query(
      'SELECT id, nom_gb, adresse_gb, ville, code_postal, telephone, categorie_gb, site_web, note, avis FROM google_business_v2 WHERE id IN (?)', [ids]
    );

    console.log('=== SIRETISATION V10 - 100% SQL DIRECT - 6 FICHES ===');
    console.log('Passes: FT etab, FT entreprises, LIKE mots distinctifs, CP+NAF, adresse\n');

    const output = [];

    for (const fiche of fiches) {
      console.log('--- #' + fiche.id + ' ' + fiche.nom_gb + ' ---');
      console.log('  Adresse: ' + fiche.adresse_gb + ' | CP: ' + fiche.code_postal + ' | Cat: ' + fiche.categorie_gb);

      let bestScore = 0, bestCandidat = null, methode = '';
      const terms = fiche.nom_gb.replace(/[^\w\s\u00e0-\u00ff]/g,' ').trim();
      const deptGB = getDept(fiche.code_postal);
      const distinctiveWords = extractDistinctiveWords(fiche.nom_gb);
      console.log('  Mots distinctifs: ' + distinctiveWords.join(', '));

      // ===== PASSE A: FULLTEXT sur etablissements =====
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
          console.log('  PA-etab: ' + (c.enseigne_1||c.denomination||c.denomination_usuelle_1||'?') + ' [' + c.code_postal + '] score=' + score);
          if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_A_ft_etab'; }
        }
      } catch(e) { console.error('  PA err:', e.message); }

      // ===== PASSE B: FULLTEXT sur entreprises (idx_ft_search: denomination, sigle, nom, prenom_usuel) =====
      if (bestScore < 80) {
        try {
          const [cands] = await sirConn.execute(
            `SELECT ent.siren, ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                    ent.denomination_usuelle_3, ent.sigle, ent.nom_usage, ent.categorie_juridique,
                    ent.activite_principale as naf_entreprise
             FROM entreprises ent
             WHERE MATCH(ent.denomination, ent.sigle, ent.nom, ent.prenom_usuel)
                   AGAINST(? IN NATURAL LANGUAGE MODE)
             LIMIT 20`, [terms]);

          for (const ent of cands) {
            // Trouver l'etablissement actif au bon CP
            const [etabs] = await sirConn.execute(
              `SELECT e.siret, e.code_postal, e.libelle_commune, e.denomination_usuelle,
                      e.enseigne_1, e.enseigne_2, e.enseigne_3,
                      e.numero_voie, e.type_voie, e.libelle_voie,
                      e.activite_principale as naf_etablissement
               FROM etablissements e
               WHERE e.siren = ? AND e.etat_administratif = 'A'
               ORDER BY (e.code_postal = ?) DESC, e.etablissement_siege DESC
               LIMIT 5`, [ent.siren, fiche.code_postal]);

            for (const etab of etabs) {
              const c = { ...ent, ...etab };
              const score = computeScore(fiche, c, fiche.nom_gb);
              console.log('  PB-ent: ' + (ent.denomination||ent.denomination_usuelle_1||'?') + ' SIREN=' + ent.siren + ' [' + etab.code_postal + '] score=' + score);
              if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_B_ft_entreprise'; }
            }
          }
        } catch(e) { console.error('  PB err:', e.message); }
      }

      // ===== PASSE C: FULLTEXT sur entreprises (ft_ent_names: denomination_usuelle_1/2/3, nom_usage, sigle) =====
      if (bestScore < 80) {
        try {
          const [cands] = await sirConn.execute(
            `SELECT ent.siren, ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                    ent.denomination_usuelle_3, ent.sigle, ent.nom_usage, ent.categorie_juridique,
                    ent.activite_principale as naf_entreprise
             FROM entreprises ent
             WHERE MATCH(ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle)
                   AGAINST(? IN NATURAL LANGUAGE MODE)
             LIMIT 20`, [terms]);

          for (const ent of cands) {
            const [etabs] = await sirConn.execute(
              `SELECT e.siret, e.code_postal, e.libelle_commune, e.denomination_usuelle,
                      e.enseigne_1, e.enseigne_2, e.enseigne_3,
                      e.numero_voie, e.type_voie, e.libelle_voie,
                      e.activite_principale as naf_etablissement
               FROM etablissements e
               WHERE e.siren = ? AND e.etat_administratif = 'A'
               ORDER BY (e.code_postal = ?) DESC, e.etablissement_siege DESC
               LIMIT 5`, [ent.siren, fiche.code_postal]);

            for (const etab of etabs) {
              const c = { ...ent, ...etab };
              const score = computeScore(fiche, c, fiche.nom_gb);
              console.log('  PC-ent: ' + (ent.denomination_usuelle_1||ent.denomination||'?') + ' [' + etab.code_postal + '] score=' + score);
              if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_C_ft_ent_names'; }
            }
          }
        } catch(e) { console.error('  PC err:', e.message); }
      }

      // ===== PASSE D: LIKE par mots distinctifs sur entreprises =====
      if (bestScore < 80 && distinctiveWords.length > 0) {
        try {
          for (const word of distinctiveWords) {
            if (word.length < 4) continue; // Skip short words
            const likePattern = '%' + word.toUpperCase() + '%';
            const [cands] = await sirConn.execute(
              `SELECT ent.siren, ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                      ent.denomination_usuelle_3, ent.sigle, ent.nom_usage, ent.categorie_juridique,
                      ent.activite_principale as naf_entreprise
               FROM entreprises ent
               WHERE (ent.denomination LIKE ? OR ent.denomination_usuelle_1 LIKE ?
                      OR ent.denomination_usuelle_2 LIKE ? OR ent.sigle LIKE ?
                      OR ent.nom_usage LIKE ?)
               LIMIT 30`,
              [likePattern, likePattern, likePattern, likePattern, likePattern]);

            for (const ent of cands) {
              // Chercher etablissement au bon CP/dept
              const [etabs] = await sirConn.execute(
                `SELECT e.siret, e.code_postal, e.libelle_commune, e.denomination_usuelle,
                        e.enseigne_1, e.enseigne_2, e.enseigne_3,
                        e.numero_voie, e.type_voie, e.libelle_voie,
                        e.activite_principale as naf_etablissement
                 FROM etablissements e
                 WHERE e.siren = ? AND e.etat_administratif = 'A'
                 ORDER BY (e.code_postal = ?) DESC, (LEFT(e.code_postal,2) = ?) DESC, e.etablissement_siege DESC
                 LIMIT 5`, [ent.siren, fiche.code_postal, deptGB]);

              for (const etab of etabs) {
                const c = { ...ent, ...etab };
                const score = computeScore(fiche, c, fiche.nom_gb);
                if (score > bestScore) {
                  console.log('  PD-like(' + word + '): ' + (ent.denomination||'?') + ' SIREN=' + ent.siren + ' [' + etab.code_postal + '] score=' + score);
                  bestScore = score; bestCandidat = c; methode = 'passe_D_like_' + word;
                }
              }
            }
          }
        } catch(e) { console.error('  PD err:', e.message); }
      }

      // ===== PASSE E: LIKE par mots distinctifs sur etablissements (enseigne + denomination) =====
      if (bestScore < 80 && distinctiveWords.length > 0) {
        try {
          for (const word of distinctiveWords) {
            if (word.length < 4) continue;
            const likePattern = '%' + word.toUpperCase() + '%';
            const [cands] = await sirConn.execute(
              `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                      e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                      e.activite_principale as naf_etablissement,
                      ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                      ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique,
                      ent.activite_principale as naf_entreprise
               FROM etablissements e
               LEFT JOIN entreprises ent ON e.siren = ent.siren
               WHERE (e.denomination_usuelle LIKE ? OR e.enseigne_1 LIKE ? OR e.enseigne_2 LIKE ? OR e.enseigne_3 LIKE ?)
                     AND e.etat_administratif = 'A'
               ORDER BY (e.code_postal = ?) DESC, (LEFT(e.code_postal,2) = ?) DESC
               LIMIT 20`,
              [likePattern, likePattern, likePattern, likePattern, fiche.code_postal, deptGB]);

            for (const c of cands) {
              const score = computeScore(fiche, c, fiche.nom_gb);
              if (score > bestScore) {
                console.log('  PE-like-etab(' + word + '): ' + (c.enseigne_1||c.denomination||'?') + ' [' + c.code_postal + '] score=' + score);
                bestScore = score; bestCandidat = c; methode = 'passe_E_like_etab_' + word;
              }
            }
          }
        } catch(e) { console.error('  PE err:', e.message); }
      }

      // ===== PASSE F: Recherche par CP + NAF (geo+secteur) =====
      if (bestScore < 80 && fiche.code_postal) {
        try {
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
            const score = computeScore(fiche, c, fiche.nom_gb);
            if (score > bestScore) {
              console.log('  PF-geo-naf: ' + (c.enseigne_1||c.denomination||c.denomination_usuelle_1||c.denomination_usuelle||'?') + ' SIREN=' + c.siren + ' [' + c.code_postal + '] score=' + score);
              bestScore = score; bestCandidat = c; methode = 'passe_F_geo_naf';
            }
          }
        } catch(e) { console.error('  PF err:', e.message); }
      }

      // ===== PASSE G: Recherche par adresse (libelle_voie LIKE) + CP =====
      if (bestScore < 80 && fiche.adresse_gb && fiche.code_postal) {
        try {
          // Extraire des mots significatifs de l'adresse
          const addrWords = fiche.adresse_gb.replace(/[,]/g,' ').split(/\s+/)
            .filter(w => w.length > 3 && !/^\d+$/.test(w))
            .map(w => w.replace(/[^a-zA-Z\u00e0-\u00ff]/g,''))
            .filter(w => w.length > 3 && !['Rue','Avenue','Boulevard','Place','Route','Chemin','Allée','Impasse'].map(x=>x.toLowerCase()).includes(w.toLowerCase()));

          for (const word of addrWords.slice(0,3)) {
            const [cands] = await sirConn.execute(
              `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                      e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                      e.activite_principale as naf_etablissement,
                      ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                      ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique, ent.activite_principale as naf_entreprise
               FROM etablissements e
               LEFT JOIN entreprises ent ON e.siren = ent.siren
               WHERE e.code_postal = ? AND e.libelle_voie LIKE ? AND e.etat_administratif = 'A'
               LIMIT 20`, [fiche.code_postal, '%' + word.toUpperCase() + '%']);

            for (const c of cands) {
              const score = computeScore(fiche, c, fiche.nom_gb);
              if (score > bestScore) {
                console.log('  PG-addr(' + word + '): ' + (c.denomination||c.enseigne_1||'?') + ' SIREN=' + c.siren + ' voie=' + c.libelle_voie + ' score=' + score);
                bestScore = score; bestCandidat = c; methode = 'passe_G_adresse';
              }
            }
          }
        } catch(e) { console.error('  PG err:', e.message); }
      }

      const statut = bestScore >= 80 ? 'MATCHEE' : bestScore >= 50 ? 'INCERTAINE' : 'ECHOUEE';
      const bc = bestCandidat || {};
      const adresseSirene = [bc.numero_voie, bc.type_voie, bc.libelle_voie].filter(Boolean).join(' ') || '';

      console.log('  => ' + statut + ' (score ' + bestScore + ') via ' + methode);
      console.log('     SIREN: ' + (bc.siren||'') + ' | Denom: ' + (bc.denomination||bc.denomination_usuelle_1||bc.enseigne_1||''));
      console.log('');

      output.push({
        gb_id: fiche.id, gb_nom: fiche.nom_gb || '', gb_adresse: fiche.adresse_gb || '',
        gb_ville: fiche.ville || '', gb_code_postal: fiche.code_postal || '',
        gb_telephone: fiche.telephone || '', gb_categorie: fiche.categorie_gb || '',
        gb_site_web: fiche.site_web || '', gb_note: fiche.note || '', gb_avis: fiche.avis || '',
        sir_siren: bc.siren || '', sir_siret: bc.siret || '',
        sir_denomination: bc.denomination || '',
        sir_denomination_usuelle_1: bc.denomination_usuelle_1 || '',
        sir_denomination_usuelle: bc.denomination_usuelle || '',
        sir_enseigne_1: bc.enseigne_1 || '', sir_enseigne_2: bc.enseigne_2 || '',
        sir_enseigne_3: bc.enseigne_3 || '', sir_sigle: bc.sigle || '',
        sir_adresse: adresseSirene,
        sir_code_postal: bc.code_postal || '', sir_commune: bc.libelle_commune || bc.commune || '',
        sir_naf: bc.naf_etablissement || bc.naf_entreprise || bc.activite_principale || '',
        sir_categorie_juridique: bc.categorie_juridique || '',
        score: bestScore, statut: statut, methode: methode || 'aucune'
      });
    }

    fs.writeFileSync('/tmp/siretisation_v10.json', JSON.stringify(output, null, 2));
    fs.copyFileSync('/tmp/siretisation_v10.json', path.join(process.env.HOME, 'siretisation_v10.json'));
    console.log('\n=== JSON exported to /tmp/siretisation_v10.json ===');
  } catch(e) {
    console.error('ERREUR:', e.message);
  } finally {
    if (fbConn) await fbConn.end();
    if (sirConn) await sirConn.end();
  }
}
main();
