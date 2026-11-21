// Compléments LaTeX pour KaTeX : normalisation du préambule et émulation de bussproofs.

// Packages que KaTeX couvre déjà nativement (acceptés sans rien faire).
export const BUILTIN_PACKAGES = new Set([
  'amsmath', 'amssymb', 'amsfonts', 'amsthm', 'mathtools', 'cancel', 'color', 'xcolor', 'bm',
  'inputenc', 'fontenc', 'babel', 'lmodern', 'geometry', 'hyperref', 'graphicx', 'textcomp',
  'braket', 'stmaryrd', 'latexsym', 'mathrsfs', 'upgreek', 'eufrak', 'dsfont',
]);
// Packages émulés par ce module ou par une extension KaTeX.
export const EMULATED_PACKAGES = new Set(['bussproofs', 'mhchem']);

// Analyse le préambule : renvoie le texte à donner à KaTeX et la liste des packages demandés.
export function normalizePreamble(src) {
  const packages = [];
  const body = String(src || '')
    .replace(/%[^\n]*/g, '')
    .replace(/\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}/g, (_, list) => {
      for (const p of list.split(',')) if (p.trim()) packages.push(p.trim());
      return '';
    })
    .replace(/\\documentclass(?:\[[^\]]*\])?\{[^}]*\}/g, '')
    .replace(/\\(?:begin|end)\{document\}/g, '')
    // \newcommand échoue sur une macro déjà connue de KaTeX (\R, \N…) : providecommand définit ou redéfinit.
    .replace(/\\(?:re)?newcommand\b/g, '\\providecommand')
    .replace(/\\DeclareMathOperator(\*?)\s*\{\s*(\\[A-Za-z@]+)\s*\}\s*\{([^{}]*)\}/g,
      (_, star, name, text) => `\\providecommand{${name}}{\\operatorname${star}{${text}}}`)
    .trim();
  return { body, packages };
}

// --- bussproofs -----------------------------------------------------------

// Lit un argument entre accolades à partir de la position i (qui pointe sur « { »).
function readBraced(s, i) {
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return { arg: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

// bussproofs travaille en mode texte : « $…$ » bascule en maths. Ici tout est en maths,
// on inverse donc : les parties hors « $ » deviennent \text{…}. Sans « $ », on garde tel quel (maths).
function textModeToMath(arg) {
  const t = arg.replace(/\\(?:scriptsize|footnotesize|small|tiny|normalsize)\b/g, '').trim();
  if (!t) return '';
  if (!t.includes('$')) return t;
  const parts = t.split('$');
  return parts.map((p, i) => (i % 2 ? p : (p.trim() ? `\\text{${p}}` : ''))).join('');
}

function translateOneTree(src) {
  const stack = [];
  let right = '', left = '', line = 'single';
  const commands = /\\(AxiomC|UnaryInfC|BinaryInfC|TrinaryInfC|QuaternaryInfC|QuinaryInfC|RightLabel|LeftLabel|noLine|singleLine|doubleLine|dashedLine|alwaysNoLine|alwaysSingleLine|alwaysDoubleLine|insertBetweenHyps|DisplayProof|EnableBpAbbreviations|AXC|UIC|BIC|TIC|RL|LL)\b/g;
  const arity = { UnaryInfC: 1, BinaryInfC: 2, TrinaryInfC: 3, QuaternaryInfC: 4, QuinaryInfC: 5, UIC: 1, BIC: 2, TIC: 3 };
  let m;
  while ((m = commands.exec(src))) {
    const name = m[1];
    let arg = '';
    const braced = readBraced(src, skipSpaces(src, m.index + m[0].length));
    if (braced) { arg = braced.arg; commands.lastIndex = braced.end; }
    switch (name) {
      case 'AxiomC': case 'AXC':
        stack.push(textModeToMath(arg));
        break;
      case 'RightLabel': case 'RL': right = textModeToMath(arg); break;
      case 'LeftLabel': case 'LL': left = textModeToMath(arg); break;
      case 'noLine': case 'alwaysNoLine': line = 'none'; break;
      case 'singleLine': case 'alwaysSingleLine': line = 'single'; break;
      case 'doubleLine': case 'alwaysDoubleLine': line = 'double'; break;
      case 'dashedLine': line = 'single'; break;
      default: {
        const n = arity[name];
        if (!n) break;
        if (stack.length < n) throw new Error(`\\${name} : il manque des prémisses`);
        const premises = stack.splice(stack.length - n, n).join(' \\qquad ');
        const concl = textModeToMath(arg);
        let frac;
        if (line === 'none') frac = `\\genfrac{}{}{0pt}{}{${premises}}{${concl}}`;
        else if (line === 'double') frac = `\\genfrac{}{}{0.4pt}{}{${premises}}{\\genfrac{}{}{0.4pt}{}{\\vphantom{|}}{${concl}}}`;
        else frac = `\\dfrac{${premises}}{${concl}}`;
        stack.push((left ? `{\\scriptstyle ${left}}\\,` : '') + frac + (right ? `\\,{\\scriptstyle ${right}}` : ''));
        right = left = '';
        if (!/always/.test(name)) line = line === 'double' || line === 'none' ? 'single' : line;
      }
    }
  }
  if (!stack.length) return '';
  return stack.join(' \\qquad ');
}

function skipSpaces(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

// Remplace chaque environnement prooftree par son équivalent en fractions imbriquées.
export function translateProoftrees(tex) {
  return tex.replace(/\\begin\{prooftree\}([\s\S]*?)\\end\{prooftree\}/g, (_, inner) => translateOneTree(inner));
}
