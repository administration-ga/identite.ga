# Migration Identité.ga — 9 septembre 2026

Les quatre applications web du commit `234a68e75f70f0c3be4804746580b7105425a99d`
sont déployées en production dans Vercel, compte `ntsagui`, équipe
`Internals` (`internals1`). Convex reste sur `flexible-panda-248`.

| Application | Projet Vercel | Domaine | Déploiement |
| --- | --- | --- | --- |
| apps/web | identite-ga | identite.ga | dpl_5u3Vy8E324CApJ8SXVFe4LJyVZ2i |
| apps/admin | admin-identite-ga | admin.identite.ga | dpl_GrtJAa4317TykwAHHiVbE4o716c1 |
| apps/developer | developers-identite-ga | developers.identite.ga | dpl_4SNo943QkD9cVMaAScAD66ZmNXzC |
| apps/controller | controllers-identite-ga | controllers.identite.ga | dpl_GHmqgwpi8fjUvJtrPdo3R6Zkw76p |

Les quatre déploiements sont READY. Installation : `bun install --frozen-lockfile`.
Compilation depuis chaque racine d’application :
`cd ../.. && bun run build --filter=<nom du package>`.
Les builds ont été effectués par Vercel à partir d’une archive Git sans fichiers
`.env`, dépendances locales ni secrets de déploiement.

Variables de production Vercel :

- `NEXT_PUBLIC_CONVEX_URL=https://flexible-panda-248.convex.cloud`
- `CONVEX_SITE_URL=https://site.identite.ga`
- `NEXT_PUBLIC_CONVEX_SITE_URL=https://site.identite.ga`
- `NEXT_PUBLIC_SITE_URL=https://<domaine de l’application>`

Les fichiers locaux pointaient vers `flexible-eel-807` et n’ont pas été utilisés
pour configurer la production. Ne jamais utiliser le raccourci Convex `--prod` ;
passer explicitement `--deployment flexible-panda-248`.

## DNS Netim

| Nom | Type | Cible |
| --- | --- | --- |
| identite.ga | A | 216.198.79.1 |
| identite.ga | A | 64.29.17.1 |
| www.identite.ga | CNAME | 05534a53fec70112.vercel-dns-017.com. |
| admin.identite.ga | CNAME | 52bbc4a4312005fa.vercel-dns-017.com. |
| developers.identite.ga | CNAME | 34106a87e5af5a8d.vercel-dns-017.com. |
| controllers.identite.ga | CNAME | 848f56cc4a39393e.vercel-dns-017.com. |
| video.identite.ga | A | 82.66.163.161 |

Les anciennes IPv4 Google `216.239.{32,34,36,38}.21` et IPv6
`2001:4860:4802:{32,34,36,38}::15` du domaine principal ont été retirées.
Les anciens CNAME des quatre noms web pointaient vers `ghs.googlehosted.com`.
TTL conservés : 24 heures pour le domaine principal, www et video ;
5 minutes pour admin, developers et controllers.
MX, SPF, TXT et les CNAME Convex `api.identite.ga`/`site.identite.ga` sont préservés.
Les caches contenant les anciennes IP peuvent rester actifs jusqu’à 24 heures.

## LiveKit partagé

- Hôte Freebox : `berny@192.168.1.39`, IPv4 publique `82.66.163.161`.
- Conteneur existant : `livekit-gabon`, image LiveKit Server `v1.13.6`.
- Configuration : `/home/berny/services/livekit-gabon/livekit.yaml`.
- Paire de clés Identité.ga existante ajoutée à `keys`, sans remplacer celle de Gabon Diplomatie.
- Signalisation : `wss://video.identite.ga`, valeur `LIVEKIT_URL` existante conservée dans Convex.
- Caddy : bloc `video.identite.ga`, proxy vers `172.18.0.1:7880`.
- Certificat Let’s Encrypt délivré.
- `LIVEKIT_AUTOSUSPEND_ENABLED=false` sur `flexible-panda-248`.
- Réutilisation des ports déjà ouverts : TCP 7881, UDP 7882, TURN UDP 3478.
- Pas de TURN/TLS sur 443 ; `turn.identite.ga` n’est pas utilisé par cette configuration.

Sauvegardes avant modification : `livekit.yaml.before-identite` et
`/home/berny/services/homelab/Caddyfile.before-identite` sur le serveur.
Les clés ne sont ni enregistrées dans Git ni copiées dans Vercel.

## Vérifications

- Quatre builds Vercel READY ; quatre domaines `misconfigured: false` dans l’API Vercel.
- HTTPS 200 sur `/` et `/api/auth/get-session` pour les quatre domaines,
  en ciblant directement Vercel pour éviter les anciens caches DNS locaux.
- `www.identite.ga` : HTTPS 308 vers `https://identite.ga/`.
- Test LiveKit : deux participants avec les clés Identité.ga connectés via
  `wss://video.identite.ga`, paquet WebRTC reçu, salle de test supprimée.
- Ce test n’est pas une validation d’entretien vidéo réel ni un test depuis un réseau mobile extérieur.

## Limites et déploiements suivants

Les déploiements ont été réalisés manuellement via CLI. Aucun dépôt Git n’est
encore lié aux quatre projets Vercel. Le dépôt local reste
`https://github.com/okatech-org/identite.ga.git` ; aucun push ni transfert GitHub n’a été effectué.
Toujours vérifier le compte `ntsagui` et la portée `internals1` avant un déploiement ;
la connexion Vercel locale par défaut appartient à un autre compte.

Les workflows `.github/workflows/deploy.yml` et `deploy-livekit.yml` restent
historiques et ciblent Google Cloud. Celui de LiveKit peut réactiver l’ancien
contrôleur Google et ne doit pas être relancé pour la production Freebox.

Les services distincts `kyc.identite.ga` (inférence KYC) et `connect.identite.ga`
restent dirigés vers Google dans Netim. Ils n’ont pas été redéployés dans cette
migration des quatre applications web et de LiveKit. Leurs fonctions n’ont pas
été validées. L’application mobile n’a pas été reconstruite.
