# Tableau blanc

Petite application web de tableau blanc collaboratif, sans framework :

- **Dessin à plusieurs en temps réel** (crayon, surligneur, gomme), avec les traits en cours et les curseurs des autres participants visibles.
- **Texte et LaTeX** : écrivez du texte, entourez les formules de `$…$` (en ligne) ou `$$…$$` (bloc). Rendu avec KaTeX.
- **PDF** : importez un PDF (bouton ou glisser-déposer), chaque page est posée sur le tableau et vous pouvez **écrire par-dessus**, déplacer et redimensionner les pages.
- Canevas infini (déplacement, zoom), sélection/déplacement des objets, annuler/rétablir, sauvegarde automatique de chaque salle côté serveur.

## Lancer

```bash
npm install
npm start
```

Puis ouvrez <http://localhost:3000>. Une salle est créée automatiquement ; le bouton **Partager** copie son lien, à envoyer aux personnes avec qui collaborer. Le port se change avec la variable `PORT`.

Les salles sont enregistrées dans `data/room-<id>.json` et les PDF envoyés dans `data/uploads/`.

## Raccourcis

| Touche | Action |
| --- | --- |
| `V` | Sélection (glisser pour déplacer, `Suppr` pour effacer, double-clic pour un texte) |
| `P` ou `C` | Crayon |
| `H` | Surligneur |
| `E` ou `G` | Gomme (efface les traits touchés) |
| `T` | Texte / LaTeX (cliquer sur un texte existant pour le modifier) |
| `M` ou `Espace` maintenu | Déplacer la vue |
| `Ctrl` + molette | Zoom (la molette seule fait défiler) |
| `Ctrl+Z` / `Ctrl+Y` | Annuler / rétablir |

Sur tablette : un doigt dessine, deux doigts déplacent et zooment.

## Structure

- `server.js` : serveur HTTP (fichiers statiques, upload de PDF) et WebSocket (`ws`) qui relaie les opérations par salle et les persiste.
- `public/app.js` : rendu du tableau (canvas), outils, édition LaTeX, rendu des PDF (pdf.js), synchronisation.
- Les bibliothèques (KaTeX, pdf.js) sont servies depuis `node_modules`, donc l'application fonctionne hors ligne.
