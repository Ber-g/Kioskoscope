// Stubs de globals navigateur pour exécuter la LOGIQUE PURE du dashboard sous Node.
//
// Pourquoi : `src/i18n/index.ts` appelle `detectLang()` AU CHARGEMENT du module
// (`localStorage` + `navigator`), et `src/ui/dom.ts` construit du DOM via `document`.
// La logique testée (computeKpis / sortBooths / statusDistribution / mappers /
// formatMoney / relativeTime) est pure, mais transite par ces modules à l'import.
//
// ⚠️ Ce module DOIT être importé EN PREMIER (avant tout module qui touche i18n / dom).
// En ESM, les imports s'évaluent dans l'ordre d'apparition, en profondeur d'abord :
// placer cet import en tête garantit que les stubs existent avant l'init de i18n.
//
// Ce n'est PAS un vrai DOM (aucune dépendance jsdom/navigateur) — juste le strict
// minimum pour que `el()` / `icon()` produisent un arbre inspectable en mémoire.

/** Nœud DOM minimal — assez pour `el()`/`icon()` de `src/ui/dom.ts`. */
export class FakeEl {
  readonly tagName: string;
  className = "";
  innerHTML = "";
  readonly attrs: Record<string, string> = {};
  readonly children: FakeNode[] = [];
  readonly classList = {
    add: (...tokens: string[]): void => {
      this.className = [this.className, ...tokens].filter(Boolean).join(" ");
    },
  };

  constructor(tag: string) {
    this.tagName = tag;
  }

  setAttribute(key: string, value: string): void {
    this.attrs[key] = value;
  }

  getAttribute(key: string): string | null {
    return key in this.attrs ? this.attrs[key]! : null;
  }

  append(...nodes: FakeNode[]): void {
    for (const n of nodes) this.children.push(n);
  }
}

export interface FakeText {
  readonly nodeType: 3;
  readonly textContent: string;
}

export type FakeNode = FakeEl | FakeText;

const fakeDocument = {
  createElement: (tag: string): FakeEl => new FakeEl(tag),
  createElementNS: (_ns: string, tag: string): FakeEl => new FakeEl(tag),
  createTextNode: (data: string): FakeText => ({ nodeType: 3, textContent: data }),
  documentElement: { lang: "fr" },
};

const fakeStorage = {
  _m: new Map<string, string>(),
  getItem(k: string): string | null {
    return this._m.has(k) ? this._m.get(k)! : null;
  },
  setItem(k: string, v: string): void {
    this._m.set(k, v);
  },
  removeItem(k: string): void {
    this._m.delete(k);
  },
};

const g = globalThis as unknown as Record<string, unknown>;
if (!g.localStorage) g.localStorage = fakeStorage;
if (!g.navigator) g.navigator = { language: "fr-FR" };
if (!g.document) g.document = fakeDocument;

/** Parcourt en profondeur un arbre FakeEl et retourne tous les éléments dont la
 *  `className` contient le token exact `token` (séparé par des espaces). */
export function collectByClassToken(root: FakeEl, token: string): FakeEl[] {
  const out: FakeEl[] = [];
  const visit = (node: FakeNode): void => {
    if (!(node instanceof FakeEl)) return;
    if (node.className.split(/\s+/).includes(token)) out.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}
