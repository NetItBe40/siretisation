const { poolSirene } = require('../config/database');

/**
 * Normalise une chaine pour comparaison
 */
function normaliser(str) {
  if (!str) return '';
  return str.toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calcule la similarite entre deux chaines (Dice coefficient sur bigrammes)
 */
function similarite(a, b) {
  a = normaliser(a);
  b = normaliser(b);
  if (a === b) return 100;
  if (!a || !b) return 0;

  const bigrammes = (s) => {
    const bg = new Set();
    for (let i = 0; i < s.length - 1; i++) bg.add(s.substring(i, i + 2));
    return bg;
  };

  const dice = (s1, s2) => {
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 100;
    const bg1 = bigrammes(s1);
    const bg2 = bigrammes(s2);
    let inter = 0;
    bg1.forEach(bg => { if (bg2.has(bg)) inter++; });
    return Math.round((2 * inter) / (bg1.size + bg2.size) * 100);
  };

  // Score 1: Dice classique
  const scoreDice = dice(a, b);

  // Score 2: Dice sur noms nettoyés (sans mots métier)
  const aN = nettoyerNomMetier(a);
  const bN = nettoyerNomMetier(b);
  const scoreDiceNettoye = dice(aN, bN);

  // Score 3: Containment - un nom contenu dans l'autre
  let scoreCont = 0;
  if (a.includes(b)) scoreCont = Math.min(100, Math.round(b.length / a.length * 130));
  else if (b.includes(a)) scoreCont = Math.min(100, Math.round(a.length / b.length * 130));
  else {
    // Containment par mots significatifs
    const motsA = new Set(a.split(' ').filter(m => m.length >= 3 && !STOP_WORDS.has(m)));
    const motsB = b.split(' ').filter(m => m.length >= 3 && !STOP_WORDS.has(m));
    if (motsB.length > 0) {
      const found = motsB.filter(m => motsA.has(m)).length;
      scoreCont = Math.round(found / motsB.length * 95);
    }
  }

  return Math.max(scoreDice, scoreDiceNettoye, scoreCont);
}

/**
 * Prepare les mots pour FULLTEXT search
 * Filtre les mots trop courts (< ft_min_word_len, generalement 3-4)
 */
function prepareFulltextQuery(mots) {
  // En mode BOOLEAN, prefixer chaque mot avec + pour AND
  return mots.filter(m => m.length >= 3).map(m => '+' + m + '*').join(' ');
}

/**
 * Prepare une requete FULLTEXT assouplie (OR au lieu de AND)
 * Garde le mot le plus long en obligatoire, les autres optionnels
 */
function prepareFulltextQuerySouple(mots) {
  const filtered = mots.filter(m => m.length >= 3);
  if (filtered.length === 0) return null;
  if (filtered.length === 1) return '+' + filtered[0] + '*';
  
  // Trier par longueur decroissante
  const sorted = [...filtered].sort((a, b) => b.length - a.length);
  // Le mot le plus long est obligatoire (+), les autres optionnels
  return '+' + sorted[0] + '* ' + sorted.slice(1).map(m => m + '*').join(' ');
}

// Mots generiques a ignorer dans le nom commercial (ne discriminent pas)
const STOP_WORDS = new Set([
  'RESTAURANT', 'BRASSERIE', 'CAFE', 'BAR', 'HOTEL', 'BOUTIQUE', 'MAGASIN',
  'BOULANGERIE', 'PATISSERIE', 'PHARMACIE', 'GARAGE', 'AUTO', 'COIFFURE',
  'SALON', 'INSTITUT', 'CABINET', 'AGENCE', 'BUREAU', 'CENTRE', 'ESPACE',
  'MAISON', 'ATELIER', 'STUDIO', 'CLUB', 'ASSOCIATION', 'SOCIETE', 'SAS',
  'SARL', 'EURL', 'SCI', 'SNC', 'SA', 'LE', 'LA', 'LES', 'DES', 'DU',
  'DE', 'ET', 'AU', 'AUX', 'EN', 'UN', 'UNE', 'CHEZ', 'AUX'
]);

/**
 * Filtre les mots non-significatifs d'un nom commercial
 */
function motsCles(nomNorm) {
  const mots = nomNorm.split(' ').filter(m => m.length >= 3);
  const significatifs = mots.filter(m => !STOP_WORDS.has(m));
  // Si tout est filtré, garder les mots originaux
  return significatifs.length > 0 ? significatifs : mots;
}

// --- MOTS METIER generiques a filtrer pour ameliorer le Dice ---
const MOTS_METIER = new Set([
  'RESTAURANT', 'BRASSERIE', 'BOULANGERIE', 'PATISSERIE', 'PIZZERIA',
  'TRAITEUR', 'SALON', 'COIFFURE', 'BEAUTE', 'INSTITUT',
  'PHARMACIE', 'GARAGE', 'CARROSSERIE', 'HOTEL', 'AUBERGE',
  'BAR', 'CAFE', 'TABAC', 'PRESSE', 'LIBRAIRIE',
  'FLEURISTE', 'FROMAGERIE', 'BOUCHERIE', 'CHARCUTERIE', 'POISSONNERIE',
  'EPICERIE', 'SUPERMARCHE', 'MAGASIN', 'BOUTIQUE', 'ATELIER',
  'CABINET', 'BUREAU', 'AGENCE', 'STUDIO', 'CENTRE',
  'CLINIQUE', 'LABORATOIRE', 'OPTIQUE', 'OPTICIEN',
  'BISTROT', 'BISTRO', 'CREPERIE', 'KEBAB', 'SNACK',
  'PRESSING', 'LAVERIE', 'QUINCAILLERIE', 'MERCERIE',
  'MENUISERIE', 'PLOMBERIE', 'ELECTRICITE', 'SERRURERIE',
  'AUTO', 'MOTO', 'CYCLES', 'SPORT', 'FITNESS',
  'SPA', 'MASSAGE', 'TATOUAGE', 'PIERCING',
  'PIZZAS', 'PIZZA', 'BURGERS', 'SUSHI', 'WOK',
  'CAVE', 'VIGNOBLE', 'DOMAINE', 'FERME', 'MARCHE',
  'PUB', 'TAVERNE', 'GUINGUETTE', 'RELAIS',
  'EMPORTER', 'LIVRAISON', 'DRIVE', 'EXPRESS',
  'SARL', 'SAS', 'EURL', 'SCI', 'SASU', 'GAEC', 'EI',
  'SOCIETE', 'ENTREPRISE', 'COMPAGNIE', 'ETABLISSEMENT',
  'MAISON', 'ESPACE', 'POINT', 'COIN', 'PETIT', 'GRAND'
]);

function nettoyerNomMetier(nomNorm) {
  const mots = nomNorm.split(' ').filter(m => m.length >= 2);
  const nettoye = mots.filter(m => !MOTS_METIER.has(m) && !STOP_WORDS.has(m));
  return nettoye.length > 0 ? nettoye.join(' ') : nomNorm;
}

/**
 * Parse ville et code postal depuis une adresse Google Business
 * Format typique: "12 Rue Machin, 75001 Paris, France"
 */
function parseAdresse(adresse) {
  if (!adresse) return null;
  // Pattern: ..., XXXXX Ville, France
  const match = adresse.match(/,\s*(\d{5})\s+([^,]+?)(?:,\s*France)?\s*$/i);
  if (match) {
    return { code_postal: match[1], ville: match[2].trim() };
  }
  // Pattern alternatif: XXXXX Ville (sans virgule avant)
  const match2 = adresse.match(/(\d{5})\s+([^,]+?)(?:,\s*France)?\s*$/i);
  if (match2) {
    return { code_postal: match2[1], ville: match2[2].trim() };
  }
  return null;
}

/**
 * Cherche les meilleurs candidats dans SIRENE pour une entreprise donnee
 * Version optimisee V2 avec strategies etendues
 */
async function rechercher({ nom, adresse, code_postal, ville, telephone }) {
  const nomNorm = normaliser(nom);
  const mots = motsCles(nomNorm);
  const ftQuery = prepareFulltextQuery(mots);
  const ftQuerySouple = prepareFulltextQuerySouple(mots);
  
  // --- AXE 1: Parser la ville depuis l'adresse si ville='France' ou vide ---
  if (!ville || ville === 'France' || ville === '') {
    const parsed = parseAdresse(adresse);
    if (parsed) {
      ville = parsed.ville;
      if (!code_postal || code_postal === '') {
        code_postal = parsed.code_postal;
      }
    }
  }
  
  const villeNorm = normaliser(ville);
  
  let candidats = [];

  // --- Strategie 1: FULLTEXT strict par code_postal (etablissements) ---
  if (code_postal && ftQuery) {
    const sql = `
      SELECT e.siret, e.siren, e.enseigne_1, e.enseigne_2, e.enseigne_3, e.denomination_usuelle,
        e.code_postal, e.libelle_commune, e.libelle_voie, e.numero_voie, e.type_voie,
        e.activite_principale, e.etat_administratif, e.etablissement_siege,
        ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle, ent.categorie_juridique,
        ent.tranche_effectif_salarie, ent.activite_principale AS act_ent
      FROM etablissements e
      JOIN entreprises ent ON e.siren = ent.siren
      WHERE e.code_postal = ?
        
        AND MATCH(e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3) AGAINST(? IN BOOLEAN MODE)
      LIMIT 50
    `;
    const [rows] = await poolSirene.query(sql, [code_postal, ftQuery]);
    candidats = candidats.concat(rows);
  }

  // --- Strategie 1b: FULLTEXT strict sur entreprises (denomination) ---
  if (candidats.length < 3 && code_postal && ftQuery) {
    const sql2 = `
      SELECT e.siret, e.siren, e.enseigne_1, e.enseigne_2, e.enseigne_3, e.denomination_usuelle,
        e.code_postal, e.libelle_commune, e.libelle_voie, e.numero_voie, e.type_voie,
        e.activite_principale, e.etat_administratif, e.etablissement_siege,
        ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle, ent.categorie_juridique,
        ent.tranche_effectif_salarie, ent.activite_principale AS act_ent
      FROM etablissements e
      JOIN entreprises ent ON e.siren = ent.siren
      WHERE e.code_postal = ?
        
        AND MATCH(ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle) AGAINST(? IN BOOLEAN MODE)
      LIMIT 50
    `;
    const [rows2] = await poolSirene.query(sql2, [code_postal, ftQuery]);
    const existingSirets = new Set(candidats.map(c => c.siret));
    rows2.forEach(r => { if (!existingSirets.has(r.siret)) candidats.push(r); });
  }

  // --- AXE 2: Strategie 2 - FULLTEXT ASSOUPLI si pas assez de resultats ---
  if (candidats.length < 3 && code_postal && ftQuerySouple && ftQuerySouple !== ftQuery) {
    const sqlSouple = `
      SELECT e.siret, e.siren, e.enseigne_1, e.enseigne_2, e.enseigne_3, e.denomination_usuelle,
        e.code_postal, e.libelle_commune, e.libelle_voie, e.numero_voie, e.type_voie,
        e.activite_principale, e.etat_administratif, e.etablissement_siege,
        ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle, ent.categorie_juridique,
        ent.tranche_effectif_salarie, ent.activite_principale AS act_ent
      FROM etablissements e
      JOIN entreprises ent ON e.siren = ent.siren
      WHERE e.code_postal = ?
        
        AND MATCH(e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3) AGAINST(? IN BOOLEAN MODE)
      LIMIT 50
    `;
    const [rowsSouple] = await poolSirene.query(sqlSouple, [code_postal, ftQuerySouple]);
    const existingSirets = new Set(candidats.map(c => c.siret));
    rowsSouple.forEach(r => { if (!existingSirets.has(r.siret)) candidats.push(r); });
  }

  
  // --- Strategie 2b: FULLTEXT ASSOUPLI sur entreprises (denomination) ---
  if (candidats.length < 3 && code_postal && ftQuerySouple && ftQuerySouple !== ftQuery) {
    const sql2bSouple = `
      SELECT e.siret, e.siren, e.enseigne_1, e.enseigne_2, e.enseigne_3, e.denomination_usuelle,
        e.code_postal, e.libelle_commune, e.libelle_voie, e.numero_voie, e.type_voie,
        e.activite_principale, e.etat_administratif, e.etablissement_siege,
        ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle, ent.categorie_juridique,
        ent.tranche_effectif_salarie, ent.activite_principale AS act_ent
      FROM etablissements e
      JOIN entreprises ent ON e.siren = ent.siren
      WHERE e.code_postal = ?
        AND MATCH(ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle) AGAINST(? IN BOOLEAN MODE)
      LIMIT 50
    `;
    const [rows2bSouple] = await poolSirene.query(sql2bSouple, [code_postal, ftQuerySouple]);
    const exS2b = new Set(candidats.map(c => c.siret));
    rows2bSouple.forEach(r => { if (!exS2b.has(r.siret)) candidats.push(r); });
    if (rows2bSouple.length > 0) console.log("[sireneLocale] Strat 2b FULLTEXT souple ent:", ftQuerySouple, "->", rows2bSouple.length);
  }

  // --- Strategie 3: Par ville si pas assez de resultats ---
  if (candidats.length < 3 && ville && ftQuery) {
    const sql3 = `
      SELECT e.siret, e.siren, e.enseigne_1, e.enseigne_2, e.enseigne_3, e.denomination_usuelle,
        e.code_postal, e.libelle_commune, e.libelle_voie, e.numero_voie, e.type_voie,
        e.activite_principale, e.etat_administratif, e.etablissement_siege,
        ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle, ent.categorie_juridique,
        ent.tranche_effectif_salarie, ent.activite_principale AS act_ent
      FROM etablissements e
      JOIN entreprises ent ON e.siren = ent.siren
      WHERE UPPER(e.libelle_commune) LIKE ?
        
        AND MATCH(e.denomination_usuelle, e.enseigne_1, e.enseigne_2, e.enseigne_3) AGAINST(? IN BOOLEAN MODE)
      LIMIT 50
    `;
    const [rows3] = await poolSirene.query(sql3, [`%${villeNorm}%`, ftQuery]);
    const existingSirets = new Set(candidats.map(c => c.siret));
    rows3.forEach(r => { if (!existingSirets.has(r.siret)) candidats.push(r); });
  }

  // --- AXE 3: Recherche par telephone ---
  if (candidats.length < 3 && telephone) {
    const telNorm = telephone.replace(/[\s\.\-\(\)]/g, '').replace(/^\+33/, '0');
    if (telNorm.length >= 10) {
      const sqlTel = `
        SELECT e.siret, e.siren, e.enseigne_1, e.enseigne_2, e.enseigne_3, e.denomination_usuelle,
          e.code_postal, e.libelle_commune, e.libelle_voie, e.numero_voie, e.type_voie,
          e.activite_principale, e.etat_administratif, e.etablissement_siege,
          ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle, ent.categorie_juridique,
          ent.tranche_effectif_salarie, ent.activite_principale AS act_ent
        FROM etablissements e
        JOIN entreprises ent ON e.siren = ent.siren
        WHERE 1=1
          AND (e.telephone = ? OR e.telephone2 = ?)
        LIMIT 10
      `;
      try {
        const [rowsTel] = await poolSirene.query(sqlTel, [telNorm, telNorm]);
        const existingSirets = new Set(candidats.map(c => c.siret));
        rowsTel.forEach(r => { if (!existingSirets.has(r.siret)) candidats.push(r); });
      } catch(e) {
        // telephone columns may not exist, ignore
      }
    }
  }

  // --- AXE 4: Recherche par adresse exacte si toujours rien ---
  if (candidats.length < 1 && code_postal && adresse) {
    // Extraire numero et voie depuis l'adresse
    const adresseMatch = adresse.match(/^(\d+)\s+(.+?)(?:,|$)/);
    if (adresseMatch) {
      const numero = adresseMatch[1];
      const voie = normaliser(adresseMatch[2]);
      const voieMots = voie.split(' ').filter(m => m.length >= 3);
      if (voieMots.length > 0) {
        const ftVoie = voieMots.map(m => '+' + m + '*').join(' ');
        const sqlAddr = `
          SELECT e.siret, e.siren, e.enseigne_1, e.enseigne_2, e.enseigne_3, e.denomination_usuelle,
            e.code_postal, e.libelle_commune, e.libelle_voie, e.numero_voie, e.type_voie,
            e.activite_principale, e.etat_administratif, e.etablissement_siege,
            ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle, ent.categorie_juridique,
            ent.tranche_effectif_salarie, ent.activite_principale AS act_ent
          FROM etablissements e
          JOIN entreprises ent ON e.siren = ent.siren
          WHERE e.code_postal = ?
            AND e.numero_voie = ?
            
            AND MATCH(e.libelle_voie) AGAINST(? IN BOOLEAN MODE)
          LIMIT 10
        `;
        try {
          const [rowsAddr] = await poolSirene.query(sqlAddr, [code_postal, numero, ftVoie]);
          const existingSirets = new Set(candidats.map(c => c.siret));
          rowsAddr.forEach(r => { if (!existingSirets.has(r.siret)) candidats.push(r); });
        } catch(e) {
          // libelle_voie FULLTEXT index may not exist
        }
      }
    }
  }


  // --- Strategie 6: Recherche par nom partiel (sans la ville) + code_postal ---
  if (candidats.length < 3 && ville && code_postal) {
    const villeNormU = normaliser(ville);
    const nomSansVille = nomNorm.replace(new RegExp(villeNormU.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "").trim();
    if (nomSansVille && nomSansVille !== nomNorm && nomSansVille.length >= 2) {
      const motsSV = motsCles(nomSansVille);
      const ftQSV = prepareFulltextQuery(motsSV);
      if (ftQSV) {
        // 6a: LIKE sur denomination + code_postal
        const sqlLike = `
          SELECT e.siret, e.siren, e.enseigne_1, e.enseigne_2, e.enseigne_3, e.denomination_usuelle,
            e.code_postal, e.libelle_commune, e.libelle_voie, e.numero_voie, e.type_voie,
            e.activite_principale, e.etat_administratif, e.etablissement_siege,
            ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle, ent.categorie_juridique,
            ent.tranche_effectif_salarie, ent.activite_principale AS act_ent
          FROM etablissements e
          JOIN entreprises ent ON e.siren = ent.siren
          WHERE e.code_postal = ?
            
            AND (ent.denomination LIKE ? OR ent.denomination_usuelle_1 LIKE ?
              OR ent.denomination_usuelle_2 LIKE ? OR ent.denomination_usuelle_3 LIKE ?
              OR ent.nom_usage LIKE ? OR e.denomination_usuelle LIKE ? OR e.enseigne_1 LIKE ?)
          LIMIT 50`;
        const likeP = "%" + nomSansVille.split(/\s+/).filter(m => m.length >= 2)[0] + "%";
        try {
          const [rLike] = await poolSirene.query(sqlLike, [code_postal, likeP, likeP, likeP, likeP, likeP, likeP, likeP]);
          const exS = new Set(candidats.map(c => c.siret));
          rLike.forEach(r => { if (!exS.has(r.siret)) candidats.push(r); });
          if (rLike.length > 0) console.log("[sireneLocale] Strat 6a LIKE:", nomSansVille, "->", rLike.length);
        } catch(e) { /* ignore */ }

        // 6b: FULLTEXT sur entreprises avec nom sans ville
        const sql6b = `
          SELECT e.siret, e.siren, e.enseigne_1, e.enseigne_2, e.enseigne_3, e.denomination_usuelle,
            e.code_postal, e.libelle_commune, e.libelle_voie, e.numero_voie, e.type_voie,
            e.activite_principale, e.etat_administratif, e.etablissement_siege,
            ent.denomination, ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle, ent.categorie_juridique,
            ent.tranche_effectif_salarie, ent.activite_principale AS act_ent
          FROM etablissements e
          JOIN entreprises ent ON e.siren = ent.siren
          WHERE e.code_postal = ?
            
            AND MATCH(ent.denomination_usuelle_1, ent.denomination_usuelle_2, ent.denomination_usuelle_3, ent.nom_usage, ent.sigle) AGAINST(? IN BOOLEAN MODE)
          LIMIT 50`;
        try {
          const [r6b] = await poolSirene.query(sql6b, [code_postal, ftQSV]);
          const exS2 = new Set(candidats.map(c => c.siret));
          r6b.forEach(r => { if (!exS2.has(r.siret)) candidats.push(r); });
          if (r6b.length > 0) console.log("[sireneLocale] Strat 6b FULLTEXT:", ftQSV, "->", r6b.length);
        } catch(e) { /* ignore */ }
      }
    }
  }

  if (candidats.length === 0) return null;

  // --- Scoring ---
  const scored = candidats.map(c => {
    const denominations = [
        c.denomination_usuelle, c.enseigne_1, c.enseigne_2, c.enseigne_3,
        c.denomination, c.denomination_usuelle_1, c.denomination_usuelle_2,
        c.denomination_usuelle_3, c.nom_usage, c.sigle
      ].filter(Boolean);

    const scores = denominations.map(d => similarite(nomNorm, normaliser(d)));
    const bestScore = Math.max(...scores, 0);

      // Score par mots significatifs: containment + word-vs-word Dice
      const stopWords = new Set(['SAS','SARL','SCI','SA','EURL','SNC','ETS','AND','THE','LES','DES','POUR','AVEC','PAR','SOCIETE','GROUPE','FRANCE','ENTREPRISE','SERVICES','INTERNATIONAL']);
      const motsInput = nomNorm.split(/\s+/).filter(m => m.length >= 3 && !stopWords.has(m));
      
      let wordBestScore = 0;
      if (motsInput.length >= 1) {
        // Pour chaque denomination, verifier combien de mots de l'input y sont contenus
        for (const d of denominations) {
          const dNorm = normaliser(d);
          const dWords = dNorm.split(/\s+/).filter(w => w.length >= 2);
          
          let nbMotsTrouves = 0;
          let bestWordDice = 0;
          for (const mot of motsInput) {
            // Verifier containment (le mot apparait dans la denomination)
            if (dNorm.includes(mot)) {
              nbMotsTrouves++;
            }
            // Aussi comparer mot-a-mot (chaque mot input vs chaque mot denomination)
            for (const dw of dWords) {
              const s = similarite(mot, dw);
              if (s > bestWordDice) bestWordDice = s;
            }
          }
          
          // Score base sur le ratio de mots trouves + meilleur Dice mot-a-mot
          if (nbMotsTrouves > 0) {
            const ratio = nbMotsTrouves / motsInput.length;
          const containScore = ratio >= 1 ? 100 : Math.round(50 * ratio + 50 * ratio * ratio);
            if (containScore > wordBestScore) wordBestScore = containScore;
          }
          // Ponderer le Dice mot-a-mot par le ratio de mots trouves dans la meilleure denomination
        if (bestWordDice > 0 && motsInput.length > 1) {
          const wd = Math.round(bestWordDice * (Math.max(nbMotsTrouves, 1) / motsInput.length));
          if (wd > wordBestScore) wordBestScore = wd;
        } else if (bestWordDice > wordBestScore) {
          wordBestScore = bestWordDice;
        }
        }
      }
      
      // Prendre le meilleur entre score full-string et score par mot
      const finalScore = Math.max(bestScore, wordBestScore);


    // Bonus si le code postal correspond exactement
    const cpMatch = c.code_postal === code_postal;

    return {
      siren: c.siren,
      siret: c.siret,
      score: finalScore,
      denomination: c.denomination || c.denomination_usuelle_1 || c.denomination_usuelle || c.enseigne_1,
      adresse_sirene: [c.numero_voie, c.type_voie, c.libelle_voie].filter(Boolean).join(' '),
      cp_sirene: c.code_postal,
      ville_sirene: c.libelle_commune,
      activite: c.activite_principale || c.act_ent,
      etat: c.etat_administratif,
      categorie_juridique: c.categorie_juridique,
      tranche_effectif: c.tranche_effectif_salarie,
      cpMatch
    };
  });

  // Trier par score decroissant
  scored.sort((a, b) => b.score - a.score);

  // Retourner le meilleur
  return scored[0] || null;
}

module.exports = { rechercher, similarite, normaliser };
