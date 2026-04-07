const { poolSiretisation } = require('../config/database');
const XLSX = require('xlsx');
const path = require('path');

// GET /api/v1/taches/:id
exports.getStatut = async (req, res) => {
  try {
    const [rows] = await poolSiretisation.query('SELECT * FROM taches WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Tâche non trouvée' });
    const t = rows[0];
    res.json({
      id: t.id, type: t.type, statut: t.statut,
      progression: { total: t.total_fiches, traitees: t.fiches_traitees, matchees: t.fiches_matchees, incertaines: t.fiches_incertaines, echouees: t.fiches_echouees },
      dates: { creation: t.date_creation, debut: t.date_debut, fin: t.date_fin },
      duree_totale_ms: t.duree_totale_ms,
      message_erreur: t.message_erreur
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// GET /api/v1/taches/:id/resultats
exports.getResultats = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;
    const [rows] = await poolSiretisation.query(
      'SELECT * FROM resultats WHERE tache_id = ? ORDER BY id LIMIT ? OFFSET ?',
      [req.params.id, limit, offset]
    );
    const [[{ total }]] = await poolSiretisation.query(
      'SELECT COUNT(*) as total FROM resultats WHERE tache_id = ?', [req.params.id]
    );
    res.json({ tache_id: parseInt(req.params.id), page, limit, total, resultats: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// GET /api/v1/taches/:id/resultats/export
exports.exportResultats = async (req, res) => {
  try {
    const [rows] = await poolSiretisation.query(
      'SELECT * FROM resultats WHERE tache_id = ? ORDER BY id', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Aucun résultat pour cette tâche' });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Resultats');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=siretisation_tache_${req.params.id}.xlsx`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// GET /api/v1/taches/:id/logs
exports.getLogs = async (req, res) => {
  try {
    const niveau = req.query.niveau;
    let sql = 'SELECT * FROM logs WHERE tache_id = ?';
    const params = [req.params.id];
    if (niveau) { sql += ' AND niveau = ?'; params.push(niveau); }
    sql += ' ORDER BY date_log DESC LIMIT 500';
    const [rows] = await poolSiretisation.query(sql, params);
    res.json({ tache_id: parseInt(req.params.id), logs: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
