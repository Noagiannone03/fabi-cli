// Mascotte Bibi — tête de renard chibi.
//
// Pixel art 14 colonnes × 12 lignes. Chaque caractère = 1 pixel.
// Rendu via sub-pixel blocks (`▀` avec fg = pixel haut, bg = pixel bas) →
// 12 lignes pixel = 6 lignes terminal. Voir `component/mascot.tsx`.
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

// Tête de renard, oreilles dressées, regard vers le devant, bouche fermée.
export const mascot: readonly string[] = [
  ".2..........2.",
  ".22........22.",
  ".242......242.",
  "2244......4422",
  "23335133153332",
  "23331133113332",
  "23334433443332",
  "23334411443332",
  "23344411443332",
  ".233444444332.",
  "..23344433322.",
  "...23333322...",
]
