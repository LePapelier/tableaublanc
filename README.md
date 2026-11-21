# Tableau blanc

Petite application web de tableau blanc collaboratif, **sans aucun serveur à héberger** : des fichiers statiques, déployables sur GitHub Pages.

- **Dessin à plusieurs en temps réel** (crayon, surligneur, gomme), avec les traits en cours et les curseurs des autres participants.
- **Texte et LaTeX** : écrivez du texte, entourez les formules de `$…$` (en ligne) ou `$$…$$` (bloc). Rendu avec KaTeX. Quatre tailles de trait et de texte prédéfinies.
- **PDF et images** : importez un PDF ou une image (bouton, glisser-déposer, ou Ctrl+V pour une image du presse-papiers). Chaque page PDF est posée sur le tableau et vous pouvez **écrire par-dessus**, déplacer, redimensionner et tourner pages et images. Les fichiers sont envoyés directement aux autres navigateurs.
- Canevas infini (déplacement, zoom), **sélection** d'un ou plusieurs éléments (clic, cadre rectangulaire ou **lasso à main levée**) pour les déplacer, les redimensionner par les coins, les **faire tourner** par la poignée du haut, les dupliquer ou les supprimer, annuler/rétablir.
- **Pensé pour le tactile** : dessin au doigt ou au stylet (rejet de la paume), pincement pour zoomer, barre d'outils en bas de l'écran sur téléphone, en portrait comme en paysage.
- **Sauvegarde locale** : chaque navigateur conserve les salles qu'il a visitées (IndexedDB). En rouvrant le lien, vous retrouvez le tableau, et les autres participants connectés le complètent.
- **Préambule LaTeX** (menu « ⋯ ») : macros partagées par la salle (`\newcommand`, `\def`, `\DeclareMathOperator`…), synchronisées entre participants et enregistrées avec la session. `\usepackage` est accepté pour les packages que KaTeX couvre déjà ; `bussproofs` (`\begin{prooftree}` … `\AxiomC`, `\BinaryInfC`, `\RightLabel`…) et `mhchem` (`\ce{}`) sont émulés. Les autres packages sont signalés comme non pris en charge.
- **Enregistrer et rouvrir une session** (menu « ⋯ ») : un fichier `.json` autonome, PDF et images compris, à ouvrir plus tard dans n'importe quelle salle.
- **Exporter en PDF** (menu « ⋯ ») : les pages PDF d'origine sont reprises telles quelles avec vos traits en vectoriel par-dessus, les formules et images incrustées ; tout ce qui est en dehors des pages va sur une page supplémentaire.

## Comment ça marche sans serveur ?

La collaboration passe par **WebRTC**, en pair-à-pair, grâce à [Trystero](https://github.com/dmotz/trystero). Pour que deux navigateurs se trouvent, Trystero publie une petite annonce chiffrée sur des relais publics (protocole Nostr) ; une fois la connexion établie, **tout le contenu circule directement entre les navigateurs**, chiffré de bout en bout, sans passer par aucun serveur. Il n'y a rien à configurer.

Conséquences à connaître :

- Le tableau vit dans les navigateurs des participants. Si tout le monde ferme l'onglet, il reste dans le stockage local de chacun, et il est resynchronisé quand quelqu'un revient.
- Une personne qui rejoint une salle vide (aucun autre onglet ouvert et rien en local) voit un tableau vide jusqu'à ce qu'un participant qui a le contenu se reconnecte.
- Derrière certains pare-feux d'entreprise, WebRTC peut échouer sans serveur TURN. Un message l'indique en haut de l'écran.

Si vous préférez un relais de mise en relation privé, lancez `npm run relay` (un mini relais Nostr, `tools/relay.js`) et ouvrez l'application avec `?relay=ws://votre-hote:4444`. Plusieurs relais se séparent par des virgules.

## Déployer sur GitHub Pages

Le dépôt contient un workflow (`.github/workflows/pages.yml`) qui publie le site à chaque push sur `main`.

1. Dans le dépôt GitHub : **Settings → Pages → Build and deployment → Source : GitHub Actions**.
2. Poussez sur `main` (ou lancez le workflow à la main depuis l'onglet Actions).
3. Le site est disponible sur `https://<utilisateur>.github.io/tableaublanc/`.

Vous pouvez aussi choisir **Source : Deploy from a branch**, branche `main`, dossier `/ (root)` : tous les chemins sont relatifs, cela fonctionne tel quel.

## Lancer en local

Il suffit d'un serveur de fichiers statiques (les modules ES ne se chargent pas depuis `file://`) :

```bash
npm start
```

Puis ouvrez <http://localhost:3000>. Pour tester à deux sur la même machine, ouvrez le même lien dans une fenêtre de navigation privée.

## Raccourcis

| Touche | Action |
| --- | --- |
| `V` | Sélection : clic ou cadre rectangulaire ; glisser pour déplacer, coins pour redimensionner, poignée du haut pour tourner (`Maj` : pas de 15°), `Suppr` pour effacer, double-clic pour un texte |
| `L` | Lasso : entourer à main levée les traits à sélectionner (`Maj` : ajouter à la sélection) |
| `Ctrl+A` / `Ctrl+D` | Tout sélectionner / dupliquer la sélection |
| `P` ou `C` | Crayon |
| `H` | Surligneur |
| `E` ou `G` | Gomme (efface les traits touchés) |
| `T` | Texte / LaTeX (cliquer sur un texte existant pour le modifier) |
| `M` ou `Espace` maintenu | Déplacer la vue |
| `Ctrl` + molette | Zoom (la molette seule fait défiler) |
| `Ctrl+Z` / `Ctrl+Y` | Annuler / rétablir |

Sur téléphone ou tablette : un doigt dessine (ou sélectionne, avec l'outil flèche), deux doigts déplacent la vue et zooment. Avec l'outil flèche, encadrez une zone (ou, avec le lasso, entourez-la à main levée) pour sélectionner les traits qu'elle contient, puis glissez l'ensemble, tirez un coin pour le redimensionner ou la poignée du haut pour le faire tourner ; une petite barre « Dupliquer / Supprimer » apparaît au-dessus de la sélection.

## Structure

- `index.html`, `style.css`, `app.js` : toute l'application ; `latex-extras.mjs` : normalisation du préambule et traducteur bussproofs → fractions KaTeX (rendu canvas, outils, édition LaTeX, PDF avec pdf.js, export avec pdf-lib, synchronisation pair-à-pair, stockage local). Icônes [Lucide](https://lucide.dev) en SVG inline.
- `vendor/` : KaTeX, pdf.js, pdf-lib et Trystero copiés depuis npm, pour que le site soit autonome. Régénérer avec `npm run vendor` après une mise à jour des dépendances.
- `tools/relay.js` : relais Nostr minimal, optionnel, pour un usage privé ou les tests.
- `.github/workflows/pages.yml` : déploiement GitHub Pages.
