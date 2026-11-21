// Copie les bibliothèques front depuis node_modules vers vendor/ (site 100 % statique).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'vendor');

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

fs.rmSync(out, { recursive: true, force: true });

// KaTeX : feuille de style, script et polices.
copy(path.join(nm, 'katex/dist/katex.min.css'), path.join(out, 'katex/katex.min.css'));
copy(path.join(nm, 'katex/dist/katex.min.js'), path.join(out, 'katex/katex.min.js'));
copy(path.join(nm, 'katex/dist/fonts'), path.join(out, 'katex/fonts'));

// pdf.js : bibliothèque et worker.
copy(path.join(nm, 'pdfjs-dist/build/pdf.min.mjs'), path.join(out, 'pdfjs/pdf.min.mjs'));
copy(path.join(nm, 'pdfjs-dist/build/pdf.worker.min.mjs'), path.join(out, 'pdfjs/pdf.worker.min.mjs'));

// Trystero : regroupé en un seul module ESM.
execFileSync(path.join(nm, '.bin/esbuild'), [
  path.join(nm, 'trystero/dist/index.mjs'),
  '--bundle', '--format=esm', '--minify',
  `--outfile=${path.join(out, 'trystero.js')}`,
], { stdio: 'inherit' });

console.log('vendor/ régénéré');
