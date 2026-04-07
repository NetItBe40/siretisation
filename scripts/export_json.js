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

function similarity(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim();
  b = b.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim();
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

async function main() {
  let fbConn, sirConn;
  try {
    fbConn = await mysql.createConnection(FB_DB);
    sirConn = await mysql.createConnection(SIRENE_DB);

    const [fiches] = await fbConn.query(
      'SELECT id, nom_gb, adresse_gb, ville, code_postal, telephone, categorie_gb, site_web, note, avis FROM google_business_v2 ORDER BY RAND() LIMIT 10'
    );

    const output = [];

    for (const fiche of fiches) {
      let bestScore = 0, bestCandidat = null, methode = '';
      const terms = fiche.nom_gb.replace(/[^\w\s]/g,' ').trim();

      // Passe 0: FULLTEXT
      try {
        const [cands] = await sirConn.execute(
          `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                  e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                  ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                  ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique, ent.activite_principale as naf_entreprise,
                  e.activite_principale as naf_etablissement
           FROM etablissements e
           LEFT JOIN entreprises ent ON e.siren = ent.siren
           WHERE MATCH(e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3)
                 AGAINST(? IN NATURAL LANGUAGE MODE) AND e.etat_administratif = 'A'
           LIMIT 10`, [terms]);
        for (const c of cands) {
          const ns = Math.max(
            similarity(fiche.nom_gb, c.denomination), similarity(fiche.nom_gb, c.denomination_usuelle),
            similarity(fiche.nom_gb, c.enseigne_1), similarity(fiche.nom_gb, c.enseigne_2||''),
            similarity(fiche.nom_gb, c.enseigne_3||''), similarity(fiche.nom_gb, c.denomination_usuelle_1||''),
            similarity(fiche.nom_gb, c.denomination_usuelle_2||''), similarity(fiche.nom_gb, c.denomination_usuelle_3||''),
            similarity(fiche.nom_gb, c.sigle||'')
          );
          const cpM = (fiche.code_postal && c.code_postal && fiche.code_postal === c.code_postal) ? 20 : 0;
          const score = Math.min(100, ns + cpM);
          if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_0_fulltext'; }
        }
      } catch(e) {}

      // Passe 0b: LIKE entreprises
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
             LIMIT 10`,
            ['%'+terms+'%','%'+terms+'%','%'+terms+'%','%'+terms+'%']);
          for (const c of cands2) {
            const ns = Math.max(
              similarity(fiche.nom_gb, c.denomination), similarity(fiche.nom_gb, c.denomination_usuelle_1||''),
              similarity(fiche.nom_gb, c.denomination_usuelle_2||''), similarity(fiche.nom_gb, c.denomination_usuelle_3||''),
              similarity(fiche.nom_gb, c.sigle||''), similarity(fiche.nom_gb, c.denomination_usuelle||''),
              similarity(fiche.nom_gb, c.enseigne_1||'')
            );
            const cpM = (fiche.code_postal && c.code_postal && fiche.code_postal === c.code_postal) ? 20 : 0;
            const score = Math.min(100, ns + cpM);
            if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_0b_like'; }
          }
        } catch(e) {}
      }

      // Passe 1: API avec CP
      if (bestScore < 80) {
        try {
          const params = { denomination: fiche.nom_gb };
          if (fiche.code_postal) params.code_postal = fiche.code_postal;
          const r = await apiSearch('/api/recherche', params);
          if (r && r.resultats && r.resultats.length > 0) {
            for (const e of r.resultats) {
              const ns = Math.max(
                similarity(fiche.nom_gb, e.denomination||''), similarity(fiche.nom_gb, e.denomination_usuelle_1||''),
                similarity(fiche.nom_gb, e.denomination_usuelle_2||''), similarity(fiche.nom_gb, e.denomination_usuelle_3||''),
                similarity(fiche.nom_gb, e.sigle||''), similarity(fiche.nom_gb, e.nom_usage||''),
                similarity(fiche.nom_gb, e.denomination_usuelle||''), similarity(fiche.nom_gb, e.enseigne_1||''),
                similarity(fiche.nom_gb, e.enseigne_2||''), similarity(fiche.nom_gb, e.enseigne_3||'')
              );
              const cp = e.code_postal || e.codePostalEtablissement || '';
              const cpM = (fiche.code_postal && fiche.code_postal === cp) ? 20 : 0;
              const score = Math.min(100, ns + cpM);
              if (score > bestScore) { bestScore = score; bestCandidat = e; methode = 'passe_1_api'; }
            }
          }
        } catch(e) {}
      }

      // Passe 2: API sans CP
      if (bestScore < 60 && fiche.code_postal) {
        try {
          const r = await apiSearch('/api/recherche', { denomination: fiche.nom_gb });
          if (r && r.resultats && r.resultats.length > 0) {
            for (const e of r.resultats) {
              const ns = Math.max(
                similarity(fiche.nom_gb, e.denomination||''), similarity(fiche.nom_gb, e.denomination_usuelle_1||''),
                similarity(fiche.nom_gb, e.denomination_usuelle_2||''), similarity(fiche.nom_gb, e.denomination_usuelle_3||''),
                similarity(fiche.nom_gb, e.sigle||''), similarity(fiche.nom_gb, e.nom_usage||'')
              );
              const score = Math.min(100, ns);
              if (score > bestScore) { bestScore = score; bestCandidat = e; methode = 'passe_2_api_nat'; }
            }
          }
        } catch(e) {}
      }

      const statut = bestScore >= 80 ? 'MATCHEE' : bestScore >= 50 ? 'INCERTAINE' : 'ECHOUEE';
      const bc = bestCandidat || {};

      const adresseSirene = [bc.numero_voie, bc.type_voie, bc.libelle_voie].filter(Boolean).join(' ') || '';

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
        sir_commune: bc.libelle_commune || '',
        sir_naf: bc.naf_etablissement || bc.naf_entreprise || bc.activite_principale || '',
        sir_categorie_juridique: bc.categorie_juridique || '',
        score: bestScore,
        statut: statut,
        methode: methode || 'aucune'
      });

      console.log('#' + fiche.id + ' ' + fiche.nom_gb + ' -> ' + statut + ' (' + bestScore + ')');
    }

    fs.writeFileSync('/tmp/siretisation_export.json', JSON.stringify(output, null, 2));
    console.log('\nJSON exported to /tmp/siretisation_export.json');
  } catch(e) {
    console.error('ERREUR:', e.message);
  } finally {
    if (fbConn) await fbConn.end();
    if (sirConn) await sirConn.end();
  }
}
main();
