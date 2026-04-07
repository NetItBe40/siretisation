require('dotenv').config({ path: '/home/netit972/sirene-etl/.env' });
const mysql = require('mysql2/promise');
const fs = require('fs');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  // Read the siretisation results
  const results = JSON.parse(fs.readFileSync('/home/netit972/siretisation_v11.json', 'utf8'));

  // Get all SIRETs
  const sirets = results.map(r => r.sir_siret).filter(s => s);

  // Query etablissements for numero_voie, type_voie
  const [etabs] = await conn.query(
    `SELECT siret, numero_voie, type_voie, libelle_voie, activite_principale
     FROM etablissements WHERE siret IN (${sirets.map(() => '?').join(',')})`,
    sirets
  );

  // Build lookup by siret
  const etabMap = {};
  for (const e of etabs) {
    etabMap[e.siret] = e;
  }

  // NAF code labels - get from a reference or hardcode the common ones
  // Let's query the NAF codes we need
  const nafCodes = [...new Set(results.map(r => r.sir_naf).filter(n => n))];
  console.log('Unique NAF codes:', nafCodes.length);

  // Try to get NAF labels from a naf table if it exists
  let nafMap = {};
  try {
    const [nafRows] = await conn.query(
      `SELECT code, libelle FROM naf WHERE code IN (${nafCodes.map(() => '?').join(',')})`,
      nafCodes
    );
    for (const n of nafRows) {
      nafMap[n.code] = n.libelle;
    }
    console.log('NAF labels found in DB:', Object.keys(nafMap).length);
  } catch (e) {
    console.log('No naf table, trying naf_rev2...');
    try {
      const [nafRows] = await conn.query(
        `SELECT code, libelle FROM naf_rev2 WHERE code IN (${nafCodes.map(() => '?').join(',')})`,
        nafCodes
      );
      for (const n of nafRows) {
        nafMap[n.code] = n.libelle;
      }
      console.log('NAF labels from naf_rev2:', Object.keys(nafMap).length);
    } catch (e2) {
      console.log('No naf_rev2 table either. Trying SHOW TABLES...');
      const [tables] = await conn.query("SHOW TABLES LIKE '%naf%'");
      console.log('NAF-related tables:', tables);
    }
  }

  // Enrich results
  const enriched = results.map(r => {
    const etab = etabMap[r.sir_siret] || {};
    const numVoie = etab.numero_voie || '';
    const typeVoie = etab.type_voie || '';
    const libelleVoie = etab.libelle_voie || r.sir_adresse || '';
    const adresseComplete = [numVoie, typeVoie, libelleVoie].filter(x => x).join(' ');
    const nafLabel = nafMap[r.sir_naf] || '';

    return {
      ...r,
      sir_numero_voie: numVoie,
      sir_type_voie: typeVoie,
      sir_adresse_complete: adresseComplete,
      sir_naf_libelle: nafLabel
    };
  });

  // Save enriched results
  fs.writeFileSync('/tmp/siretisation_v11_enriched.json', JSON.stringify(enriched, null, 2));
  fs.copyFileSync('/tmp/siretisation_v11_enriched.json', '/home/netit972/siretisation_v11_enriched.json');

  console.log('=== Enriched JSON exported ===');
  console.log('Records:', enriched.length);
  console.log('NAF labels found:', Object.keys(nafMap).length, '/', nafCodes.length);
  console.log('Sample etab:', JSON.stringify(etab || {}));
  console.log('Sample enriched[0]:', JSON.stringify({
    adresse_complete: enriched[0].sir_adresse_complete,
    naf_libelle: enriched[0].sir_naf_libelle,
    numero_voie: enriched[0].sir_numero_voie
  }));

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
