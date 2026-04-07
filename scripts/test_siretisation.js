const mysql = require('mysql2/promise');
const http = require('http');
const fs = require('fs');
const path = require('path');

function readEnv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const env = {};
  content.split(/\r?\n/).forEach(line => {
    const m = line.match(/^([^#=][^=]*)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  });
  return env;
}

const fbEnv = readEnv(path.join(process.env.HOME, 'france-business-scraper/.env'));

const SIRENE_DB = {
  host: 'localhost',
  user: 'netit972_netit972_sirene_usr',
  password: 'KjaQ5RjwHDAM3cA6fJyX',
  database: 'netit972_netit972_sirene_db'
};

const FB_DB = {
  host: fbEnv.DB_HOST || 'localhost',
  user: fbEnv.DB_USER,
  password: fbEnv.DB_PASSWORD,
  database: fbEnv.DB_NAME
};

const API_BASE = 'http://localhost:3005';
const API_KEY = 'be96b82258966d38b674de824e9675ce76321dd858808f85b9a2791bbb36ffd9';

function apiSearch(endpoint, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    http.get(API_BASE + endpoint + '?' + qs, { timeout: 15000, headers: { 'X-API-Key': API_KEY } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ error: data.substring(0,200) }); }
      });
    }).on('error', reject);
  });
}

