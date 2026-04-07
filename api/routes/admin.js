const express = require('express');
const session = require('express-session');
const path = require('path');
const { poolSiretisation } = require('../config/database');
// Auth inline (authAdmin module was removed)
const crypto = require('crypto');
const authAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  res.status(401).json({ error: 'Non authentifie' });
};
const login = (req, res) => {
  const { user, password } = req.body;
  if (user === 'admin' && password === 'Siret2024!') {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Identifiants incorrects' });
  }
};
const logout = (req, res) => {
  req.session.destroy();
  res.json({ success: true });
};
const sireneLocale = require('../services/sireneLocale');
const firecrawl = require('../services/firecrawl');

/* ---- Fonction de calcul detaille du score (pour le detail modal) ---- */
function computeScoreDetails(nomOriginal, denomination, codePostal, cpSirene) {
  const norm = sireneLocale.normaliser;
  const sim = sireneLocale.similarite;

  const nomNorm = norm(nomOriginal || '');
  const denomNorm = norm(denomination || '');

  // 1) Score global similarite (max des 3 methodes)
  const scoreGlobal = sim(nomNorm, denomNorm);

  // 2) Dice coefficient sur bigrammes
  function diceBigrams(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    const bgA = [], bgB = [];
    for (let i = 0; i < a.length - 1; i++) bgA.push(a.substring(i, i + 2));
    for (let i = 0; i < b.length - 1; i++) bgB.push(b.substring(i, i + 2));
    const setB = new Set(bgB);
    const inter = bgA.filter(x => setB.has(x)).length;
    return bgA.length + bgB.length > 0 ? Math.round((2 * inter / (bgA.length + bgB.length)) * 100) : 0;
  }

  // 3) Nettoyage nom metier (retirer mots generiques)
  const STOP_WORDS_METIER = new Set([
    'RESTAURANT','BRASSERIE','CAFE','BAR','HOTEL','BOUTIQUE','MAGASIN',
    'BOULANGERIE','PATISSERIE','PHARMACIE','GARAGE','AUTO','COIFFURE',
    'SALON','INSTITUT','CABINET','AGENCE','BUREAU','CENTRE','ESPACE',
    'MAISON','ATELIER','STUDIO','CLUB','ASSOCIATION','SOCIETE','SAS',
    'SARL','EURL','SCI','SNC','SA','LE','LA','LES','DES','DU',
    'DE','ET','AU','AUX','EN','UN','UNE','CHEZ','AUX'
  ]);
  function nettoyerNom(s) {
    return s.split(/\s+/).filter(m => m.length >= 2 && !STOP_WORDS_METIER.has(m)).join(' ');
  }

  const nomNettoye = nettoyerNom(nomNorm);
  const denomNettoye = nettoyerNom(denomNorm);

  const scoreDice = diceBigrams(nomNorm, denomNorm);
  const scoreDiceNettoye = diceBigrams(nomNettoye, denomNettoye);

  // 4) Score de containment
  let scoreCont = 0;
  if (nomNorm.length > 0 && denomNorm.includes(nomNorm)) {
    scoreCont = 100;
  } else if (denomNorm.length > 0 && nomNorm.includes(denomNorm)) {
    scoreCont = Math.round((denomNorm.length / nomNorm.length) * 100);
  }

  // 5) Score mot-par-mot
  const STOP_WORDS_MPM = new Set(['SAS','SARL','SCI','SA','EURL','SNC','ETS','AND','THE','LES','DES','POUR','AVEC','PAR','SOCIETE','GROUPE','FRANCE','ENTREPRISE','SERVICES','INTERNATIONAL']);
  const motsInput = nomNorm.split(/\s+/).filter(m => m.length >= 3 && !STOP_WORDS_MPM.has(m));
  let wordBestScore = 0;
  let bestWordDenom = '';
  let motsMatchDetails = [];

  if (motsInput.length >= 1 && denomNorm) {
    const dNormMots = denomNorm.split(/\s+/).filter(m => m.length >= 2);
    let nbMotsTrouves = 0;
    let bestWordDice = 0;
    const motDetails = [];

    for (const mot of motsInput) {
      let found = denomNorm.includes(mot);
      let bestMotScore = 0;
      let bestMotMatch = '';
      for (const dm of dNormMots) {
        const s = sim(mot, dm);
        if (s > bestMotScore) { bestMotScore = s; bestMotMatch = dm; }
      }
      if (found) nbMotsTrouves++;
      motDetails.push({ mot, trouve: found, meilleur_match: bestMotMatch, score_match: bestMotScore });
      if (bestMotScore > bestWordDice) bestWordDice = bestMotScore;
    }

    if (bestWordDice > 0 && motsInput.length > 1) {
      const wd = Math.round(bestWordDice * (Math.max(nbMotsTrouves, 1) / motsInput.length));
      wordBestScore = wd;
    } else if (bestWordDice > wordBestScore) {
      wordBestScore = bestWordDice;
    }
    motsMatchDetails = motDetails;
  }

  // Determiner quel score a gagne
  const scores = [
    { type: 'Dice bigrammes', valeur: scoreDice },
    { type: 'Dice nettoye', valeur: scoreDiceNettoye },
    { type: 'Containment', valeur: scoreCont },
    { type: 'Mot-par-mot', valeur: wordBestScore }
  ];
  const bestType = scores.reduce((a, b) => a.valeur >= b.valeur ? a : b);
  const scoreFinal = Math.max(scoreGlobal, wordBestScore);

  return {
    entree: {
      nom_original: nomOriginal,
      nom_normalise: nomNorm,
      nom_nettoye: nomNettoye,
      code_postal: codePostal
    },
    candidat: {
      denomination: denomination,
      denomination_normalisee: denomNorm,
      denomination_nettoyee: denomNettoye,
      cp_sirene: cpSirene,
      cp_match: (codePostal || '') === (cpSirene || '')
    },
    scores: {
      score_final: scoreFinal,
      score_dice_bigrams: scoreDice,
      score_dice_nettoye: scoreDiceNettoye,
      score_containment: scoreCont,
      score_mot_par_mot: wordBestScore,
      meilleur_methode: bestType.type,
      detail_scores: scores
    },
    analyse_mots: {
      mots_input: motsInput,
      details: motsMatchDetails
    }
  };
}

