const { poolSiretisation } = require('../config/database');
const sireneLocale = require('./sireneLocale');
const firecrawl = require('./firecrawl');
const logger = require('./logger');

/**
 * Orchestre la siretisation d'une fiche entreprise
 * Méthode auto: SIRENE locale d'abord, puis Firecrawl si score < seuil
 */
async function siretiser({ tacheId, nom, adresse, code_postal, ville, telephone, siret_fourni, methode, seuil_firecrawl }) {
  const start = Date.now();
  let resultat = null;

  await logger.log(tacheId, null, 'INFO', 'SIRETISATION_START', `Début siretisation: ${nom}`, { methode, seuil_firecrawl });

  try {
    // Regle: si pas d'adresse (seulement nom + ville/CP), passer directement a Firecrawl
    const hasAdresse = adresse && adresse.trim().length > 0;
    const skipLocal = !hasAdresse && methode === 'auto';
    if (skipLocal) {
      await logger.log(tacheId, null, 'INFO', 'SKIP_LOCAL', 'Pas d\'adresse fournie, passage direct a Firecrawl');
    }

    // Étape 1: SIRENE locale (sauf si methode = firecrawl uniquement ou pas d\'adresse en auto)
    if (!skipLocal && (methode === 'sirene_locale' || methode === 'auto')) {
      resultat = await sireneLocale.rechercher({ nom, adresse, code_postal, ville, telephone });
      await logger.log(tacheId, null, 'INFO', 'SEARCH_SIRENE', `SIRENE locale: score=${resultat ? resultat.score : 0}`, { resultat });

      // Si score suffisant ou méthode sirene_locale seule, on s'arrête
      if (methode === 'sirene_locale' || (resultat && resultat.score >= seuil_firecrawl)) {
        return finaliser(tacheId, resultat, 'sirene_locale', start);
      }
    }

    // Étape 2: Firecrawl (si methode = firecrawl ou auto avec score < seuil)
    if (methode === 'firecrawl' || methode === 'auto') {
      const resultatFirecrawl = await firecrawl.rechercher({ nom, adresse, code_postal, ville, telephone });
      await logger.log(tacheId, null, 'INFO', 'SEARCH_FIRECRAWL', `Firecrawl: score=${resultatFirecrawl ? resultatFirecrawl.score : 0}`, { resultat: resultatFirecrawl });

      // Garder le meilleur résultat
      if (resultatFirecrawl && (!resultat || resultatFirecrawl.score > resultat.score)) {
        resultat = resultatFirecrawl;
        return finaliser(tacheId, resultat, 'firecrawl', start);
      }
    }

    return finaliser(tacheId, resultat, resultat ? 'sirene_locale' : 'aucune', start);
  } catch (err) {
    await logger.log(tacheId, null, 'ERROR', 'SIRETISATION_ERROR', err.message);
    throw err;
  }
}

async function finaliser(tacheId, resultat, methode, start) {
  const duree = Date.now() - start;
  const score = resultat ? resultat.score : 0;
  let statut = 'ECHOUEE';
  if (score >= 70) statut = 'MATCHEE';
  else if (score >= 50) statut = 'INCERTAINE';

  const output = {
    siren: resultat ? resultat.siren : null,
    siret: resultat ? resultat.siret : null,
    score,
    statut_siretisation: statut,
    methode_utilisee: methode,
    sir_denomination: resultat ? resultat.denomination : null,
    sir_adresse: resultat ? resultat.adresse_sirene : null,
    sir_code_postal: resultat ? resultat.cp_sirene : null,
    sir_ville: resultat ? resultat.ville_sirene : null,
    sir_activite: resultat ? resultat.activite : null,
    sir_etat_administratif: resultat ? resultat.etat : null,
    duree_ms: duree
  };

  await logger.log(tacheId, null, 'INFO', 'SIRETISATION_END', `Résultat: ${statut} (score=${score}, methode=${methode}, ${duree}ms)`);
  return output;
}

module.exports = { siretiser };
