> Mise à jour du 13 novembre 2026 : les DNS `api.identite.ga` et
> `site.identite.ga` pointent actuellement vers Convex Cloud. Le déploiement
> actif vérifié est `flexible-panda-248`. Le récit de migration ci-dessous
> décrit un état historique ; ne pas utiliser la clé auto-hébergée contre
> ces domaines. Les fonctions de téléchargement mobile ont été déployées
> sur Cloud. Accès CLI direct privé :
> `~/.config/identite-ga/convex-downloads-cloud.env`.

# Déploiement identite.ga

État du 10 octobre 2026 : **Convex auto-hébergé sur Dokploy est en service**
depuis 01:02:49, heure de Paris (`2026-10-09T23:02:49Z`). L'export final a été
importé et comparé intégralement. Convex Cloud `flexible-panda-248` reste intact
et en pause depuis 00:34:33. L'utilisateur a confirmé le bon fonctionnement
de la connexion après le nouveau test Web/mobile.
Les fronts restent sur Vercel et le serveur de mails conserve son hébergement
actuel.

L'infrastructure est pilotée depuis <https://dokploy.kamau.tech> avec le skill
`deployer-dokploy` dans `~/.agents/skills/deployer-dokploy/`.

## Adresses et DNS

| Usage | Adresse |
|---|---|
| Site public | https://identite.ga |
| Administration | https://admin.identite.ga |
| Développeurs | https://developers.identite.ga |
| Contrôleurs | https://controllers.identite.ga |
| API Convex canonique | https://api.identite.ga |
| Actions HTTP et authentification | https://site.identite.ga |

Les deux CNAME Netim vers `convex.domains.` ont été remplacés par les
enregistrements suivants. Ils ont été vérifiés sur les trois serveurs
autoritaires Netim, Google DNS, Cloudflare DNS et la résolution locale avant
l'activation de la destination. Le précédent TTL de 24 heures avait été abaissé
plus de 24 heures avant la bascule.

| Nom | Type | Cible | TTL |
|---|---|---|---|
| `api.identite.ga` | A | `102.208.104.151` | 300 |
| `site.identite.ga` | A | `102.208.104.151` | 300 |

L'utilisateur a effectué les deux modifications dans Netim.
Les DNS des fronts, les MX/TXT et les domaines des autres services ne sont pas
concernés.

Les deux domaines de préparation `idn-convex-api.apps.kamau.tech` et
`idn-convex-site.apps.kamau.tech` ont été retirés du compose après validation.
Les apps utilisent exclusivement les deux adresses canoniques de production.

## Services Dokploy

Cible : VM ST Digital `ntsagui`, datacenter Nkok au Gabon,
`102.208.104.151`, SSH sur 2240. Le plan de contrôle Dokploy est sur `vps-dev` ;
les bases et fichiers de cette instance sont sur `ntsagui`.

| Ressource | Identifiant |
|---|---|
| Serveur Dokploy | `ntMMya5PxWRrYFMf4SAUF` |
| Projet `identite-ga` | `Ng5Ab3bon70vtxFOYEw3e` |
| Environnement `production` | `CT43V8tcgQAZK4Xi5kt3w` |
| Compose Convex | `z8POvX0rWA2XLNozbdx03` |
| AppName Convex | `identite-convex-edxc6f` |
| PostgreSQL 17 | `h_Hj7uvbHt_ouXHRsjrIB` |
| Hôte PostgreSQL interne | `identite-convex-pg-o121qz` |
| Base PostgreSQL | `identite_ga_prod` |
| Compose Garage | `-llewlm785GIPPd9Rw6o0` |
| AppName Garage | `identite-convex-storage-wdtojl` |

Les fichiers [compose Convex](services/convex/compose.yaml) et
[compose Garage](services/convex/storage-compose.yaml) sont les configurations
installées via l'API Dokploy. Les images Convex backend et dashboard sont figées
sur `02fe59be03b7892072d95229ab82c310a15fb222`. Garage utilise `v2.4.1`.

Le backend dispose de 1 536 Mio, PostgreSQL de 512 Mio, Garage de 512 Mio et le
dashboard de 256 Mio. Les actions Node sont limitées à quatre exécutions
simultanées. Les volumes PostgreSQL, Convex, Garage metadata et Garage data
persistent entre redéploiements.

Traefik termine HTTPS et relaie vers les ports internes 3210/3211. Aucun port
applicatif n'est publié sur une interface publique. S3 est privé sur
`identite-convex-s3:3900`, avec des identifiants et cinq buckets dédiés :
`idn-convex-exports`, `idn-convex-imports`, `idn-convex-modules`,
`idn-convex-files`, `idn-convex-search`.