function similarity(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  b = b.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (a === b) return 100;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 100;
  if (longer.includes(shorter)) return Math.round((shorter.length / longer.length) * 90);
  const wa = new Set(a.split(/\s+/));
  const wb = new Set(b.split(/\s+/));
  let common = 0;
  for (const w of wa) { if (wb.has(w)) common++; }
  const wordScore = (common / Math.max(wa.size, wb.size)) * 100;
  // Levenshtein distance bonus
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

async function main() {
  let fbConn, sirConn;
  try {
    fbConn = await mysql.createConnection(FB_DB);
    sirConn = await mysql.createConnection(SIRENE_DB);
    console.log('Connexion FB OK:', FB_DB.database);
    console.log('Connexion SIRENE OK:', SIRENE_DB.database);

    const [fiches] = await fbConn.query(
      'SELECT id, nom_gb, adresse_gb, ville, code_postal, telephone, categorie_gb FROM google_business_v2 ORDER BY RAND() LIMIT 10'
    );
    console.log('Fiches selectionnees:', fiches.length);

    const results = [];

    for (const fiche of fiches) {
      console.log('\n==========================================');
      console.log('FICHE #' + fiche.id + ': ' + fiche.nom_gb);
      console.log('  Adresse: ' + (fiche.adresse_gb||'') + ', ' + (fiche.ville||'') + ' ' + (fiche.code_postal||''));
      console.log('  Tel: ' + (fiche.telephone || '-') + ' | Categorie: ' + (fiche.categorie_gb || '-'));

      let bestScore = 0, bestCandidat = null, methode = '';
      const terms = fiche.nom_gb.replace(/[^\w\s]/g, ' ').trim();

      // === PASSE 0: SQL FULLTEXT sur etablissements ===
      console.log('\n  [Passe 0] FULLTEXT SQL etablissements...');
      try {
        const [cands] = await sirConn.execute(
          `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                  e.code_postal, e.libelle_commune,
                  ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                  ent.denomination_usuelle_3, ent.sigle
           FROM etablissements e
           LEFT JOIN entreprises ent ON e.siren = ent.siren
           WHERE MATCH(e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3)
                 AGAINST(? IN NATURAL LANGUAGE MODE)
                 AND e.etat_administratif = 'A'
           LIMIT 10`,
          [terms]
        );
        if (cands.length > 0) {
          for (const c of cands) {
            const ns = Math.max(
              similarity(fiche.nom_gb, c.denomination),
              similarity(fiche.nom_gb, c.denomination_usuelle),
              similarity(fiche.nom_gb, c.enseigne_1),
              similarity(fiche.nom_gb, c.enseigne_2 || ''),
              similarity(fiche.nom_gb, c.enseigne_3 || ''),
              similarity(fiche.nom_gb, c.denomination_usuelle_1 || ''),
              similarity(fiche.nom_gb, c.denomination_usuelle_2 || ''),
              similarity(fiche.nom_gb, c.denomination_usuelle_3 || ''),
              similarity(fiche.nom_gb, c.sigle || '')
            );
            const cpM = (fiche.code_postal && c.code_postal && fiche.code_postal === c.code_postal) ? 20 : 0;
            const score = Math.min(100, ns + cpM);
            const nom = c.denomination || c.enseigne_1 || c.denomination_usuelle || '?';
            console.log('    > ' + nom + ' | CP:' + (c.code_postal||'?') + ' | Score:' + score);
            if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_0_fulltext'; }
          }
        } else { console.log('    Aucun candidat'); }
      } catch(e) { console.log('    Erreur: ' + e.message.substring(0,150)); }

      // === PASSE 0b: LIKE sur entreprises.denomination ===
      if (bestScore < 80) {
        console.log('\n  [Passe 0b] LIKE sur entreprises.denomination...');
        try {
          const [cands2] = await sirConn.execute(
            `SELECT ent.siren, ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                    ent.denomination_usuelle_3, ent.sigle,
                    e.siret, e.code_postal, e.libelle_commune, e.denomination_usuelle,
                    e.enseigne_1, e.enseigne_2, e.enseigne_3
             FROM entreprises ent
             LEFT JOIN etablissements e ON ent.siren = e.siren AND e.etablissement_siege = '1'
             WHERE (ent.denomination LIKE ? OR ent.denomination_usuelle_1 LIKE ?
                    OR ent.denomination_usuelle_2 LIKE ? OR ent.sigle LIKE ?)
                   AND (e.etat_administratif = 'A' OR e.etat_administratif IS NULL)
             LIMIT 10`,
            ['%'+terms+'%', '%'+terms+'%', '%'+terms+'%', '%'+terms+'%']
          );
          if (cands2.length > 0) {
            for (const c of cands2) {
              const ns = Math.max(
                similarity(fiche.nom_gb, c.denomination),
                similarity(fiche.nom_gb, c.denomination_usuelle_1 || ''),
                similarity(fiche.nom_gb, c.denomination_usuelle_2 || ''),
                similarity(fiche.nom_gb, c.denomination_usuelle_3 || ''),
                similarity(fiche.nom_gb, c.sigle || ''),
                similarity(fiche.nom_gb, c.denomination_usuelle || ''),
                similarity(fiche.nom_gb, c.enseigne_1 || '')
              );
              const cpM = (fiche.code_postal && c.code_postal && fiche.code_postal === c.code_postal) ? 20 : 0;
              const score = Math.min(100, ns + cpM);
              const nom = c.denomination || c.denomination_usuelle_1 || '?';
              console.log('    > ' + nom + ' | CP:' + (c.code_postal||'?') + ' | Score:' + score);
              if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_0b_like'; }
            }
          } else { console.log('    Aucun candidat'); }
        } catch(e) { console.log('    Erreur 0b: ' + e.message.substring(0,150)); }
      }

      // === PASSE 1: API SIRENE /api/recherche (avec code_postal) ===
      if (bestScore < 80) {
        console.log('\n  [Passe 1] API SIRENE /api/recherche...');
        try {
          const params = { denomination: fiche.nom_gb };
          if (fiche.code_postal) params.code_postal = fiche.code_postal;
          const r = await apiSearch('/api/recherche', params);
          if (r && r.resultats && r.resultats.length > 0) {
            console.log('    ' + r.resultats.length + ' resultats API');
            for (const e of r.resultats) {
              const ns = Math.max(
                similarity(fiche.nom_gb, e.denomination || ''),
                similarity(fiche.nom_gb, e.denomination_usuelle_1 || ''),
                similarity(fiche.nom_gb, e.denomination_usuelle_2 || ''),
                similarity(fiche.nom_gb, e.denomination_usuelle_3 || ''),
                similarity(fiche.nom_gb, e.sigle || ''),
                similarity(fiche.nom_gb, e.nom_usage || ''),
                similarity(fiche.nom_gb, e.denomination_usuelle || ''),
                similarity(fiche.nom_gb, e.enseigne_1 || ''),
                similarity(fiche.nom_gb, e.enseigne_2 || ''),
                similarity(fiche.nom_gb, e.enseigne_3 || '')
              );
              const cp = e.code_postal || e.codePostalEtablissement || '';
              const cpM = (fiche.code_postal && fiche.code_postal === cp) ? 20 : 0;
              const score = Math.min(100, ns + cpM);
              const bestName = e.denomination_usuelle_1 || e.denomination || e.sigle || '';
              console.log('    > ' + bestName + ' | CP:' + (cp||'?') + ' | Score:' + score);
              if (score > bestScore) {
                bestScore = score;
                bestCandidat = { siren: e.siren, siret: (e.siret || e.siren + '00000'), denomination: e.denomination, denomination_usuelle: e.denomination_usuelle_1 };
                methode = 'passe_1_api';
              }
            }
          } else if (r && r.error) {
            console.log('    API error: ' + JSON.stringify(r.error).substring(0,100));
          } else { console.log('    Aucun resultat API'); }
        } catch(e) { console.log('    Erreur API: ' + e.message.substring(0,80)); }
      }

      // === PASSE 2: API SIRENE sans code_postal (recherche elargie) ===
      if (bestScore < 60 && fiche.code_postal) {
        console.log('\n  [Passe 2] API SIRENE sans code_postal...');
        try {
          const r = await apiSearch('/api/recherche', { denomination: fiche.nom_gb });
          if (r && r.resultats && r.resultats.length > 0) {
            console.log('    ' + r.resultats.length + ' resultats API (national)');
            for (const e of r.resultats) {
              const ns = Math.max(
                similarity(fiche.nom_gb, e.denomination || ''),
                similarity(fiche.nom_gb, e.denomination_usuelle_1 || ''),
                similarity(fiche.nom_gb, e.denomination_usuelle_2 || ''),
                similarity(fiche.nom_gb, e.denomination_usuelle_3 || ''),
                similarity(fiche.nom_gb, e.sigle || ''),
                similarity(fiche.nom_gb, e.nom_usage || '')
              );
              const score = Math.min(100, ns);
              const bestName = e.denomination_usuelle_1 || e.denomination || '';
              console.log('    > ' + bestName + ' | CP:' + (e.code_postal||'?') + ' | Score:' + score);
              if (score > bestScore) {
                bestScore = score;
                bestCandidat = { siren: e.siren, siret: (e.siret || e.siren + '00000'), denomination: e.denomination, denomination_usuelle: e.denomination_usuelle_1 };
                methode = 'passe_2_api_nat';
              }
            }
          }
        } catch(e) { console.log('    Erreur API nat: ' + e.message.substring(0,80)); }
      }

      const statut = bestScore >= 80 ? 'MATCHEE' : bestScore >= 50 ? 'INCERTAINE' : 'ECHOUEE';
      console.log('\n  -> ' + statut + ' (score=' + bestScore + ', methode=' + (methode||'aucune') + ')');
      if (bestCandidat) console.log('      SIREN:' + (bestCandidat.siren||'-') + ' SIRET:' + (bestCandidat.siret||'-'));
      results.push({ id: fiche.id, titre: fiche.nom_gb, statut, score: bestScore, methode, siren: bestCandidat ? bestCandidat.siren : null });
    }

    console.log('\n\n------------- SYNTHESE -------------');
    const m = results.filter(r => r.statut==='MATCHEE').length;
    const i = results.filter(r => r.statut==='INCERTAINE').length;
    const e = results.filter(r => r.statut==='ECHOUEE').length;
    console.log('Total: ' + results.length);
    console.log('Matchees (>=80):     ' + m + ' (' + Math.round(m/results.length*100) + '%)');
    console.log('Incertaines (50-79): ' + i + ' (' + Math.round(i/results.length*100) + '%)');
    console.log('Echouees (<50):      ' + e + ' (' + Math.round(e/results.length*100) + '%)');
    console.log('Score moyen: ' + Math.round(results.reduce((s,r) => s+r.score, 0)/results.length));
    console.log('\nDetail:');
    results.forEach(r => console.log('  [' + r.statut.padEnd(10) + '] ' + String(r.score).padStart(3) + ' | ' + (r.methode||'-').padEnd(16) + ' | ' + r.titre.substring(0,50)));
  } catch(e) {
    console.error('ERREUR:', e.message);
  } finally {
    if (fbConn) await fbConn.end();
    if (sirConn) await sirConn.end();
  }
}

main();
