// Wordmark Fabi — version 6 lignes ANSI Shadow (cohérent avec install.sh).
// Le split left/right reste : `Logo()` rend `left` et `right` séparément, ce
// qui permet (via inkLeft / inkRight passés depuis home.tsx) de teinter "FA"
// en orange brand et "BI" en bleu brand.
//
// Si tu modifies, n'utilise QUE des caractères "lit" (█ ▀ ▄ ╗ ║ ═ ╔ ╝ ╚)
// ou des espaces (`" "`). Les marqueurs `_ ^ ~ ,` sont réservés au système
// d'ombrage de `component/logo.tsx` et changeraient le rendu de la lumière.

export const logo = {
  left: [
    "███████╗ █████╗ ",
    "██╔════╝██╔══██╗",
    "█████╗  ███████║",
    "██╔══╝  ██╔══██║",
    "██║     ██║  ██║",
    "╚═╝     ╚═╝  ╚═╝",
  ],
  right: [
    "██████╗ ██╗",
    "██╔══██╗██║",
    "██████╔╝██║",
    "██╔══██╗██║",
    "██████╔╝██║",
    "╚═════╝ ╚═╝",
  ],
}

// Wordmark `go` — utilisé par `GoLogo` pour la transition logo→go.
// Mis à jour pour matcher la hauteur 6 lignes du nouveau `logo`.
export const go = {
  left: [
    " ██████╗ ",
    "██╔════╝ ",
    "██║  ███╗",
    "██║   ██║",
    "╚██████╔╝",
    " ╚═════╝ ",
  ],
  right: [
    " ██████╗ ",
    "██╔═══██╗",
    "██║   ██║",
    "██║   ██║",
    "╚██████╔╝",
    " ╚═════╝ ",
  ],
}

export const marks = "_^~,"
