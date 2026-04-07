const { poolSiretisation, poolGoogleBusiness } = require('../config/database');
const orchestrateur = require('./orchestrateur');
const logger = require('./logger');

// --- Timeout par fiche (2 minutes max)
const FICHE_TIMEOUT_MS = 120000;
function withFicheTimeout(promise, ms, ficheName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT fiche "' + ficheName + '" apres ' + (ms/1000) + 's')), ms);
    promise.then(val => { clearTimeout(timer); resolve(val); })
           .catch(err => { clearTimeout(timer); reject(err); });
  });
}
const fs = require('fs');
const xlsx = require('xlsx');

const POLL_INTERVAL = 5000;
let isProcessing = false;
const PAGE_SIZE = 5000;

// --- Polling loop ---
function demarrer() {
  console.log('[WORKER] Worker batch demarre, polling toutes les ' + (POLL_INTERVAL/1000) + 's');
  setInterval(async () => {
    if (isProcessing) return;
    try {
      const [taches] = await poolSiretisation.query(
        'SELECT * FROM taches WHERE statut = ? ORDER BY date_creation ASC LIMIT 1',
        ['en_attente']
      );
      if (taches.length === 0) return;
      isProcessing = true;
      const tache = taches[0];
      console.log('[WORKER] Traitement tache #' + tache.id + ' type-' + tache.type);
      await traiterTache(tache);
    } catch (err) {
      console.error('[WORKER] Erreur polling:', err.message);
    } finally {
      isProcessing = false;
    }
  }, POLL_INTERVAL);
}

// --- Main task dispatcher ---
async function traiterTache(tache) {
  const parametres = typeof tache.parametres === 'string' ? JSON.parse(tache.parametres) : tache.parametres;
  try {
    // Mark as en_cours
    await poolSiretisation.query(
      'UPDATE taches SET statut = ?, date_debut = NOW() WHERE id = ?',
      ['en_cours', tache.id]
    );

    await logger.log(tache.id, null, 'INFO', 'BATCH_START', 'Debut traitement batch ' + tache.type);

    if (tache.type === 'batch_google') {
      await traiterBatchGooglePagine(tache, parametres);
    } else if (tache.type === 'batch_fichier') {
      await traiterBatchFichier(tache, parametres);
    }

  } catch (err) {
    await poolSiretisation.query(
      'UPDATE taches SET statut=?, message_erreur=?, date_fin=NOW() WHERE id=?',
      ['echouee', err.message, tache.id]
    );
    await logger.log(tache.id, null, 'ERROR', 'BATCH_FATAL', err.message);
    console.error('[WORKER] Tache #' + tache.id + ' echouee:', err.message);
  }
}

