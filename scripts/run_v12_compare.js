const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Load the patched module
const code = fs.readFileSync(path.join(process.env.HOME, 'sirene-etl/siretisation/retry_v11.js'), 'utf8');
const mainIdx = code.indexOf('async function main()');
eval(code.substring(0, mainIdx));

// Load previous results
const oldResults = require('/home/netit972/siretisation_v11.json');
const oldIds = oldResults.map(r => r.gb_id);
console.log('Running V12 on same', oldIds.length, 'IDs...');

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

async function run() {
  const fbConn = await mysql.createConnection(FB_DB);
  const sirConn = await mysql.createConnection(SIRENE_DB);

  const [fiches] = await fbConn.execute(
    'SELECT id, nom_gb, adresse_gb, ville, code_postal, telephone, categorie_gb, site_web, note, avis FROM google_business_v2 WHERE id IN (' + oldIds.join(',') + ')'
  );
  console.log('Fetched', fiches.length, 'fiches from DB');

  const output = [];
  for (const fiche of fiches) {
    let bestScore = 0, bestCandidat = null, methode = '';
    const terms = fiche.nom_gb.replace(/[^\w\s\u00e0-\u00ff]/g,' ').trim();
    const deptGB = getDept(fiche.code_postal);
    const distinctiveWords = extractDistinctiveWords(fiche.nom_gb);
    const expectedNafs = getExpectedNafCodes(fiche.categorie_gb);
    const addrWords = extractAddrWords(fiche.adresse_gb);

    // PASSE A: FULLTEXT etab
    try {
      const [cands] = await sirConn.execute(
        `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique,
                ent.activite_principale as naf_entreprise, e.activite_principale as naf_etablissement
         FROM etablissements e LEFT JOIN entreprises ent ON e.siren = ent.siren
         WHERE MATCH(e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3)
               AGAINST(? IN NATURAL LANGUAGE MODE) AND e.etat_administratif = 'A' LIMIT 20`, [terms]);
      for (const c of cands) {
        const score = computeScore(fiche, c, fiche.nom_gb);
        if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_A_ft_etab'; }
      }
    } catch(e) {}

    // PASSE B: FULLTEXT entreprises
    try {
      const [cands] = await sirConn.execute(
        `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique,
                ent.activite_principale as naf_entreprise, e.activite_principale as naf_etablissement
         FROM entreprises ent JOIN etablissements e ON e.siren = ent.siren AND e.etat_administratif = 'A'
         WHERE MATCH(ent.denomination) AGAINST(? IN NATURAL LANGUAGE MODE) LIMIT 20`, [terms]);
      for (const c of cands) {
        const score = computeScore(fiche, c, fiche.nom_gb);
        if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_B_ft_ent'; }
      }
    } catch(e) {}

    // PASSE C: FULLTEXT ent names
    try {
      const [cands] = await sirConn.execute(
        `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique,
                ent.activite_principale as naf_entreprise, e.activite_principale as naf_etablissement
         FROM entreprises ent JOIN etablissements e ON e.siren = ent.siren AND e.etat_administratif = 'A'
         WHERE MATCH(ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3) AGAINST(? IN NATURAL LANGUAGE MODE) LIMIT 20`, [terms]);
      for (const c of cands) {
        const score = computeScore(fiche, c, fiche.nom_gb);
        if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_C_ft_ent_names'; }
      }
    } catch(e) {}

    // PASSE D: LIKE entreprises
    if (bestScore < 80 && distinctiveWords.length > 0) {
      try {
        const likeWord = distinctiveWords[0];
        let q = `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                  e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                  ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                  ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique,
                  ent.activite_principale as naf_entreprise, e.activite_principale as naf_etablissement
           FROM entreprises ent JOIN etablissements e ON e.siren = ent.siren AND e.etat_administratif = 'A'
           WHERE ent.denomination LIKE ? `;
        const params = ['%'+likeWord+'%'];
        if (deptGB) { q += ' AND e.code_postal LIKE ?'; params.push(deptGB+'%'); }
        q += ' LIMIT 20';
        const [cands] = await sirConn.execute(q, params);
        for (const c of cands) {
          const score = computeScore(fiche, c, fiche.nom_gb);
          if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_D_like_ent'; }
        }
      } catch(e) {}
    }

    // PASSE E: LIKE etab
    if (bestScore < 80 && distinctiveWords.length > 0) {
      try {
        const likeWord = distinctiveWords[0];
        let q = `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                  e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                  ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                  ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique,
                  ent.activite_principale as naf_entreprise, e.activite_principale as naf_etablissement
           FROM etablissements e LEFT JOIN entreprises ent ON e.siren = ent.siren
           WHERE (e.enseigne_1 LIKE ? OR e.denomination_usuelle LIKE ?) AND e.etat_administratif = 'A'`;
        const params = ['%'+likeWord+'%', '%'+likeWord+'%'];
        if (deptGB) { q += ' AND e.code_postal LIKE ?'; params.push(deptGB+'%'); }
        q += ' LIMIT 20';
        const [cands] = await sirConn.execute(q, params);
        for (const c of cands) {
          const score = computeScore(fiche, c, fiche.nom_gb);
          if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_E_like_etab'; }
        }
      } catch(e) {}
    }

    // PASSE F: ADRESSE + NAF
    if (bestScore < 80 && expectedNafs.length > 0 && fiche.code_postal) {
      try {
        const nafPlaceholders = expectedNafs.map(() => '?').join(',');
        const [cands] = await sirConn.execute(
          `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                  e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                  ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                  ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique,
                  ent.activite_principale as naf_entreprise, e.activite_principale as naf_etablissement
           FROM etablissements e LEFT JOIN entreprises ent ON e.siren = ent.siren
           WHERE e.code_postal = ? AND e.activite_principale IN (${nafPlaceholders}) AND e.etat_administratif = 'A' LIMIT 50`,
          [fiche.code_postal, ...expectedNafs]);
        for (const c of cands) {
          const score = computeScore(fiche, c, fiche.nom_gb);
          if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_F_adr_naf'; }
        }
      } catch(e) {}
    }

    // PASSE G: CP + NAF
    if (bestScore < 80 && expectedNafs.length > 0 && deptGB) {
      try {
        const nafPlaceholders = expectedNafs.map(() => '?').join(',');
        const [cands] = await sirConn.execute(
          `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                  e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                  ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                  ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique,
                  ent.activite_principale as naf_entreprise, e.activite_principale as naf_etablissement
           FROM etablissements e LEFT JOIN entreprises ent ON e.siren = ent.siren
           WHERE e.code_postal LIKE ? AND e.activite_principale IN (${nafPlaceholders}) AND e.etat_administratif = 'A' LIMIT 50`,
          [deptGB+'%', ...expectedNafs]);
        for (const c of cands) {
          const score = computeScore(fiche, c, fiche.nom_gb);
          if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_G_cp_naf'; }
        }
      } catch(e) {}
    }

    // PASSE H: adresse voie
    if (bestScore < 80 && addrWords.length > 0 && fiche.code_postal) {
      try {
        const addrLike = addrWords[0];
        const [cands] = await sirConn.execute(
          `SELECT e.siret, e.siren, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3,
                  e.code_postal, e.libelle_commune, e.numero_voie, e.type_voie, e.libelle_voie,
                  ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2,
                  ent.denomination_usuelle_3, ent.sigle, ent.categorie_juridique,
                  ent.activite_principale as naf_entreprise, e.activite_principale as naf_etablissement
           FROM etablissements e LEFT JOIN entreprises ent ON e.siren = ent.siren
           WHERE e.code_postal = ? AND e.libelle_voie LIKE ? AND e.etat_administratif = 'A' LIMIT 30`,
          [fiche.code_postal, '%'+addrLike+'%']);
        for (const c of cands) {
          const score = computeScore(fiche, c, fiche.nom_gb);
          if (score > bestScore) { bestScore = score; bestCandidat = c; methode = 'passe_H_adr_voie'; }
        }
      } catch(e) {}
    }

    const statut = bestScore >= 80 ? 'MATCHEE' : (bestScore >= 50 ? 'INCERTAINE' : 'ECHOUEE');
    const naf = bestCandidat ? (bestCandidat.naf_etablissement || bestCandidat.naf_entreprise || '') : '';

    const result = {
      gb_id: fiche.id,
      gb_nom: fiche.nom_gb,
      gb_adresse: fiche.adresse_gb,
      gb_code_postal: fiche.code_postal,
      gb_categorie: fiche.categorie_gb,
      statut: statut,
      score: bestScore,
      methode: methode,
      siret: bestCandidat ? bestCandidat.siret : '',
      siren: bestCandidat ? bestCandidat.siren : '',
      denomination: bestCandidat ? (bestCandidat.denomination || bestCandidat.denomination_usuelle || bestCandidat.enseigne_1 || '') : '',
      naf: naf,
      cp_sirene: bestCandidat ? bestCandidat.code_postal : '',
    };
    output.push(result);
    process.stdout.write('.');
  }

  console.log('\nDone! Writing results...');
  fs.writeFileSync('/home/netit972/siretisation_v12.json', JSON.stringify(output, null, 2));

  // Quick comparison
  const oldMap = {};
  for (const r of oldResults) oldMap[r.gb_id] = r;
  let changes = 0, scoreUp = 0, scoreDown = 0, statusChanges = [];
  for (const r of output) {
    const old = oldMap[r.gb_id];
    if (!old) continue;
    if (r.score !== old.score || r.statut !== old.statut || r.siret !== old.siret) {
      changes++;
      if (r.score > old.score) scoreUp++;
      if (r.score < old.score) scoreDown++;
      if (r.statut !== old.statut) {
        statusChanges.push({id: r.gb_id, nom: r.gb_nom, old_statut: old.statut, new_statut: r.statut, old_score: old.score, new_score: r.score, old_siret: old.siret, new_siret: r.siret});
      }
    }
  }

  console.log('\n=== COMPARAISON V11 vs V12 ===');
  console.log('Total fiches:', output.length);
  console.log('Fiches modifiees:', changes);
  console.log('Score augmente:', scoreUp);
  console.log('Score diminue:', scoreDown);
  console.log('\nChangements de statut:');
  for (const s of statusChanges) {
    console.log('  #' + s.id + ' ' + s.nom + ': ' + s.old_statut + '(' + s.old_score + ') -> ' + s.new_statut + '(' + s.new_score + ') siret:' + s.old_siret + '->' + s.new_siret);
  }

  // Summary stats
  const v11Stats = {MATCHEE:0, INCERTAINE:0, ECHOUEE:0};
  const v12Stats = {MATCHEE:0, INCERTAINE:0, ECHOUEE:0};
  for (const r of oldResults) v11Stats[r.statut]++;
  for (const r of output) v12Stats[r.statut]++;
  console.log('\nV11:', JSON.stringify(v11Stats));
  console.log('V12:', JSON.stringify(v12Stats));

  await fbConn.end();
  await sirConn.end();
}
run().catch(e => { console.error(e); process.exit(1); });
