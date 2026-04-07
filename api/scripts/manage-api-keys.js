#!/usr/bin/env node
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const dbConfig = {
  host: 'localhost',
  user: 'netit972_siretisation',
  password: 'A25pDBxRsJtMbS3zZxNx',
  database: 'netit972_siretisation'
};

async function createTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cle_api VARCHAR(64) NOT NULL UNIQUE,
      nom VARCHAR(100) NOT NULL,
      email VARCHAR(255),
      actif TINYINT(1) DEFAULT 1,
      nb_requetes INT DEFAULT 0,
      derniere_utilisation DATETIME,
      date_creation DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cle_api (cle_api)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

function generateApiKey() {
  return 'sk_siret_' + crypto.randomBytes(24).toString('hex');
}

async function main() {
  const action = process.argv[2];
  const conn = await mysql.createConnection(dbConfig);
  await createTable(conn);

  switch(action) {
    case 'create': {
      const nom = process.argv[3];
      const email = process.argv[4] || null;
      if (!nom) { console.error('Usage: node manage-api-keys.js create <nom> [email]'); process.exit(1); }
      const key = generateApiKey();
      await conn.query('INSERT INTO api_keys (cle_api, nom, email) VALUES (?, ?, ?)', [key, nom, email]);
      console.log('\n=== Nouvelle cle API creee ===');
      console.log('Client:', nom);
      if (email) console.log('Email:', email);
      console.log('Cle API:', key);
      console.log('\nConservez cette cle precieusement, elle ne sera plus affichee.');
      break;
    }
    case 'list': {
      const [rows] = await conn.query('SELECT id, nom, email, actif, nb_requetes, derniere_utilisation, date_creation FROM api_keys ORDER BY id');
      console.log('\n=== Cles API enregistrees ===');
      if (rows.length === 0) { console.log('Aucune cle.'); break; }
      rows.forEach(r => {
        const status = r.actif ? 'ACTIVE' : 'INACTIVE';
        console.log(`#${r.id} | ${r.nom} | ${status} | ${r.nb_requetes} req | Derniere: ${r.derniere_utilisation || 'jamais'}`);
      });
      break;
    }
    case 'revoke': {
      const id = process.argv[3];
      if (!id) { console.error('Usage: node manage-api-keys.js revoke <id>'); process.exit(1); }
      await conn.query('UPDATE api_keys SET actif = 0 WHERE id = ?', [id]);
      console.log('Cle #' + id + ' desactivee.');
      break;
    }
    case 'activate': {
      const id2 = process.argv[3];
      if (!id2) { console.error('Usage: node manage-api-keys.js activate <id>'); process.exit(1); }
      await conn.query('UPDATE api_keys SET actif = 1 WHERE id = ?', [id2]);
      console.log('Cle #' + id2 + ' reactivee.');
      break;
    }
    default:
      console.log('Usage: node manage-api-keys.js <create|list|revoke|activate> [args]');
      console.log('  create <nom> [email]  - Creer une nouvelle cle');
      console.log('  list                  - Lister toutes les cles');
      console.log('  revoke <id>           - Desactiver une cle');
      console.log('  activate <id>         - Reactiver une cle');
  }
  await conn.end();
}

main().catch(err => { console.error('Erreur:', err.message); process.exit(1); });
