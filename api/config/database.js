const mysql = require('mysql2/promise');

// Base siretisation (taches, resultats, logs)
const poolSiretisation = mysql.createPool({
  host: 'localhost',
  user: 'netit972_siretisation',
  password: 'A25pDBxRsJtMbS3zZxNx',
  database: 'netit972_siretisation',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

// Base SIRENE (recherche locale)
const poolSirene = mysql.createPool({
  host: 'localhost',
  user: 'netit972_netit972_sirene_usr',
  password: 'KjaQ5RjwHDAM3cA6fJyX',
  database: 'netit972_netit972_sirene_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

// Base Google Business
const poolGoogleBusiness = mysql.createPool({
  host: 'localhost',
  user: 'netit972_scraper',
  password: 'fKTAcSswL3sAWEe5zzHs',
  database: 'netit972_france_business',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  charset: 'utf8mb4'
});

module.exports = { poolSiretisation, poolSirene, poolGoogleBusiness };
