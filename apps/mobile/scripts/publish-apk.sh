#!/usr/bin/env bash
# Publie l'APK Android de production derrière le lien stable Convex :
#   https://site.identite.ga/downloads/identite-android.apk
# Ce lien ne change jamais ; il pointe toujours vers le dernier APK publié.
# La section « Applications mobiles » de l'accueil identite.ga l'affiche
# d'elle-même (`mobileApp.getLinks`).
#
# Construire l'APK au préalable (profil `production-apk` de eas.json) :
#   bunx eas build --local --platform android --profile production-apk --output <fichier.apk>
#
# usage : scripts/publish-apk.sh <fichier.apk> <version> <versionCode>
#   ex. : scripts/publish-apk.sh ~/Downloads/identite.apk 1.1.0 42
#
# Cible : le fichier d'environnement Convex de production
# (`~/.config/identite-ga/convex-prod.env`, cf. DEPLOIEMENT.md). Pour viser une
# autre instance : CONVEX_ENV_FILE=/chemin/vers/fichier.env.
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "usage : $0 <fichier.apk> <version> <versionCode>" >&2
  exit 1
fi
APK="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
VERSION="$2"
BUILD="$3"
ENV_FILE="${CONVEX_ENV_FILE:-$HOME/.config/identite-ga/convex-prod.env}"
[ -f "$APK" ] || { echo "APK introuvable : $APK" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Fichier d'environnement Convex introuvable : $ENV_FILE" >&2; exit 1; }

cd "$(dirname "$0")/../../../packages/backend"

echo "→ Envoi de $(basename "$APK") ($(du -h "$APK" | cut -f1)) — cible : ${ENV_FILE}…"
UPLOAD_URL="$(bunx convex run --env-file "$ENV_FILE" mobileApp:generateUploadUrl | tr -d '"')"
STORAGE_ID="$(
  curl -sSf -X POST \
    -H "Content-Type: application/vnd.android.package-archive" \
    --data-binary "@${APK}" "$UPLOAD_URL" |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["storageId"])'
)"

echo "→ Publication de la version ${VERSION} (${BUILD})…"
bunx convex run --env-file "$ENV_FILE" mobileApp:publish \
  "{\"storageId\":\"${STORAGE_ID}\",\"version\":\"${VERSION}\",\"buildNumber\":\"${BUILD}\"}"

echo "✓ APK publié derrière /downloads/identite-android.apk"