Garage possède **un seul nœud**, avec une capacité déclarée de 12 Go. Il n'offre
pas de réplication sur une seconde machine.

## Préparation et validations

Le code Convex déployé vient du commit
`2b10012f04b242f9b4da298c1973be366a076236`, depuis un checkout isolé.
La validation TypeScript et celle du schéma ont réussi. Les 34 variables
applicatives ont été copiées et comparées à la production, notamment les secrets
d'authentification et les clés de signature.

Cloud a été figé à `2026-10-09T22:34:33Z`, puis un nouvel export complet,
fichiers inclus, a été importé et réexporté depuis Dokploy :

| Vérification | Résultat |
|---|---|
| Tables, composants compris | 120 identiques |
| Enregistrements, métadonnées des fichiers comprises | 19 401 identiques |
| Comptes Better Auth | 1 043 |
| Fichiers | 475 identiques, 703 036 032 octets |
| Comparaison du contenu | SHA-256 et contenu JSON identiques |
| Variables applicatives | 34 identiques |
| Backend, PostgreSQL et Garage | Démarrage et santé vérifiés |
| TLS des deux domaines de production | Certificats valides jusqu'au 7 janvier 2027 |
| Pages de connexion des quatre fronts | HTTP 200 |
| Session anonyme, discovery OIDC et deux JWKS | HTTP 200 |
| WebSocket sur `api.identite.ga` | Connexion vérifiée |
| Téléchargements JPEG, PNG, PDF | HTTP 200 et SHA-256 identiques à l'export final |
| Tâches programmées au gel de la source | Aucune, composants compris |
| Définitions des crons | 7 identiques |
| Reprise des tâches de fond | Une exécution réussie du cron de reprise des webhooks observée |

Les anciennes données du composant `resend`, actuellement non monté dans le
code, ont été conservées par l'import. La destination est active ; Cloud reste
en pause pour éviter l'exécution simultanée des tâches de fond.

Le changement des origines du compose ne réévalue pas automatiquement
`auth.config.ts`. Le fournisseur JWT avait conservé le domaine de préparation,
ce qui a provoqué un retour à la connexion sur le Web et le mobile après la
bascule. Les fonctions ont été redéployées depuis le même checkout propre, avec
`convex-prod.env` et validation TypeScript. À 01:09:26, heure de Paris, le
fournisseur enregistré a été vérifié : `issuer=https://site.identite.ga` et
`jwks=https://site.identite.ga/api/auth/convex/jwks`. L'utilisateur a ensuite
confirmé que la connexion fonctionne. Les requêtes de session et de jeton
arrivant sur le nouveau backend ne présentent plus de refus JWT ni d'erreurs
HTTP 500 dans la fenêtre vérifiée.

Les quatre projets Vercel ont été reconstruits avec
`NEXT_PUBLIC_CONVEX_URL=https://api.identite.ga`, en conservant le commit de chaque
déploiement réellement en ligne. Les bundles utilisent cette adresse et ne
contiennent plus l'ancienne URL API Cloud. Les pages de connexion répondent 200 ;
le formulaire du site public et sa requête de session ont aussi été vérifiés dans
le navigateur. L'API canonique accepte désormais HTTP et WebSocket sur Dokploy.

| Projet Vercel | Identifiant |
|---|---|
| `identite-ga` | `prj_z0lrqlcoUAsd5zEuvCfIwXyGdjLI` |
| `admin-identite-ga` | `prj_P8HjyNODYp3eV43Ir0NJLeRE6lzY` |
| `developers-identite-ga` | `prj_01iOP0RU6WJldJf3GmlIidm8wwiI` |
| `controllers-identite-ga` | `prj_dCyi8lFT7W58QHU4wdslufxF4vMu` |

Les variables Expo `preview` et `production` utilisent désormais
`EXPO_PUBLIC_CONVEX_URL=https://api.identite.ga` et
`EXPO_PUBLIC_CONVEX_SITE_URL=https://site.identite.ga`. Des mises à jour Expo
compatibles ont été publiées pour les tests TestFlight/Google Play, en conservant
le commit de chaque version déjà publiée :

| Canal | Plateforme | Groupe Expo | Commit |
|---|---|---|---|
| `production` | iOS | `1e41565c-d059-4704-8ba0-afdac4564413` | `2b10012` |
| `production` | Android | `11729d22-6132-457e-b911-9596e048db99` | `2b10012` |
| `preview` | iOS | `f60e26ad-d2bb-4b5d-8d8f-3fd7d60e9c41` | `f6fefd7` |

