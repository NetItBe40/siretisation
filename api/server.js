const express = require('express');
const cors = require('cors');
const path = require('path');
const { poolSiretisation } = require('./config/database');

const siretisationRoutes = require('./routes/siretisation');
const tachesRoutes = require('./routes/taches');
const worker = require('./services/worker');
const { authenticateApiKey } = require('./middleware/auth');
const { pagesRouter: adminPages, apiRouter: adminApi } = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Routes API
// Admin pages (HTML) - acces libre
app.use('/admin', adminPages);

// Admin API - acces libre (dashboard)
app.use('/api/v1/admin', adminApi);

app.use('/api/v1/siretisation', authenticateApiKey, siretisationRoutes);
app.use('/api/v1/taches', authenticateApiKey, tachesRoutes);

// Health check
app.get('/api/v1/health', async (req, res) => {
  try {
    const [rows] = await poolSiretisation.query('SELECT 1 AS ok');
    res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', database: 'disconnected', error: err.message });
  }
});

app.get('/api/v1/docs', (req, res) => {
  res.redirect('/admin/documentation');
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Erreur interne du serveur', message: err.message });
});

app.listen(PORT, () => {
  
  console.log(`API Siretisation démarrée sur le port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/v1/health`);
});
