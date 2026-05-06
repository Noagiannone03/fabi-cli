// Mascotte Bibi — tête de renard chibi.
//
// Pixel art 14 colonnes × 12 lignes. Chaque caractère = 1 pixel.
// Rendu via sub-pixel blocks (`▀` avec fg = pixel haut, bg = pixel bas) →
// 12 lignes pixel = 6 lignes terminal. Voir `component/mascot.tsx`.
//
// Design : oreilles dressées séparées par un gap, dôme du crâne arrondi
// qui apparaît dès la rangée 3 (transition douce ear→head, top de tête
// effilé sur les côtés). Yeux centrés avec highlight blanc.
//
// Palette (5 couleurs + transparent), pensée pour matcher le brand orange :
//   .  transparent
//   1  noir            yeux (pupille), truffe, bouche
//   2  orange foncé    oreilles extérieur, contour tête
//   3  orange brand    tête principale (#EC5B2B = couleur Fabi)
//   4  crème           cheek, intérieur oreilles, museau
//   5  blanc           highlight des yeux

export const mascotPalette: Record<string, string | null> = {
  ".": null,
  "1": "#000000",
  "2": "#A03A18",
  "3": "#EC5B2B",
  "4": "#F5E6D3",
  "5": "#FFFFFF",
}

export const mascot: readonly string[] = [
  ".2..........2.",
  ".22........22.",
  ".242......242.",
  "22433333333422",
  ".233333333332.",
  ".233351331532.",
  ".233311331132.",
  ".233344334432.",
  ".233344114432.",
  ".233344444432.",
  "..2334444332..",
  "...23344332...",
]