Les vérifications TypeScript et les tests mobiles ont réussi sur les deux
checkouts. Les bundles contiennent les deux adresses canoniques et aucune
référence à l'ancien domaine Cloud. Les trois manifestes servis par Expo et les
bundles téléchargés ont été vérifiés : HTTP 200, IDs des nouvelles mises à jour
et SHA-256 identiques aux bundles préparés. Les runtimes calculés correspondent à
`546b163dc8efa6455e3e3b943c1485bfb34689eb` pour iOS et
`42829739c28223540a7a3d3c454406bfb4384d9b` pour Android. Le 9 octobre 2026,
l'utilisateur a confirmé l'installation de la mise à jour et une connexion
réussie sur un appareil de test. La plateforme et le canal n'ont pas été précisés.
Ce test valide les adresses canoniques encore reliées à Convex Cloud. La connexion
au backend Dokploy est vérifiée séparément après la bascule. Le premier essai
sur Dokploy a révélé le fournisseur JWT encore lié au domaine de préparation,
également visible dans les logs du serveur. L'utilisateur a confirmé le succès
du nouvel essai après correction. Face ID n'a pas été vérifié séparément.
Les autres testeurs doivent aussi installer la mise à jour via **Profil → Mises
à jour**, puis redémarrer l'application. Un ancien binaire possédant un autre
runtime ne reçoit pas ces mises à jour.

## Secrets et sauvegardes de migration

Sur le Mac : `~/.config/identite-ga/`, dossier 700 et fichiers 600, hors dépôt.

- `dokploy-state.json` : IDs et repères de migration.
- `convex-prod-infra.json` : identifiants générés de l'instance, PostgreSQL et S3.
- `convex-cloud.env` : copie privée des variables applicatives Cloud.
- `convex-cloud-credentials.json` : accès à **flexible-panda-248**.
- `convex-staging.env` : URL de préparation et clé admin de la nouvelle instance.
- `convex-prod.env` : URL canonique de production et nouvelle clé admin.
- `migration/` : exports ZIP avec fichiers, rapports, logs privés et sauvegardes
  des environnements/déploiements Vercel et Expo pour retour arrière.

Sur `ntsagui`, `/var/lib/identite-ga-migration/` est privé à root et contient les
identifiants Cloud et de destination pour les transferts directs, les outils et
les exports de préparation et l'export final. Le CLI Convex `1.38.0` est installé
dans `cli/`.
L'image d'outil utilisée est
`node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`.
L'export complet local de la destination a été testé en 43 secondes et l'accès
d'export à Cloud a été testé depuis cette VM.

Ne jamais imprimer ces fichiers ni passer une clé en argument de commande sur
la VM : auditd/Wazuh journalisent les arguments. Utiliser fichiers ou stdin.
Les identifiants d'instance et PostgreSQL ont été renouvelés avant l'import à
la suite d'un affichage accidentel lors d'un diagnostic.

L'export final `cloud-final-2026-10-09T223433Z.zip` a aussi été copié directement
de la VM vers le Mac (670 749 530 octets), puis contrôlé par SHA-256 et CRC ZIP.
SHA-256 : `d2e5f03b62468f21435fe134c42aea5d0261b8079b9f117fbff9c13097a5a54c`.

**Aucune sauvegarde automatique sur une seconde machine n'est configurée.** Les
exports privés sur le Mac constituent une copie ponctuelle de migration.
Configurer une destination de sauvegarde au Gabon et tester la restauration
avant de considérer l'exploitation comme durable.

## Fenêtre de bascule

1. Vérifier la fin du délai DNS, les mises à jour mobiles installées, l'état
   courant des déploiements et la capacité de la VM. Coordonner la disponibilité
   de l'utilisateur dans Netim. Suspendre les déploiements de code pendant cette
   fenêtre. Si le code ou la configuration Cloud a évolué depuis la préparation,
   recopier et valider ces changements sur la destination avant de mettre Cloud
   en pause.
2. Mettre **flexible-panda-248** en pause via
   `POST /api/v1/pause_deployment`, avec son accès admin lu depuis le fichier
   privé. Confirmer l'état avec la query système
   `_system/frontend/deploymentState:deploymentState`.
3. Faire un **nouvel export complet**, fichiers inclus, directement sur la VM.
   Les données de l'import de préparation ont continué à évoluer sur Cloud.
   Pour le CLI connecté au compte Cloud sur le Mac, sélectionner explicitement
   `--deployment flexible-panda-248`, jamais `--prod`. Sur la VM, le mode direct
   utilise uniquement `CONVEX_SELF_HOSTED_URL` et la clé admin de cette source,
   depuis le fichier privé `cloud.env`, sans option `--deployment` ni `--prod`.
