const { poolSiretisation } = require('../config/database');

/**
 * Crée une tâche async dans le spooler
 * TODO: Worker à implémenter à l'étape 7
 */
async function creerTache({ type, parametres, fichier_source = null }) {
  const [result] = await poolSiretisation.query(
    'INSERT INTO taches (type, statut, parametres, fichier_source) VALUES (?, ?, ?, ?)',
    [type, 'en_attente', JSON.stringify(parametres), fichier_source]
  );
  console.log(`[SPOOLER] Tâche #${result.insertId} créée (${type})`);
  return result.insertId;
}

module.exports = { creerTache };
