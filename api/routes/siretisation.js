const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const ctrl = require('../controllers/siretisationController');

// Config multer pour upload fichiers
const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `upload_${ts}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// POST /api/v1/siretisation/unitaire — mode synchrone
router.post('/unitaire', ctrl.unitaire);

// POST /api/v1/siretisation/batch/google-business — mode async
router.post('/batch/google-business', ctrl.batchGoogle);

// POST /api/v1/siretisation/batch/fichier — mode async avec upload
router.post('/batch/fichier', upload.single('fichier'), ctrl.batchFichier);

module.exports = router;
