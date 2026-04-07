// update_phase2_counts.js - Mise a jour nb_mandats/nb_entreprises pour confiance=moyenne
// Strategie: lire par lots les identites moyenne avec nb_mandats=0,
// puis pour chaque lot, faire un GROUP BY sur dirigeants_rne_new filtre par ces noms
var mysql = require('mysql2/promise');
var DB_CONFIG = {
  host: 'localhost',
  user: 'netit972_netit972_sirene_usr',
  password: 'KjaQ5RjwHDAM3cA6fJyX',
  database: 'netit972_netit972_sirene_db',
  charset: 'utf8mb4',
  connectTimeout: 30000
};

async function main() {
  var db = await mysql.createConnection(DB_CONFIG);
  console.log('[UpdateCounts] Connecte');

  var BATCH = 1000;
  var totalUpdated = 0;
  var startTime = Date.now();
  var lastId = 0;

  // Compter total a traiter
  var [cnt] = await db.query('SELECT COUNT(*) as c FROM dirigeants_identites WHERE confiance = "moyenne" AND nb_mandats = 0');
  var total = cnt[0].c;
  console.log('[UpdateCounts] Total a traiter: ' + total);

  while (true) {
    // Lire un batch d identites moyenne sans compteurs
    var [batch] = await db.query(
      'SELECT id, nom, prenoms FROM dirigeants_identites WHERE confiance = "moyenne" AND nb_mandats = 0 AND id > ? ORDER BY id LIMIT ?',
      [lastId, BATCH]
    );
    if (batch.length === 0) break;

    // Pour chaque identite, calculer ses compteurs
    for (var i = 0; i < batch.length; i++) {
      var row = batch[i];
      var [counts] = await db.query(
        'SELECT COUNT(*) as nb_m, COUNT(DISTINCT siren) as nb_e FROM dirigeants_rne_new WHERE type_personne = "PP" AND nom = ? AND prenoms = ? AND (date_naissance IS NULL OR date_naissance = "" OR date_naissance = "0000-00-00")',
        [row.nom, row.prenoms]
      );
      var nbM = counts[0].nb_m || 0;
      var nbE = counts[0].nb_e || 0;
      if (nbM > 0) {
        await db.query('UPDATE dirigeants_identites SET nb_mandats = ?, nb_entreprises = ? WHERE id = ?', [nbM, nbE, row.id]);
      } else {
        // Marquer comme traite meme si 0 (mettre nb_mandats=1 comme minimum)
        await db.query('UPDATE dirigeants_identites SET nb_mandats = 1, nb_entreprises = 1 WHERE id = ?', [row.id]);
      }
      lastId = row.id;
    }

    totalUpdated += batch.length;
    if (totalUpdated % 5000 === 0 || totalUpdated === total) {
      var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      var pct = ((totalUpdated / total) * 100).toFixed(2);
      var speed = (totalUpdated / (elapsed / 1)).toFixed(0);
      console.log('[UpdateCounts] ' + totalUpdated + '/' + total + ' (' + pct + '%) | ' + elapsed + 's | ' + speed + '/s');
    }
  }

  console.log('[UpdateCounts] === TERMINE ===');
  console.log('[UpdateCounts] Total mis a jour: ' + totalUpdated);
  console.log('[UpdateCounts] Temps: ' + ((Date.now() - startTime) / 1000).toFixed(1) + 's');

  // Stats finales
  var [stats] = await db.query('SELECT confiance, AVG(nb_mandats) as avg_mandats, AVG(nb_entreprises) as avg_ent, MAX(nb_entreprises) as max_ent FROM dirigeants_identites GROUP BY confiance');
  console.log('[UpdateCounts] Stats:');
  stats.forEach(function(r) { console.log('  ' + r.confiance + ': avg_mandats=' + parseFloat(r.avg_mandats).toFixed(1) + ' avg_ent=' + parseFloat(r.avg_ent).toFixed(1) + ' max_ent=' + r.max_ent); });

  await db.end();
  process.exit(0);
}

main().catch(function(e) { console.error('[UpdateCounts] ERREUR:', e); process.exit(1); });