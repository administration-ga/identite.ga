# @idn-ga/core

## 0.3.0

### Minor Changes

- [#21](https://github.com/administration-ga/identite.ga/pull/21) [`dd9b42c`](https://github.com/administration-ga/identite.ga/commit/dd9b42cb4ce2d4308ed63b8f42caa4edecfed428) Thanks [@administration-ga](https://github.com/administration-ga)! - `verifyIdToken` suit la rotation des clés d'IDN : sur un `kid` inconnu, le JWKS est relu (une fois par fenêtre de 30 s), sans jamais retomber sur une autre clé. Un ID token sans `kid`, ou dont la clé publiée ne correspond pas à l'algorithme, est refusé. Nouvelle option `minLevel` (1, 2 ou 3) contrôlée sur la revendication `acr` (`eidas1`…`eidas3`) ; le client OIDC revérifie au retour le niveau demandé en `acr_values`. `levelOfAcr` est exporté.

## 0.2.0

### Minor Changes

- [`743e7f8`](https://github.com/okatech-org/identite.ga/commit/743e7f82852755ec99855bb2407968127d9a7a7d) Thanks [@okafrancois](https://github.com/okafrancois)! - Fix : URL discovery OIDC par défaut pointait sur `https://identite.ga` (site vitrine, sans serveur OIDC) → toute intégration sans override `discoveryUrl` plantait au démarrage du flow OAuth.

  Le défaut pointe désormais sur `https://site.identite.ga/api/auth/convex/.well-known/openid-configuration` — custom domain HTTP Actions du déploiement Convex prod IDN, avec le namespace `/api/auth/convex/*` du composant `@convex-dev/better-auth`.

  `DEFAULT_ISSUER` passe de `https://identite.ga` à `https://site.identite.ga`. Les apps qui overrident déjà `issuer` + `discoveryUrl` ne sont pas impactées.

## 0.1.1

### Patch Changes

- [`8cd3f0d`](https://github.com/okatech-org/identite.ga/commit/8cd3f0d252fec149cb860a893796d290c2edf9fe) Thanks [@okafrancois](https://github.com/okafrancois)! - Setting up ci deploy
