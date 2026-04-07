const { poolSiretisation } = require('../config/database');

const authenticateApiKey = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  if (!apiKey) {
    return res.status(401).json({
      error: 'Cle API manquante',
      message: 'Fournissez votre cle API via le header X-API-Key ou le parametre api_key'
    });
  }

  try {
    const [rows] = await poolSiretisation.query(
      'SELECT id, nom, email, societe, actif, rate_limit, nb_requetes, date_expiration, permissions FROM api_keys WHERE cle_api = ? LIMIT 1',
      [apiKey]
    );

    if (rows.length === 0) {
      return res.status(403).json({ error: 'Cle API invalide' });
    }

    const key = rows[0];

    if (!key.actif) {
      return res.status(403).json({ error: 'Cle API desactivee' });
    }

    // Verifier expiration
    if (key.date_expiration && new Date(key.date_expiration) < new Date()) {
      return res.status(403).json({ error: 'Cle API expiree', date_expiration: key.date_expiration });
    }

    // Verifier rate limit (requetes totales)
    if (key.rate_limit > 0 && key.nb_requetes >= key.rate_limit) {
      return res.status(429).json({
        error: 'Limite de requetes atteinte',
        limite: key.rate_limit,
        utilise: key.nb_requetes
      });
    }

    // Update last usage
    poolSiretisation.query(
      'UPDATE api_keys SET derniere_utilisation = NOW(), nb_requetes = nb_requetes + 1 WHERE id = ?',
      [key.id]
    ).catch(() => {});

    req.apiClient = {
      id: key.id,
      nom: key.nom,
      email: key.email,
      societe: key.societe,
      permissions: key.permissions ? JSON.parse(key.permissions) : []
    };
    next();

  } catch (err) {
    console.error('Erreur auth:', err.message);
    return res.status(500).json({ error: 'Erreur interne d\'authentification' });
  }
};

module.exports = { authenticateApiKey };
