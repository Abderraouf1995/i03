# ⚡ io3 Community

Application web + mobile (PWA installable) pour partager son expérience d'autonomie électrique
avec l'io3 **4X2** et **4X4**, comparer les résultats et discuter dans le chat de la communauté.

## Fonctionnalités
- **Création de compte / connexion** (pseudo ou email + mot de passe, hash bcrypt, session JWT 30 jours)
- **Partager un trajet** : distance, batterie départ/arrivée, type de parcours, mode de conduite,
  consommation, température, vitesse, clim → calcul automatique de l'autonomie estimée à 100 %
- **Fil des trajets** filtrable : Tous / 4X2 / 4X4 / Les miens
- **Statistiques 4X2 vs 4X4** : autonomie moyenne et max, consommation, ville/route/autoroute, froid/doux
- **Chat communauté en temps réel** (Socket.IO), avec partage de trajets en carte dans le chat,
  membres en ligne et badge de messages non lus
- **Responsive** : barre latérale sur ordinateur, barre d'onglets en bas sur téléphone
- **PWA** : « Ajouter à l'écran d'accueil » sur Android / iPhone

## Lancer en local
Node.js 22.13+ requis (utilise `node:sqlite`, aucune base externe).

```bash
npm install
npm start
```
Ouvre http://localhost:3000. Les données sont dans `data/io3.db`.

Sur ton téléphone (même Wi-Fi) : `http://<IP-de-ton-PC>:3000`.

## Mettre en ligne pour la communauté

Variables d'environnement :
| Variable | Rôle |
|---|---|
| `PORT` | port d'écoute (fourni par l'hébergeur) |
| `JWT_SECRET` | longue chaîne aléatoire secrète (signe les sessions) |
| `DATA_DIR` | dossier **persistant** de la base SQLite (ex. `/var/data`) |

⚠️ Sans disque persistant, comptes, trajets et messages sont **effacés à chaque redéploiement**.
L'hébergement doit être en **HTTPS** (fourni automatiquement par les options ci-dessous).

### Option A — Render (le plus simple)
1. Mets ce dossier sur un dépôt GitHub (privé ou public).
2. Sur render.com : **New → Blueprint** → choisis le dépôt. Le fichier `render.yaml` configure tout :
   Node 24, disque persistant de 1 Go sur `/var/data`, `JWT_SECRET` généré automatiquement,
   vérification de santé `/healthz`.
3. Le disque persistant nécessite un plan payant (Starter). Render te donne une adresse
   `https://io3-community.onrender.com` (ou un nom proche) à partager dans le chat de la communauté.

### Option B — Railway
1. Dépôt GitHub → railway.app → **New Project → Deploy from GitHub repo** (le `Dockerfile` est détecté).
2. **Add Volume** monté sur `/var/data`.
3. Variables : `JWT_SECRET` = une longue valeur aléatoire (`DATA_DIR` est déjà `/var/data` dans le Dockerfile).
4. **Settings → Networking → Generate Domain** pour obtenir l'URL HTTPS.

### Option C — Ton propre serveur / VPS (Docker)
```bash
docker build -t io3-community .
docker run -d --name io3 --restart unless-stopped -p 3000:3000 \
  -e JWT_SECRET="remplace-par-une-longue-chaine-aleatoire" \
  -v io3-data:/var/data io3-community
```
Place ensuite un reverse proxy HTTPS devant (Caddy, Nginx + Let's Encrypt).

### Sauvegarde
Toutes les données sont dans le fichier `io3.db` du dossier `DATA_DIR` : copie-le régulièrement.

### Après la mise en ligne
- Partage l'URL dans le chat de la communauté io3.
- Sur téléphone : ouvrir l'URL → menu du navigateur → **Ajouter à l'écran d'accueil**
  (Android : bouton « Installer l'app » dans l'onglet Profil).
