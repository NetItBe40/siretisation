require('dotenv').config();
const express = require('express');
const { registerDocumentRoutes } = require('./routes_documents');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const { getToken, getAttachments, downloadDocument, getCompanyRNE } = require('./inpi');

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
});

const API_KEY = process.env.API_KEY;
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Cle API invalide' });
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

// ============================================================
// ENDPOINTS SIRENE
// ============================================================

app.get('/entreprise/:siren', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM entreprises WHERE siren = ?', [req.params.siren]);
    if (!rows.length) return res.status(404).json({ error: 'SIREN non trouve' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/siret/:siret', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT e.*, u.denomination, u.categorie_juridique, u.activite_principale as activite_ul FROM etablissements e LEFT JOIN entreprises u ON e.siren = u.siren WHERE e.siret = ?', [req.params.siret]);
    if (!rows.length) return res.status(404).json({ error: 'SIRET non trouve' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/recherche', auth, async (req, res) => {
  try {
    const { q, commune, cp, naf, cj, type, limit = 25, offset = 0 } = req.query;
    if (!q && !commune && !cp && !naf) return res.status(400).json({ error: 'Au moins un critere requis' });
    let where = [];
    let params = [];
    if (q) { where.push('(e.denomination LIKE ? OR e.denomination_usuelle LIKE ? OR e.enseigne_1 LIKE ? OR e.enseigne_2 LIKE ? OR e.siret LIKE ?)'); const like = '%' + q + '%'; params.push(like, like, like, like, like); }
    if (commune) { where.push('e.libelle_commune LIKE ?'); params.push('%' + commune + '%'); }
    if (cp) { where.push('e.code_postal = ?'); params.push(cp); }
    if (naf) { where.push('e.activite_principale = ?'); params.push(naf); }
    const sql = 'SELECT e.siret, e.siren, e.nic, e.denomination, e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3, e.libelle_commune, e.code_postal, u.denomination as denomination_ul, u.siren as siren_ul FROM etablissements e LEFT JOIN entreprises u ON e.siren = u.siren WHERE ' + where.join(' AND ') + ' LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));
    const [rows] = await pool.query(sql, params);
    res.json({ total: rows.length, results: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/stats', auth, async (req, res) => {
  try {
    const [[ul]] = await pool.query('SELECT COUNT(*) as count FROM entreprises');
    const [[etab]] = await pool.query('SELECT COUNT(*) as count FROM etablissements');
    let dirigeants = { total: 0, entreprises_couvertes: 0 };
    try { const [[d]] = await pool.query('SELECT COUNT(*) as total, COUNT(DISTINCT siren) as entreprises_couvertes FROM dirigeants'); dirigeants = d; } catch (ignore) {}
    res.json({ unites_legales: ul.count, etablissements: etab.count, dirigeants: dirigeants.total, dirigeants_entreprises: dirigeants.entreprises_couvertes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ENDPOINTS INPI — Actes
// ============================================================

const CACHE_TTL = 24 * 60 * 60 * 1000;

app.get('/entreprise/:siren/actes', auth, async (req, res) => {
  try {
    const { siren } = req.params;
    const forceRefresh = req.query.refresh === '1';
    if (!forceRefresh) {
      const [cached] = await pool.query('SELECT data, fetched_at FROM actes_cache WHERE siren = ? AND fetched_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)', [siren]);
      if (cached.length) {
        const data = typeof cached[0].data === 'string' ? JSON.parse(cached[0].data) : cached[0].data;
        return res.json({ ...data, cached: true, cached_at: cached[0].fetched_at });
      }
    }
    const data = await getAttachments(siren);
    await pool.query('INSERT INTO actes_cache (siren, data, fetched_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE data = VALUES(data), fetched_at = NOW()', [siren, JSON.stringify(data)]);
    res.json({ ...data, cached: false });
  } catch (e) { console.error('Erreur actes INPI:', e.message); res.status(502).json({ error: 'Erreur API INPI', detail: e.message }); }
});

app.get('/entreprise/:siren/actes/:type/:id/download', auth, async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!['actes', 'bilans'].includes(type)) return res.status(400).json({ error: 'Type invalide' });
    const { buffer, contentType } = await downloadDocument(type, id);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline; filename="' + type + '_' + id + '.pdf"');
    res.send(buffer);
  } catch (e) { console.error('Erreur download INPI:', e.message); res.status(502).json({ error: 'Erreur telechargement INPI', detail: e.message }); }
});

// ============================================================
// ENDPOINTS DIRIGEANTS — Base locale + fallback INPI
// ============================================================

app.get('/dirigeants/recherche', auth, async (req, res) => {
  try {
    const { nom, prenom, siren, qualite, type, limit = 50, offset = 0 } = req.query;
    if (!nom && !prenom && !siren) {
      return res.status(400).json({ error: 'Au moins un critere requis: nom, prenom ou siren' });
    }
    let where = [];
    let params = [];
    if (nom) { where.push("d.nom LIKE ?"); params.push('%' + nom.toUpperCase() + '%'); }
    if (prenom) { where.push("d.prenom LIKE ?"); params.push('%' + prenom.toUpperCase() + '%'); }
    if (siren) { where.push("d.siren = ?"); params.push(siren); }
    if (qualite) { where.push("d.qualite LIKE ?"); params.push('%' + qualite + '%'); }
    if (type) { where.push("d.type_personne = ?"); params.push(type); }
    const countSql = 'SELECT COUNT(*) as total FROM dirigeants d WHERE ' + where.join(' AND ');
    const [[{ total }]] = await pool.query(countSql, params);
    const sql = `SELECT d.*, e.denomination as entreprise_denomination,
      e.activite_principale, e.categorie_juridique, e.etat_administratif
      FROM dirigeants d
      LEFT JOIN entreprises e ON d.siren COLLATE utf8mb4_unicode_ci = e.siren COLLATE utf8mb4_unicode_ci
      WHERE ${where.join(' AND ')}
      ORDER BY d.nom, d.prenom
      LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));
    const [rows] = await pool.query(sql, params);
    res.json({ total, count: rows.length, offset: Number(offset), results: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/entreprise/:siren/dirigeants', auth, async (req, res) => {
  try {
    const { siren } = req.params;
    const forceInpi = req.query.source === 'inpi';
    if (!forceInpi) {
      try {
        const [rows] = await pool.query('SELECT * FROM dirigeants WHERE siren = ? ORDER BY type_personne, qualite, nom', [siren]);
        if (rows.length > 0) {
          const [syncInfo] = await pool.query('SELECT synced_at FROM dirigeants_sync WHERE siren = ?', [siren]);
          return res.json({
            siren, source: 'local',
            synced_at: syncInfo.length ? syncInfo[0].synced_at : null,
            representants: rows.filter(r => r.type_personne !== 'BE'),
            beneficiaires: rows.filter(r => r.type_personne === 'BE'),
            totalRepresentants: rows.filter(r => r.type_personne !== 'BE').length,
            totalBeneficiaires: rows.filter(r => r.type_personne === 'BE').length
          });
        }
      } catch (dbErr) { console.log('Table dirigeants non disponible, fallback INPI:', dbErr.message); }
    }
    const data = await getCompanyRNE(siren);
    res.json({ ...data, source: 'inpi_live' });
  } catch (e) { console.error('Erreur dirigeants:', e.message); res.status(502).json({ error: 'Erreur dirigeants', detail: e.message }); }
});

app.get('/dirigeant/entreprises', auth, async (req, res) => {
  try {
    const { nom, prenom } = req.query;
    if (!nom) return res.status(400).json({ error: 'Parametre nom requis' });
    let where = ["d.nom LIKE ?"];
    let params = ['%' + nom.toUpperCase() + '%'];
    if (prenom) { where.push("d.prenom LIKE ?"); params.push('%' + prenom.toUpperCase() + '%'); }
    const sql = `SELECT d.siren, d.qualite, d.type_personne, d.date_effet,
      e.denomination, e.activite_principale, e.categorie_juridique,
      e.etat_administratif, e.date_creation, e.categorie_entreprise
      FROM dirigeants d LEFT JOIN entreprises e ON d.siren COLLATE utf8mb4_unicode_ci = e.siren COLLATE utf8mb4_unicode_ci
      WHERE ${where.join(' AND ')} ORDER BY e.denomination`;
    const [rows] = await pool.query(sql, params);
    res.json({ nom, prenom: prenom || null, total: rows.length, entreprises: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/dirigeants/stats', auth, async (req, res) => {
  try {
    const [[totals]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM dirigeants) as total_dirigeants,
        (SELECT COUNT(DISTINCT siren) FROM dirigeants) as entreprises_couvertes,
        (SELECT COUNT(*) FROM dirigeants WHERE type_personne='PP') as personnes_physiques,
        (SELECT COUNT(*) FROM dirigeants WHERE type_personne='PM') as personnes_morales,
        (SELECT COUNT(*) FROM dirigeants WHERE type_personne='BE') as beneficiaires_effectifs,
        (SELECT COUNT(*) FROM dirigeants_sync) as sirens_synchronises,
        (SELECT COUNT(*) FROM dirigeants_sync WHERE status='ok') as sync_ok,
        (SELECT COUNT(*) FROM dirigeants_sync WHERE status='error') as sync_erreurs,
        (SELECT MIN(synced_at) FROM dirigeants_sync) as premiere_sync,
        (SELECT MAX(synced_at) FROM dirigeants_sync) as derniere_sync
    `);
    res.json(totals);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/dirigeants/top', auth, async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const [rows] = await pool.query(`
      SELECT d.nom, d.prenom, d.type_personne,
        COUNT(DISTINCT d.siren) as nb_mandats,
        GROUP_CONCAT(DISTINCT d.qualite SEPARATOR ', ') as qualites
      FROM dirigeants d
      WHERE d.nom IS NOT NULL AND d.nom != ''
      GROUP BY d.nom, d.prenom, d.type_personne
      HAVING nb_mandats > 1
      ORDER BY nb_mandats DESC
      LIMIT ?
    `, [Number(limit)]);
    res.json({ total: rows.length, results: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// DEMARRAGE
// ============================================================
const PORT = process.env.PORT || 3001;
// Documents INPI v4.7
registerDocumentRoutes(app, pool);
app.listen(PORT, () => console.log('API SIRENE-ETL demarre sur le port ' + PORT));