/* ---- Rate limiting simple ---- */
const loginAttempts = {};
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = [];
  loginAttempts[ip] = loginAttempts[ip].filter(t => now - t < 900000);
  if (loginAttempts[ip].length >= 5) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
  }
  loginAttempts[ip].push(now);
  next();
}

/* ---- Session config ---- */
const sessCfg = session({
  secret: 'siretisation_admin_2024_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 3600000 }
});

/* ========== PAGES ROUTER ========== */
const pagesRouter = express.Router();
pagesRouter.use(sessCfg);
const adminDir = path.join(__dirname, '../../admin');
pagesRouter.use(express.static(adminDir));

pagesRouter.get('/', (req, res) => {
  res.redirect('/admin/taches');
});

pagesRouter.get('/taches', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'admin', 'taches.html'));
});

pagesRouter.get('/documentation', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'admin', 'documentation.html'));
});

pagesRouter.get('/qualite', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'admin', 'qualite.html'));
});

pagesRouter.get('/api-keys', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'admin', 'api-keys.html'));
});

/* ========== API ROUTER ========== */
const apiRouter = express.Router();
apiRouter.use(sessCfg);
apiRouter.use(express.json());

// Auth routes (no auth required)
apiRouter.post('/login', rateLimit, login);
apiRouter.post('/logout', logout);

// All routes below require auth
apiRouter.use(authAdmin);