// --- Paginated Google Business batch processing ---
async function traiterBatchGooglePagine(tache, parametres) {
  const filtres = parametres.filtres || {};

  // Pre-load excluded IDs if exclude_matched_tache is set
  let excludedIds = [];
  if (filtres.exclude_matched_tache) {
    const [exRows] = await poolSiretisation.query(
      'SELECT CAST(ref_externe AS UNSIGNED) as gid FROM resultats WHERE tache_id = ? AND statut_siretisation = ?',
      [filtres.exclude_matched_tache, 'MATCHEE']
    );
    excludedIds = exRows.map(r => r.gid);
    console.log('[WORKER] Excluding ' + excludedIds.length + ' fiches already matched in tache #' + filtres.exclude_matched_tache);
  }

  // Step 1: Get total count
  let countSql = 'SELECT COUNT(*) as cnt FROM google_business_v2 WHERE 1=1';
  const countParams = [];
  if (filtres.departement) { countSql += ' AND departement = ?'; countParams.push(filtres.departement); }
  if (filtres.ville) { countSql += ' AND ville = ?'; countParams.push(filtres.ville); }
  if (filtres.code_postal) { countSql += ' AND code_postal = ?'; countParams.push(filtres.code_postal); }
  if (filtres.categorie) { countSql += ' AND categorie_gb LIKE ?'; countParams.push('%' + filtres.categorie + '%'); }
    if (excludedIds.length > 0) {
      countSql += ' AND id NOT IN (' + excludedIds.join(',') + ')';
    }

  const [countRows] = await poolGoogleBusiness.query(countSql, countParams);
  let totalFiches = countRows[0].cnt;
  if (filtres.limit) totalFiches = Math.min(totalFiches, parseInt(filtres.limit));

  // Update total
  await poolSiretisation.query('UPDATE taches SET total_fiches = ? WHERE id = ?', [totalFiches, tache.id]);
  await logger.log(tache.id, null, 'INFO', 'BATCH_LOAD', totalFiches + ' fiches a traiter (pagination par ' + PAGE_SIZE + ')');
  console.log('[WORKER] Tache #' + tache.id + ': ' + totalFiches + ' fiches, pagination par ' + PAGE_SIZE);

  let matchees = 0, incertaines = 0, echouees = 0, traitees = 0;
  let offset = 0;

  while (traitees < totalFiches) {
    // Load one page
    let pageSql = 'SELECT id, nom_gb, adresse_gb, ville, code_postal, telephone FROM google_business_v2 WHERE 1=1';
    const pageParams = [];
    if (filtres.departement) { pageSql += ' AND departement = ?'; pageParams.push(filtres.departement); }
    if (filtres.ville) { pageSql += ' AND ville = ?'; pageParams.push(filtres.ville); }
    if (filtres.code_postal) { pageSql += ' AND code_postal = ?'; pageParams.push(filtres.code_postal); }
    if (filtres.categorie) { pageSql += ' AND categorie_gb LIKE ?'; pageParams.push('%' + filtres.categorie + '%'); }
      if (excludedIds.length > 0) {
        pageSql += ' AND id NOT IN (' + excludedIds.join(',') + ')';
      }

    const remaining = totalFiches - traitees;
    const currentPageSize = Math.min(PAGE_SIZE, remaining);
    pageSql += ' LIMIT ? OFFSET ?';
    pageParams.push(currentPageSize, offset);

    const [rows] = await poolGoogleBusiness.query(pageSql, pageParams);
    if (rows.length === 0) break;

    const fiches = rows.map(r => ({
      ref_externe: 'gb_' + r.id,
      nom: r.nom_gb,
      adresse: r.adresse_gb,
      code_postal: r.code_postal,
      ville: r.ville,
      telephone: r.telephone
    }));

    // Process this page
    for (const fiche of fiches) {
      try {
        const resultat = await withFicheTimeout(orchestrateur.siretiser({
          tacheId: tache.id,
          nom: fiche.nom,
          adresse: fiche.adresse,
          code_postal: fiche.code_postal,
          ville: fiche.ville,
          telephone: fiche.telephone,
          siret_fourni: fiche.siret_fourni || null,
          methode: parametres.methode || 'auto',
          seuil_firecrawl: parametres.seuil_firecrawl || 80
        }), FICHE_TIMEOUT_MS, fiche.nom || 'inconnu');

        await sauverResultat(tache.id, fiche, resultat);

        if (resultat.statut_siretisation === 'MATCHEE') matchees++;
        else if (resultat.statut_siretisation === 'INCERTAINE') incertaines++;
        else echouees++;
      } catch (err) {
        echouees++;
        await logger.log(tache.id, null, 'ERROR', 'BATCH_ITEM_ERROR', err.message);
      }

      traitees++;
      // Update progress every 10 fiches
      if (traitees % 10 === 0 || traitees === totalFiches) {
        await poolSiretisation.query(
          'UPDATE taches SET fiches_traitees=?, fiches_matchees=?, fiches_incertaines=?, fiches_echouees=? WHERE id=?',
          [traitees, matchees, incertaines, echouees, tache.id]
        );
      }
    }

    offset += rows.length;
    console.log('[WORKER] Tache #' + tache.id + ': page traitee, ' + traitees + '/' + totalFiches + ' (' + Math.round(traitees/totalFiches*100) + '%)');
  }

  // Finalize
  await poolSiretisation.query(
    'UPDATE taches SET statut=?, fiches_traitees=?, fiches_matchees=?, fiches_incertaines=?, fiches_echouees=?, date_fin=NOW(), duree_totale_ms=TIMESTAMPDIFF(SECOND, date_debut, NOW())*1000 WHERE id=?',
    ['terminee', traitees, matchees, incertaines, echouees, tache.id]
  );
  await logger.log(tache.id, null, 'INFO', 'BATCH_END', 'Termine: ' + matchees + ' matchees, ' + incertaines + ' incertaines, ' + echouees + ' echouees sur ' + traitees);
  console.log('[WORKER] Tache #' + tache.id + ' terminee: ' + traitees + ' fiches traitees');
}