4. Importer cet export avec `convex import --replace-all -y` dans la destination
   toujours en pause, via son URL interne et son fichier d'accès. Réexporter et
   comparer avec `services/convex/compare_exports.py`. Arrêter la bascule en cas
   de différence ; remettre Cloud en service si nécessaire.
5. Faire remplacer les deux CNAME par les A indiqués plus haut dans Netim.
   Vérifier les serveurs autoritaires et les caches publics. Attendre l'expiration
   des derniers caches de 300 secondes ; les requêtes arrivant sur Cloud restent
   bloquées pendant la fenêtre pour éviter des écritures divergentes.
6. Ajouter les deux domaines de production dans Dokploy pour `backend`, ports
   3210 et 3211, HTTPS Let's Encrypt. Mettre
   `CONVEX_CLOUD_ORIGIN=https://api.identite.ga` et
   `CONVEX_SITE_ORIGIN=https://site.identite.ga` dans l'environnement du compose,
   puis redéployer et vérifier les certificats et la santé. Redéployer aussi les
   fonctions avec `convex-prod.env` pour réévaluer `auth.config.ts`. Vérifier
   `_system/frontend/listAuthProviders` : l'issuer et l'adresse JWKS doivent
   correspondre au domaine de production avant toute activation.
7. Remettre la destination en service avec `POST /api/v1/unpause_deployment`.
   Vérifier les connexions, les cookies/sessions, les passkeys, les connexions
   WebSocket, les fichiers et les requêtes depuis les quatre fronts et le mobile.
   Contrôler les tâches de fond et la mémoire. Cloud reste intact et en pause.
8. Mettre à jour les secrets CI ci-dessous et conserver l'export final hors de
   la VM. Retirer les routes de préparation après validation de la production.

L'import/export de données applicatives ne remplace pas la vérification des
tâches programmées internes, des workflows et des crons à la bascule.

## Déploiements ultérieurs et CI

Depuis un checkout propre contenant le code destiné à la production :

```sh
cd packages/backend
bun x convex deploy --env-file ~/.config/identite-ga/convex-prod.env --codegen disable --typecheck enable
```

Le fichier `convex-staging.env` est conservé comme repère de migration ; ses
domaines ont été retirés. Utiliser `convex-prod.env` pour cette instance.
Le dashboard est accessible par tunnel, jamais par un domaine public :

```sh
ssh -N -L 6792:127.0.0.1:6792 ntsagui
```

Puis ouvrir <http://localhost:6792> et lire la clé depuis le fichier privé.

Une modification locale de `.github/workflows/deploy.yml` prépare le support de
Convex auto-hébergé. Les quatre secrets suivants ont été configurés avec succès
dans `ntsagui/idn-gabon` par l'API GitHub lors de la bascule :

| Secret GitHub | Valeur / provenance |
|---|---|
| `CONVEX_SELF_HOSTED_URL` | `https://api.identite.ga` |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | Nouvelle clé dans `convex-prod.env` |
| `NEXT_PUBLIC_CONVEX_URL` | `https://api.identite.ga` |
| `CONVEX_SITE_URL` | `https://site.identite.ga` |

Le workflow préparé écarte la clé Cloud lorsque les deux secrets auto-hébergés
sont présents. Les secrets publics partagés empêchent `deploy-mobile.yml` de
rétablir l'ancienne valeur dans Expo. Le compte `gh` dispose du droit push ;
l'écriture des secrets Actions a été vérifiée malgré l'absence du droit admin.

Le workflow distant utilise encore la clé Cloud tant que cette modification
n'est pas commitée et poussée. Son déclenchement actuel inclut aussi quatre
déploiements Cloud Run historiques. Éviter de le déclencher pendant la migration
et revoir ces jobs avant d'activer le déploiement automatique du backend.

Les fichiers de migration et la modification du workflow sont locaux, **aucun
commit ni push n'a été effectué**. Les fichiers déjà modifiés par l'utilisateur
ont été conservés.

## Retour arrière

Si aucune nouvelle écriture n'a encore eu lieu sur Dokploy, mettre d'abord la
destination en pause, remettre les deux CNAME Netim vers `convex.domains.`, puis
remettre Cloud en service après vérification des DNS.
Les fronts et les nouvelles mises à jour mobiles utilisant les adresses
canoniques fonctionneront à nouveau sur Cloud après expiration des caches.

Si des écritures ont déjà eu lieu sur Dokploy, les exporter et réconcilier les
données avant de remettre Cloud en service : l'ancien export ne contient pas
ces écritures. Ne jamais laisser les deux instances accepter des écritures
simultanément. Les anciens déploiements Vercel et mises à jour Expo sont
référencés dans les sauvegardes privées pour un retour arrière de configuration.
