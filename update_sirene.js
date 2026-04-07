/**
 * update_sirene.js - Mise à jour quotidienne SIRENE via API INSEE V3.11
 *
 * Récupère les enregistrements modifiés depuis la dernière mise à jour
 * pour les unités légales (entreprises) et les établissements.
 *
 * Usage: node update_sirene.js [--full-day YYYY-MM-DD]
 *   --full-day : force la date de référence (utile pour rattraper un jour manqué)
 *
 * Prérequis .env :
 *   INSEE_API_KEY=...
 */
require('dotenv').config();
const https = require('https');
const mysql = require('mysql2/promise');

// ── Config ──────────────────────────────────────────────────────────────────
const INSEE_API_KEY = process.env.INSEE_API_KEY;
const API_BASE     = 'https://api.insee.fr/api-sirene/3.11';
const PAGE_SIZE    = 1000;   // max autorisé par l'API
const DELAY_MS     = 350;    // pause entre requêtes (respect rate-limit)

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 3
};

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...args) => console.log(new Date().toISOString().slice(0,19), ...args);
const logErr = (...args) => console.error(new Date().toISOString().slice(0,19), '[ERREUR]', ...args);

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch(e) { resolve(body); }
        } else if (res.statusCode === 404) {
          // 404 = aucun résultat, pas une erreur
          resolve(null);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── 1. Authentification OAuth2 INSEE ────────────────────────────────────────
async function getToken() {
  // API V3.11 utilise une clé directe (plus de OAuth2)
  if (!INSEE_API_KEY) throw new Error('INSEE_API_KEY requise dans .env');
  log('Utilisation clé INSEE API (auth directe)');
  return INSEE_API_KEY;
}

// ── 2. Requête paginée vers l'API INSEE ────────────────────────────────────
async function fetchPage(token, endpoint, query, cursor) {
  const params = new URLSearchParams({
    q: query,
    nombre: PAGE_SIZE,
    curseur: cursor || '*'
  });
  const url = new URL(`${API_BASE}/${endpoint}?${params}`);
  const data = await httpsRequest(url, {
    hostname: url.hostname,
    path: url.pathname + url.search,
    headers: { 'X-INSEE-Api-Key-Integration': token, 'Accept': 'application/json' }
  });
  return data;
}

// ── 3. Mapping INSEE → colonnes BDD ────────────────────────────────────────
function mapUniteLegale(ul) {
  const p = (ul.periodesUniteLegale && ul.periodesUniteLegale[0]) || {};
  return {
    siren: ul.siren,
    denomination: p.denominationUniteLegale || null,
    sigle: p.sigleUniteLegale || null,
    nom: p.nomUniteLegale || null,
    prenom_usuel: p.prenomUsuelUniteLegale || null,
    categorie_juridique: p.categorieJuridiqueUniteLegale || null,
    activite_principale: p.activitePrincipaleUniteLegale || null,
    categorie_entreprise: ul.categorieEntreprise || null,
    tranche_effectif_salarie: ul.trancheEffectifsUniteLegale || null,
    date_creation: ul.dateCreationUniteLegale || null,
    etat_administratif: p.etatAdministratifUniteLegale || 'A',
    economie_sociale_solidaire: p.economieSocialeSolidaireUniteLegale || null,
    caractere_employeur: p.caractereEmployeurUniteLegale || null,
    source: 'insee_sirene_v3'
  };
}

function mapEtablissement(et) {
  const p   = (et.periodesEtablissement && et.periodesEtablissement[0]) || {};
  const adr = et.adresseEtablissement || {};
  return {
    siret: et.siret,
    siren: et.siren,
    nic: et.nic,
    etablissement_siege: et.etablissementSiege === 'true' || et.etablissementSiege === true ? 1 : 0,
    enseigne_1: p.enseigne1Etablissement || null,
    activite_principale: p.activitePrincipaleEtablissement || null,
    libelle_voie: adr.libelleVoieEtablissement || null,
    code_postal: adr.codePostalEtablissement || null,
    libelle_commune: adr.libelleCommuneEtablissement || null,
    code_commune: adr.codeCommuneEtablissement || null,
    date_creation: et.dateCreationEtablissement || null,
    etat_administratif: p.etatAdministratifEtablissement || 'A',
    source: 'insee_sirene_v3'
  };
}

// ── 4. Upsert en base ──────────────────────────────────────────────────────
async function upsertBatch(pool, table, records, pk) {
  if (!records.length) return;
  const cols = Object.keys(records[0]);
  const ph   = records.map(() => '(' + cols.map(() => '?').join(',') + ')').join(',');
  const vals = records.flatMap(r => cols.map(c => r[c]));
  const upd  = cols.filter(c => c !== pk).map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(',');
  await pool.query(
    `INSERT INTO \`${table}\` (\`${cols.join('`,`')}\`) VALUES ${ph} ON DUPLICATE KEY UPDATE ${upd}`,
    vals
  );
}

// ── 5. Récupération complète avec pagination ────────────────────────────────
async function fetchAllUpdates(token, endpoint, dateField, sinceDate) {
  const query = `${dateField}:[${sinceDate} TO *]`;
  let cursor = '*';
  let total = 0;
  let fetched = 0;
  const allRecords = [];

  log(`Requête: ${endpoint} depuis ${sinceDate}`);

  while (true) {
    const data = await fetchPage(token, endpoint, query, cursor);

    if (!data || !data.header) {
      log(`Aucun résultat pour ${endpoint}`);
      break;
    }

    if (total === 0) {
      total = data.header.total || 0;
      log(`${endpoint}: ${total} enregistrements à traiter`);
      if (total === 0) break;
    }

    // Extraire les enregistrements
    const records = data.unitesLegales || data.etablissements || [];
    allRecords.push(...records);
    fetched += records.length;

    log(`  page: +${records.length} (${fetched}/${total})`);

    // Vérifier s'il y a une page suivante
    const nextCursor = data.header.curseurSuivant;
    if (!nextCursor || nextCursor === cursor || fetched >= total) break;
    cursor = nextCursor;

    await sleep(DELAY_MS);
  }

  return allRecords;
}

// ── 6. Géocodage des nouveaux établissements ────────────────────────────────
async function geocodeBatch(pool, sirets) {
  if (!sirets.length) return 0;

  // Récupérer les adresses des établissements mis à jour
  const [rows] = await pool.query(
    `SELECT siret, CONCAT_WS(' ', libelle_voie, code_postal, libelle_commune) AS adresse
     FROM etablissements WHERE siret IN (?) AND libelle_voie IS NOT NULL AND code_postal IS NOT NULL`,
    [sirets]
  );

  if (!rows.length) return 0;

  // Préparer le CSV pour l'API BAN
  let geocoded = 0;
  const batchSize = 500;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const csvLines = ['siret,adresse', ...batch.map(r => `${r.siret},"${(r.adresse||'').replace(/"/g, '""')}"`)];
    const csvBody = csvLines.join('\n');

    try {
      const boundary = '----FormBoundary' + Date.now();
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="data"; filename="batch.csv"',
        'Content-Type: text/csv',
        '',
        csvBody,
        `--${boundary}`,
        'Content-Disposition: form-data; name="columns"',
        '',
        'adresse',
        `--${boundary}`,
        'Content-Disposition: form-data; name="result_columns"',
        '',
        'siret',
        `--${boundary}--`
      ].join('\r\n');

      const url = new URL('https://api-adresse.data.gouv.fr/search/csv/');
      const result = await new Promise((resolve, reject) => {
        const req = https.request(url, {
          method: 'POST',
          hostname: url.hostname,
          path: url.pathname,
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(body)
          }
        }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      // Parser le CSV de résultat
      const lines = result.split('\n').filter(l => l.trim());
      if (lines.length < 2) continue;
      const header = lines[0].split(',');
      const siretIdx = header.indexOf('siret');
      const latIdx = header.indexOf('latitude');
      const lonIdx = header.indexOf('longitude');
      const adrIdx = header.indexOf('result_label');
      const scoreIdx = header.indexOf('result_score');

      for (let j = 1; j < lines.length; j++) {
        const cols = lines[j].split(',');
        const lat = parseFloat(cols[latIdx]);
        const lon = parseFloat(cols[lonIdx]);
        const score = parseFloat(cols[scoreIdx]);
        if (!isNaN(lat) && !isNaN(lon) && score > 0.4) {
          await pool.query(
            'UPDATE etablissements SET latitude=?, longitude=?, geo_adresse=?, geo_score=? WHERE siret=?',
            [lat, lon, cols[adrIdx] || null, score, cols[siretIdx]]
          );
          geocoded++;
        }
      }
      await sleep(200);
    } catch (e) {
      logErr('Géocodage batch échoué:', e.message);
    }
  }
  return geocoded;
}

// ── 7. Programme principal ──────────────────────────────────────────────────
async function run() {
  // Valider la config
  if (!INSEE_API_KEY) {
    throw new Error('Variable INSEE_API_KEY requise dans .env');
  }

  const pool = await mysql.createPool(DB);
  await pool.query('SELECT 1');
  log('Connexion BDD OK');

  // Déterminer la date de référence
  let sinceDate;
  const argIdx = process.argv.indexOf('--full-day');
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    sinceDate = process.argv[argIdx + 1];
    log('Mode rattrapage, date forcée:', sinceDate);
  } else {
    // Chercher la dernière MAJ réussie
    const [jobs] = await pool.query(
      "SELECT started_at FROM sync_jobs WHERE type_sync='update_api' AND statut='done' ORDER BY started_at DESC LIMIT 1"
    );
    if (jobs.length) {
      sinceDate = jobs[0].started_at.toISOString().slice(0, 10);
    } else {
      // Première exécution : hier
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      sinceDate = yesterday.toISOString().slice(0, 10);
    }
    log('Date de référence:', sinceDate);
  }

  // Enregistrer le job
  const [res] = await pool.query(
    'INSERT INTO sync_jobs SET ?',
    { type_sync: 'update_api', statut: 'running', started_at: new Date() }
  );
  const jobId = res.insertId;

  let stats = { ul_fetched: 0, ul_updated: 0, etab_fetched: 0, etab_updated: 0, geocoded: 0, errors: 0 };

  try {
    // ── Obtenir le token ──
    const token = await getToken();

    // ── Mise à jour des unités légales (entreprises) ──
    log('=== UNITÉS LÉGALES ===');
    const unitesLegales = await fetchAllUpdates(token, 'siren', 'dateDernierTraitementUniteLegale', sinceDate);
    stats.ul_fetched = unitesLegales.length;

    if (unitesLegales.length) {
      const mapped = unitesLegales.map(mapUniteLegale);
      const BATCH = 500;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        try {
          await upsertBatch(pool, 'entreprises', batch, 'siren');
          stats.ul_updated += batch.length;
        } catch (e) {
          stats.errors++;
          logErr('Upsert UL batch', i, ':', e.message.substring(0, 200));
        }
      }
      log(`Unités légales: ${stats.ul_updated}/${stats.ul_fetched} insérées/mises à jour`);
    }

    // ── Mise à jour des établissements ──
    log('=== ÉTABLISSEMENTS ===');
    const etablissements = await fetchAllUpdates(token, 'siret', 'dateDernierTraitementEtablissement', sinceDate);
    stats.etab_fetched = etablissements.length;

    const updatedSirets = [];
    if (etablissements.length) {
      const mapped = etablissements.map(mapEtablissement);

      // Pre-insert missing SIRENs to avoid FK constraint errors
      const etabSirens = [...new Set(mapped.map(e => e.siren))];
      const [existingRows] = await pool.query(
        'SELECT siren FROM entreprises WHERE siren IN (?)', [etabSirens]
      );
      const existingSet = new Set(existingRows.map(r => r.siren));
      const missingSirens = etabSirens.filter(s => !existingSet.has(s));
      if (missingSirens.length) {
        log(`Pre-insertion de ${missingSirens.length} SIRENs manquants dans entreprises...`);
        for (const siren of missingSirens) {
          try {
            await pool.query(
              'INSERT IGNORE INTO entreprises (siren, source) VALUES (?, ?)',
              [siren, 'insee_sirene_v3_stub']
            );
          } catch (e) {
            logErr('Pre-insert SIREN', siren, ':', e.message.substring(0, 100));
          }
        }
      }

      const BATCH = 500;
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        try {
          await upsertBatch(pool, 'etablissements', batch, 'siret');
          stats.etab_updated += batch.length;
          updatedSirets.push(...batch.map(b => b.siret));
        } catch (e) {
          // Fallback: insert row by row to save what we can
          logErr('Upsert Etab batch', i, 'failed, trying row-by-row:', e.message.substring(0, 100));
          for (const row of batch) {
            try {
              await upsertBatch(pool, 'etablissements', [row], 'siret');
              stats.etab_updated++;
              updatedSirets.push(row.siret);
            } catch (e2) {
              stats.errors++;
              logErr('Upsert Etab row', row.siret, ':', e2.message.substring(0, 100));
            }
          }
        }
      }
      log(`Établissements: ${stats.etab_updated}/${stats.etab_fetched} insérés/mis à jour`);
    }

    // ── Géocodage des établissements modifiés ──
    if (updatedSirets.length) {
      log('=== GÉOCODAGE ===');
      stats.geocoded = await geocodeBatch(pool, updatedSirets);
      log(`Géocodés: ${stats.geocoded}/${updatedSirets.length}`);
    }

  } catch (e) {
    stats.errors++;
    logErr('Erreur principale:', e.message);
  }

  // ── Finaliser le job ──
  const statut = stats.errors > 0 && stats.ul_updated === 0 && stats.etab_updated === 0 ? 'error' : 'done';
  await pool.query(
    'UPDATE sync_jobs SET statut=?, nb_traites=?, nb_erreurs=?, log_erreurs=?, finished_at=NOW() WHERE id=?',
    [statut, stats.ul_updated + stats.etab_updated, stats.errors, JSON.stringify(stats), jobId]
  );

  log('=== RÉSUMÉ ===');
  log(`  Unités légales : ${stats.ul_updated} mises à jour`);
  log(`  Établissements : ${stats.etab_updated} mis à jour`);
  log(`  Géocodés       : ${stats.geocoded}`);
  log(`  Erreurs        : ${stats.errors}`);
  log(`  Statut         : ${statut}`);

  await pool.end();
  process.exit(stats.errors > 0 ? 1 : 0);
}

run().catch(e => { logErr('FATAL:', e.message); process.exit(1); });
