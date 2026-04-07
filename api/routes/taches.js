const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/tachesController');

// GET /api/v1/taches/:id — statut + progression
router.get('/:id', ctrl.getStatut);

// GET /api/v1/taches/:id/resultats — résultats d'une tâche
router.get('/:id/resultats', ctrl.getResultats);

// GET /api/v1/taches/:id/resultats/export — export XLSX
router.get('/:id/resultats/export', ctrl.exportResultats);

// GET /api/v1/taches/:id/logs — logs d'une tâche
router.get('/:id/logs', ctrl.getLogs);

module.exports = router;