/* ---- Stats globales ---- */
apiRouter.get('/stats', async (req, res) => {
  try {
    const [[s]] = await poolSiretisation.query(
      `SELECT
        (SELECT COUNT(*) FROM taches) as nb_taches,
        (SELECT COUNT(*) FROM taches WHERE statut='en_cours') as en_cours,
        (SELECT COUNT(*) FROM resultats) as nb_resultats,
        (SELECT COUNT(*) FROM resultats WHERE statut_siretisation='MATCHEE') as matched,
        (SELECT COUNT(*) FROM resultats WHERE statut_siretisation='ECHOUEE') as erreurs,
        (SELECT COUNT(*) FROM resultats WHERE statut_siretisation='INCERTAINE') as incertaines`
    );
    res.json(s);
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ---- Liste taches ---- */
apiRouter.get('/taches', async (req, res) => {
  try {
    const [rows] = await poolSiretisation.query(
      'SELECT * FROM taches ORDER BY id DESC'
    );
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ---- Detail tache ---- */
apiRouter.get('/taches/:id', async (req, res) => {
  try {
    const [[t]] = await poolSiretisation.query('SELECT * FROM taches WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({error:'Not found'});
    const [[stats]] = await poolSiretisation.query(
      `SELECT COUNT(*) as total,
        SUM(statut_siretisation='MATCHEE') as matched,
        SUM(statut_siretisation='ECHOUEE') as erreurs,
        SUM(statut_siretisation='INCERTAINE') as incertaines,
        AVG(score) as score_moyen
      FROM resultats WHERE tache_id=?`, [req.params.id]
    );
    res.json({ ...t, ...stats });
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ---- Progression tache (polling) ---- */
apiRouter.get('/taches/:id/progression', async (req, res) => {
  try {
    const [[t]] = await poolSiretisation.query(
      'SELECT statut, total_fiches, fiches_traitees FROM taches WHERE id=?', [req.params.id]
    );
    if (!t) return res.status(404).json({error:'Not found'});
    const [[counts]] = await poolSiretisation.query(
      `SELECT COUNT(*) as traite,
        SUM(statut_siretisation='MATCHEE') as matched,
        SUM(statut_siretisation='ECHOUEE') as erreurs,
        SUM(statut_siretisation='INCERTAINE') as incertaines
      FROM resultats WHERE tache_id=?`, [req.params.id]
    );
    res.json({ statut: t.statut, nb_total: t.total_fiches, nb_traite: t.fiches_traitees, ...counts });
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ---- Resultats tache pagines ---- */
apiRouter.get('/taches/:id/resultats', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const q = req.query.q || '';
    const statut = req.query.statut || '';
    const sort = req.query.sort || 'id';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const allowedSorts = ['id','nom','code_postal','siren','score','statut_siretisation'];
    const sortCol = allowedSorts.includes(sort) ? sort : 'id';

    let where = 'WHERE tache_id=?';
    let params = [req.params.id];
    if (q) { where += ' AND (nom LIKE ? OR siren LIKE ?)'; params.push('%'+q+'%', '%'+q+'%'); }
    if (statut) { where += ' AND statut_siretisation=?'; params.push(statut); }

    const [[{total}]] = await poolSiretisation.query(
      'SELECT COUNT(*) as total FROM resultats ' + where, params
    );
    const [rows] = await poolSiretisation.query(
      'SELECT * FROM resultats ' + where + ' ORDER BY ' + sortCol + ' ' + order + ' LIMIT ? OFFSET ?',
      [...params, limit, offset]
    );
    res.json({rows, total, page, pages: Math.ceil(total/limit)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ---- Retraiter erreurs d'une tache ---- */
apiRouter.post('/taches/:id/retraiter', async (req, res) => {
  try {
    const [erreurs] = await poolSiretisation.query(
      "SELECT id FROM resultats WHERE tache_id=? AND statut_siretisation='ECHOUEE'",
      [req.params.id]
    );
    if (erreurs.length === 0) return res.json({ ok: true, message: 'Aucune fiche en erreur', count: 0 });
    await poolSiretisation.query(
      "UPDATE resultats SET statut_siretisation='EN_ATTENTE', score=0, siren=NULL, siret=NULL WHERE tache_id=? AND statut_siretisation='ECHOUEE'",
      [req.params.id]
    );
    await poolSiretisation.query(
      "UPDATE taches SET statut='en_cours', fiches_traitees = fiches_traitees - ? WHERE id=?",
      [erreurs.length, req.params.id]
    );
    res.json({ ok: true, message: erreurs.length + ' fiches remises en attente', count: erreurs.length });
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ---- Explorateur fiches ---- */
apiRouter.get('/fiches', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const sort = req.query.sort || 'id';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const allowedSorts = ['id','nom','code_postal','siren','score','statut_siretisation','tache_id'];
    const sortCol = allowedSorts.includes(sort) ? sort : 'id';

    let where = 'WHERE 1=1';
    let params = [];
    if (req.query.q) { where += ' AND (nom LIKE ? OR siren LIKE ? OR denomination LIKE ?)'; params.push('%'+req.query.q+'%','%'+req.query.q+'%','%'+req.query.q+'%'); }
    if (req.query.tache_id) { where += ' AND tache_id=?'; params.push(req.query.tache_id); }
    if (req.query.statut) { where += ' AND statut_siretisation=?'; params.push(req.query.statut); }
    if (req.query.cp) { where += ' AND code_postal LIKE ?'; params.push(req.query.cp+'%'); }
    if (req.query.has_siren === 'oui') { where += ' AND siren IS NOT NULL AND siren != ""'; }
    if (req.query.has_siren === 'non') { where += ' AND (siren IS NULL OR siren = "")'; }
    if (req.query.score_min) { where += ' AND score >= ?'; params.push(parseFloat(req.query.score_min)); }
    if (req.query.score_max) { where += ' AND score <= ?'; params.push(parseFloat(req.query.score_max)); }
    if (req.query.methode) { where += ' AND methode=?'; params.push(req.query.methode); }
    if (req.query.date_from) { where += ' AND date_traitement >= ?'; params.push(req.query.date_from); }
    if (req.query.date_to) { where += ' AND date_traitement <= ?'; params.push(req.query.date_to + ' 23:59:59'); }

    const [[{total}]] = await poolSiretisation.query('SELECT COUNT(*) as total FROM resultats ' + where, params);
    const [rows] = await poolSiretisation.query(
      'SELECT * FROM resultats ' + where + ' ORDER BY ' + sortCol + ' ' + order + ' LIMIT ? OFFSET ?',
      [...params, limit, offset]
    );
    res.json({rows, total, page, pages: Math.ceil(total/limit)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ---- Detail fiche ---- */
apiRouter.get('/fiches/:id', async (req, res) => {
  try {
    const [[f]] = await poolSiretisation.query('SELECT * FROM resultats WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({error:'Not found'});
    const [logs] = await poolSiretisation.query(
      'SELECT * FROM logs WHERE resultat_id=? ORDER BY date_log', [req.params.id]
    );
    res.json({ ...f, logs });
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ---- Relancer siretisation sur une fiche ---- */
apiRouter.post('/fiches/:id/relancer', async (req, res) => {
  try {
    const [[f]] = await poolSiretisation.query(
      'SELECT id, tache_id, nom, adresse, code_postal, ville, telephone, siret_fourni FROM resultats WHERE id=?',
      [req.params.id]
    );
    if (!f) return res.status(404).json({error:'Not found'});

    const methode = req.body.methode || 'auto';
    const seuil_firecrawl = req.body.seuil_firecrawl || 80;
    const etapes = [];
    let resultat = null;
    let finalStatut = 'ECHOUEE';
    let finalScore = 0;
    let finalDuree = 0;
    const startTime = Date.now();

    const searchInput = {
      nom: f.nom,
      adresse: f.adresse,
      code_postal: f.code_postal,
      ville: f.ville,
      telephone: f.telephone,
      siret_fourni: f.siret_fourni || null
    };

    // Etape 1: SIRENE locale
    if (methode === 'sirene_locale' || methode === 'auto') {
      const stepStartTime = Date.now();
      try {
        const sireneResult = await sireneLocale.rechercher(searchInput);
        const stepDuration = Date.now() - stepStartTime;

        // Calculer le detail du scoring
        const detailsScoring = sireneResult && sireneResult.denomination
          ? computeScoreDetails(f.nom, sireneResult.denomination, f.code_postal, sireneResult.cp_sirene)
          : null;

        etapes.push({
          nom: 'SIRENE locale',
          methode: 'sirene_locale',
          score: sireneResult.score || 0,
          duree_ms: stepDuration,
          statut: 'executes',
          resultat_brut: {
            denomination: sireneResult.denomination || null,
            siren: sireneResult.siren || null,
            siret: sireneResult.siret || null,
            adresse: sireneResult.adresse_sirene || sireneResult.adresse || null,
            code_postal: sireneResult.cp_sirene || sireneResult.code_postal || null,
            ville: sireneResult.ville_sirene || sireneResult.ville || null,
            activite: sireneResult.activite || null,
            categorie_juridique: sireneResult.categorie_juridique || null,
            etat_administratif: sireneResult.etat || sireneResult.etat_administratif || null,
            cpMatch: sireneResult.cpMatch || false
          },
          details_scoring: detailsScoring
        });

        resultat = sireneResult;
        finalScore = sireneResult.score || 0;
        finalDuree = stepDuration;

        // Si methode auto et score < seuil, essayer firecrawl
        if (methode === 'auto' && finalScore < seuil_firecrawl) {
          // Etape 2: Firecrawl
          const stepStartTime2 = Date.now();
          try {
            const firecrawlResult = await firecrawl.rechercher(searchInput);
            const stepDuration2 = Date.now() - stepStartTime2;

            const detailsFC = firecrawlResult && firecrawlResult.denomination
              ? computeScoreDetails(f.nom, firecrawlResult.denomination, f.code_postal, firecrawlResult.cp_sirene || firecrawlResult.code_postal)
              : null;

            etapes.push({
              nom: 'Firecrawl',
              methode: 'firecrawl',
              score: firecrawlResult.score || 0,
              duree_ms: stepDuration2,
              statut: 'executes',
              resultat_brut: {
                denomination: firecrawlResult.denomination || null,
                siren: firecrawlResult.siren || null,
                siret: firecrawlResult.siret || null,
                adresse: firecrawlResult.adresse || null,
                code_postal: firecrawlResult.code_postal || null,
                ville: firecrawlResult.ville || null,
                activite: firecrawlResult.activite || null,
                etat_administratif: firecrawlResult.etat_administratif || null
              },
              details_scoring: detailsFC
            });

            resultat = firecrawlResult;
            finalScore = firecrawlResult.score || 0;
            finalDuree = stepDuration + stepDuration2;
          } catch(e) {
            etapes.push({
              nom: 'Firecrawl',
              methode: 'firecrawl',
              score: 0,
              duree_ms: Date.now() - stepStartTime2,
              statut: 'erreur',
              resultat_brut: { error: e.message }
            });
          }
        }
      } catch(e) {
        etapes.push({
          nom: 'SIRENE locale',
          methode: 'sirene_locale',
          score: 0,
          duree_ms: Date.now() - stepStartTime,
          statut: 'erreur',
          resultat_brut: { error: e.message }
        });
      }
    }
    // Etape 1 (seulement): Firecrawl direct
    else if (methode === 'firecrawl') {
      const stepStartTime = Date.now();
      try {
        const firecrawlResult = await firecrawl.rechercher(searchInput);
        const stepDuration = Date.now() - stepStartTime;

        const detailsFCD = firecrawlResult && firecrawlResult.denomination
          ? computeScoreDetails(f.nom, firecrawlResult.denomination, f.code_postal, firecrawlResult.cp_sirene || firecrawlResult.code_postal)
          : null;

        etapes.push({
          nom: 'Firecrawl',
          methode: 'firecrawl',
          score: firecrawlResult.score || 0,
          duree_ms: stepDuration,
          statut: 'executes',
          resultat_brut: {
            denomination: firecrawlResult.denomination || null,
            siren: firecrawlResult.siren || null,
            siret: firecrawlResult.siret || null,
            adresse: firecrawlResult.adresse || null,
            code_postal: firecrawlResult.code_postal || null,
            ville: firecrawlResult.ville || null,
            activite: firecrawlResult.activite || null,
            etat_administratif: firecrawlResult.etat_administratif || null
          },
          details_scoring: detailsFCD
        });

        resultat = firecrawlResult;
        finalScore = firecrawlResult.score || 0;
        finalDuree = stepDuration;
      } catch(e) {
        etapes.push({
          nom: 'Firecrawl',
          methode: 'firecrawl',
          score: 0,
          duree_ms: Date.now() - stepStartTime,
          statut: 'erreur',
          resultat_brut: { error: e.message }
        });
      }
    }

    // Finaliser le resultat
    if (finalScore >= 70) {
      finalStatut = 'MATCHEE';
    } else if (finalScore >= 50) {
      finalStatut = 'INCERTAINE';
    } else {
      finalStatut = 'ECHOUEE';
    }

    // Mettre a jour la base de donnees
    await poolSiretisation.query(
      `UPDATE resultats SET
        siren=?, siret=?, score=?, statut_siretisation=?, methode_utilisee=?,
        sir_denomination=?, sir_adresse=?, sir_code_postal=?, sir_ville=?,
        sir_activite=?, sir_etat_administratif=?, duree_ms=?, date_traitement=NOW()
      WHERE id=?`,
      [
        resultat?.siren || null, resultat?.siret || null, finalScore,
        finalStatut, methode,
        resultat?.denomination || null, resultat?.adresse || null,
        resultat?.code_postal || null, resultat?.ville || null,
        resultat?.activite || null, resultat?.etat_administratif || null,
        finalDuree, req.params.id
      ]
    );

    res.json({
      ok: true,
      message: `Siretisation terminee: ${finalStatut} (score: ${finalScore})`,
      resultat: {
        siren: resultat?.siren || null,
        siret: resultat?.siret || null,
        score: finalScore,
        statut_siretisation: finalStatut,
        methode_utilisee: methode,
        duree_ms: finalDuree
      },
      etapes: etapes
    });
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

/* ---- Creer tache ---- */
apiRouter.post('/taches', async (req, res) => {
  try {
    const { type, fichier_source, parametres } = req.body;
    const [r] = await poolSiretisation.query(
      'INSERT INTO taches (type, statut, parametres, fichier_source, date_creation) VALUES (?, "en_attente", ?, ?, NOW())',
      [type, JSON.stringify(parametres||{}), fichier_source||null]
    );
    res.json({ ok: true, id: r.insertId });
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ---- Export Excel tache ---- */
apiRouter.get('/export/:tacheId', async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const [rows] = await poolSiretisation.query(
      'SELECT * FROM resultats WHERE tache_id=?', [req.params.tacheId]
    );
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Resultats');
    const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=export_'+req.params.tacheId+'.xlsx');
    res.send(buf);
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ---- Export Excel fiches filtrees ---- */
apiRouter.get('/export-fiches', async (req, res) => {
  try {
    const XLSX = require('xlsx');
    let where = 'WHERE 1=1';
    let params = [];
    if (req.query.q) { where += ' AND (nom LIKE ? OR siren LIKE ? OR denomination LIKE ?)'; params.push('%'+req.query.q+'%','%'+req.query.q+'%','%'+req.query.q+'%'); }
    if (req.query.tache_id) { where += ' AND tache_id=?'; params.push(req.query.tache_id); }
    if (req.query.statut) { where += ' AND statut_siretisation=?'; params.push(req.query.statut); }
    if (req.query.cp) { where += ' AND code_postal LIKE ?'; params.push(req.query.cp+'%'); }
    if (req.query.has_siren === 'oui') where += ' AND siren IS NOT NULL AND siren != ""';
    if (req.query.has_siren === 'non') where += ' AND (siren IS NULL OR siren = "")';
    if (req.query.score_min) { where += ' AND score >= ?'; params.push(parseFloat(req.query.score_min)); }
    if (req.query.score_max) { where += ' AND score <= ?'; params.push(parseFloat(req.query.score_max)); }
    if (req.query.methode) { where += ' AND methode=?'; params.push(req.query.methode); }
    const [rows] = await poolSiretisation.query(
      'SELECT * FROM resultats ' + where + ' ORDER BY id DESC LIMIT 50000', params
    );
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Fiches');
    const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=export_fiches.xlsx');
    res.send(buf);
  } catch(e) { res.status(500).json({error:e.message}); }
});

module.exports = { pagesRouter, apiRouter };
