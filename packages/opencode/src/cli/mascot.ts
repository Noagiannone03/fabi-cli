// Mascotte Bibi — la loutre Fabi.
//
// Pixel art 22 colonnes × 16 lignes. Chaque caractère = 1 pixel.
// Rendu via sub-pixel blocks (`▀` avec fg = pixel haut, bg = pixel bas) →
// 16 lignes pixel = 8 lignes terminal. Voir `component/mascot.tsx`.
//
// Légende palette :
//   .  transparent (skip)
//   1  noir            yeux (contour) + truffe
//   2  brun foncé      contour corps / dos
//   3  brun moyen      transitions
//   4  beige clair     ventre
//   5  blanc           highlight yeux
//   6  rose            museau
//   7  orange brand    accent (réservé futur — coquillage)
//   8  bleu brand      accent (réservé futur — eau)

export const mascotPalette: Record<string, string | null> = {
  ".": null,
  "1": "#000000",
  "2": "#5C3A21",
  "3": "#8B5A3C",
  "4": "#E8B788",
  "5": "#FFFFFF",
  "6": "#FFB5C5",
  "7": "#EC5B2B",
  "8": "#3D8AFF",
}

// Loutre debout, joyeuse, qui salue avec la patte droite levée.
// Vue de face, style chibi. Les "23" en haut-droite forment la patte qui salue.
export const mascot: readonly string[] = [
  "........2222222.......",
  ".......223333322......",
  "......23311223311232..",
  "......23315523315232..",
  "......23333666333322..",
  "......23332661322322..",
  "......23332112333222..",
  "......22333333333222..",
  ".....2233333333322....",
  ".....2334444444433....",
  "....23344444444443....",
  "....23444444444443....",
  "....23444444444443....",
  "....23344444444433....",
  ".....22344444444322...",
  ".....22222222222222...",
]
