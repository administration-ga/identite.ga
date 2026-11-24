---
"@idn-ga/core": minor
---

`verifyIdToken` suit la rotation des clés d'IDN : sur un `kid` inconnu, le JWKS est relu (une fois par fenêtre de 30 s), sans jamais retomber sur une autre clé. Un ID token sans `kid`, ou dont la clé publiée ne correspond pas à l'algorithme, est refusé. Nouvelle option `minLevel` (1, 2 ou 3) contrôlée sur la revendication `acr` (`eidas1`…`eidas3`) ; le client OIDC revérifie au retour le niveau demandé en `acr_values`. `levelOfAcr` est exporté.