// --- File batch processing (unchanged) ---
async function traiterBatchFichier(tache, parametres) {
  const fiches = await chargerFichesFichier(tache.fichier_source);

  await poolSiretisation.query('UPDATE taches SET total_fiches = ? WHERE id = ?', [fiches.length, tache.id]);
  await logger.log(tache.id, null, 'INFO', 'BATCH_LOAD', fiches.length + ' fiches chargees');

  let matchees = 0, incertaines = 0, echouees = 0, traitees = 0;

  for (const fiche of fiches) {
    try {
      const resultat = await withFicheTimeout(orchestrateur.siretiser({
        tacheId: tache.id,
        nom: fiche.nom,
        adresse: fiche.adresse,
        code_postal: fiche.code_postal,
        ville: fiche.ville,
        telephone: fiche.telephone,
        siret_fourni: fiche.siret_fourni || null,
        methode: parametres.methode || 'auto',
        seuil_firecrawl: parametres.seuil_firecrawl || 80
      }), FICHE_TIMEOUT_MS, fiche.nom || 'inconnu');

      await sauverResultat(tache.id, fiche, resultat);

      if (resultat.statut_siretisation === 'MATCHEE') matchees++;
      else if (resultat.statut_siretisation === 'INCERTAINE') incertaines++;
      else echouees++;
    } catch (err) {
      echouees++;
      console.error("[WORKER] Erreur fiche:", fiche.nom, err.message);
      traitees++;
      await logger.log(tache.id, null, 'ERROR', 'BATCH_ITEM_ERROR', err.message);
    }

    traitees++;
    if (traitees % 10 === 0 || traitees === fiches.length) {
      await poolSiretisation.query(
        'UPDATE taches SET fiches_traitees=?, fiches_matchees=?, fiches_incertaines=?, fiches_echouees=? WHERE id=?',
        [traitees, matchees, incertaines, echouees, tache.id]
      );
    }
  }

  // Finalize
  await poolSiretisation.query(
    'UPDATE taches SET statut=?, fiches_traitees=?, fiches_matchees=?, fiches_incertaines=?, fiches_echouees=?, date_fin=NOW(), duree_totale_ms=TIMESTAMPDIFF(SECOND, date_debut, NOW())*1000 WHERE id=?',
    ['terminee', traitees, matchees, incertaines, echouees, tache.id]
  );
  await logger.log(tache.id, null, 'INFO', 'BATCH_END', 'Termine: ' + matchees + ' matchees, ' + incertaines + ' incertaines, ' + echouees + ' echouees sur ' + traitees);
  console.log('[WORKER] Tache #' + tache.id + ' terminee: ' + traitees + ' fiches traitees');
}

// --- Save result ---
async function sauverResultat(tacheId, fiche, resultat) {
  await poolSiretisation.query(
    `INSERT INTO resultats (tache_id, ref_externe, nom, adresse, code_postal, ville,
     statut_siretisation, score, methode_utilisee,
     siren, siret, sir_denomination, sir_adresse, sir_code_postal, sir_ville,
     sir_activite, sir_categorie_juridique, sir_tranche_effectif, sir_etat_administratif,
     firecrawl_source, duree_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [tacheId, fiche.ref_externe, fiche.nom, fiche.adresse, fiche.code_postal, fiche.ville,
     resultat.statut_siretisation, resultat.score, resultat.methode_utilisee,
     resultat.siren, resultat.siret, resultat.sir_denomination, resultat.sir_adresse,
     resultat.sir_code_postal, resultat.sir_ville, resultat.sir_activite,
     resultat.sir_categorie_juridique, resultat.sir_tranche_effectif, resultat.sir_etat_administratif,
     resultat.firecrawl_source, resultat.duree_ms]
  );
}

// --- Load fiches from file ---
async function chargerFichesFichier(fichierSource) {
  const filePath = fichierSource;
  if (!fs.existsSync(filePath)) throw new Error('Fichier non trouve: ' + filePath);

  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(sheet);

  return data.map((row, i) => ({
    ref_externe: 'file_' + (i + 1),
    nom: row.nom || row.name || row.denomination || '',
    adresse: row.adresse || row.address || '',
    code_postal: String(row.code_postal || row.cp || row.zip || ''),
    ville: row.ville || row.city || '',
    telephone: row.telephone || row.tel || row.phone || '',
    siret_fourni: row.siret || row.siret_fourni || null
  }));
}

module.exports = { demarrer };
