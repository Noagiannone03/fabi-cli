// Wordmark Fabi — version slim 3 lignes pour casser le look "opencode" du
// gros bloc 6 lignes. Le split left/right est intentionnel : `Logo()` rend
// `left` en `theme.textMuted` et `right` en `theme.text` (brand color via
// composition), ce qui donne un dégradé "fa" plus discret → "bi" éclatant.
//
// Si tu modifies, n'utilise QUE des caractères spaces ou block Unicode
// (▀ ▄ █). Les marqueurs `_ ^ ~ ,` sont réservés au système d'ombrage de
// `component/logo.tsx` et changeraient le rendu de la lumière.

export const logo = {
  left: [
    "█▀▀ ▄▀█ ",
    "█▀  █▀█ ",
    "▀   ▀ ▀ ",
  ],
  right: [
    "█▀▄ █",
    "█▀▄ █",
    "▀▀  ▀",
  ],
}

// Petit wordmark `go` — utilisé par `GoLogo` pour la transition logo→go.
// On garde le même esprit slim mais sur 3 lignes pour matcher la nouvelle
// hauteur de `logo`.
export const go = {
  left: [
    "▄▀█ ",
    "█▀█ ",
    "▀ ▀ ",
  ],
  right: [
    "█▀█",
    "█ █",
    "▀▀▀",
  ],
}

export const marks = "_^~,"
