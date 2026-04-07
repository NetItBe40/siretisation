const { poolSiretisation } = require('../config/database');

async function log(tacheId, resultatId, niveau, action, message, details = null) {
  try {
    await poolSiretisation.query(
      'INSERT INTO logs (tache_id, resultat_id, niveau, action, message, details) VALUES (?, ?, ?, ?, ?, ?)',
      [tacheId, resultatId, niveau, action, message, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    console.error('[LOGGER ERROR]', err.message);
  }
}

module.exports = { log };
