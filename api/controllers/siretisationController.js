const { poolSiretisation } = require('../config/database');
const orchestrateur = require('../services/orchestrateur');
const spooler = require('../services/spooler');

// POST /api/v1/siretisation/unitaire
exports.unitaire = async (req, res) => {
  try {
    const { nom, adresse, code_postal, ville, telephone, siret_fourni, methode, seuil_firecrawl } = req.body;
    if (!nom) return res.status(400).json({ error: 'Le champ "nom" est obligatoire' });
    if (!code_postal && !ville) return res.status(400).json({ error: 'Au moins code_postal ou ville est requis' });

    // Créer tâche unitaire
    const [result] = await poolSiretisation.query(
      'INSERT INTO taches (type, statut, parametres, total_fiches, date_debut) VALUES (?, ?, ?, 1, NOW())',
      ['unitaire', 'en_cours', JSON.stringify({ methode: methode || 'auto', seuil_firecrawl: seuil_firecrawl || 80 })]
    );
    const tacheId = result.insertId;

    // Exécuter la siretisation
    const resultat = await orchestrateur.siretiser({
      tacheId,
      nom, adresse, code_postal, ville, telephone, siret_fourni,
      methode: methode || 'auto',
      seuil_firecrawl: seuil_firecrawl || 80
    });

    // Mettre à jour la tâche
    const statutSiret = resultat.statut_siretisation;
    await poolSiretisation.query(
      `UPDATE taches SET statut='terminee', fiches_traitees=1,
       fiches_matchees=?, fiches_incertaines=?, fiches_echouees=?,
       date_fin=NOW(), duree_totale_ms=? WHERE id=?`,
      [statutSiret === 'MATCHEE' ? 1 : 0, statutSiret === 'INCERTAINE' ? 1 : 0,
       statutSiret === 'ECHOUEE' ? 1 : 0, resultat.duree_ms, tacheId]
    );

    res.json({ tache_id: tacheId, resultat });
  } catch (err) {
    console.error('[unitaire]', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/v1/siretisation/batch/google-business
exports.batchGoogle = async (req, res) => {
  try {
    const { filtres, methode, seuil_firecrawl } = req.body;
    if (!filtres) return res.status(400).json({ error: 'Le champ "filtres" est obligatoire' });

    const tacheId = await spooler.creerTache({
      type: 'batch_google',
      parametres: { filtres, methode: methode || 'auto', seuil_firecrawl: seuil_firecrawl || 80 }
    });

    res.status(202).json({ tache_id: tacheId, statut: 'en_attente', message: 'Tâche créée, traitement en cours...' });
  } catch (err) {
    console.error('[batchGoogle]', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/v1/siretisation/batch/fichier
exports.batchFichier = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier uploadé' });
    const { methode, seuil_firecrawl } = req.body;

    const tacheId = await spooler.creerTache({
      type: 'batch_fichier',
      parametres: { methode: methode || 'auto', seuil_firecrawl: seuil_firecrawl || 80 },
      fichier_source: req.file.path
    });

    res.status(202).json({ tache_id: tacheId, statut: 'en_attente', fichier: req.file.originalname, message: 'Fichier reçu, traitement en cours...' });
  } catch (err) {
    console.error('[batchFichier]', err);
    res.status(500).json({ error: err.message });
  }
};
