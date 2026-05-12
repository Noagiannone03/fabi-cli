// Hooks de "texte qui bouge" pour habiller les états de chargement.
//
// Deux primitives :
//   - useCyclingWord(words, intervalMs)  → renvoie le mot courant qui change
//   - useAnimatedDots(intervalMs, max)   → renvoie une chaine "." → ".." → "..."
//
// Pourquoi ces deux hooks plutôt qu'un seul composant tout-en-un :
//   - Le SwarmGate veut "Downloading model..." avec mot ET dots.
//   - Le chat indicator au-dessus du prompt veut "Generating..." avec dots seuls.
//   - Découpler permet de composer librement sans dupliquer la logique d'interval.

import { createSignal, onCleanup, onMount } from "solid-js"

/**
 * Renvoie un getter qui cycle à travers les mots toutes les `intervalMs`.
 *
 * Accepte SOIT un tableau statique, SOIT un getter (() => liste). Avec un
 * getter, on relit la liste à chaque tick — utile pour cycler sur une
 * liste qui dépend de l'état réactif (ex: phase de chargement courante).
 *
 * L'index repart à 0 en boucle. Premier mot affiché immédiatement.
 */
export function useCyclingWord(
  words: readonly string[] | (() => readonly string[]),
  intervalMs: number = 2200,
): () => string {
  const getter: () => readonly string[] = typeof words === "function" ? words : () => words
  const [i, setI] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | null = null

  onMount(() => {
    timer = setInterval(() => {
      const list = getter()
      if (list.length <= 1) return
      setI((v) => (v + 1) % list.length)
    }, intervalMs)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return () => {
    const list = getter()
    if (list.length === 0) return ""
    return list[i() % list.length] ?? list[0]!
  }
}

/**
 * Renvoie un getter qui anime "" → "." → ".." → "..." → "" en boucle.
 *
 * Utilisé pour montrer une activité subtile sous un texte fixe ("Generating",
 * "Downloading"…). Plus discret qu'un spinner et joue bien avec le terminal
 * (pas de flicker dû au repaint d'un caractère unicode).
 */
export function useAnimatedDots(intervalMs: number = 450, maxDots: number = 3): () => string {
  const [n, setN] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | null = null

  onMount(() => {
    timer = setInterval(() => {
      setN((v) => (v + 1) % (maxDots + 1))
    }, intervalMs)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return () => ".".repeat(n())
}

/**
 * Renvoie un getter qui compte les secondes écoulées depuis que `active()`
 * est passé à `true`. Reset automatique quand `active()` repasse à `false`.
 *
 * Usage typique : afficher le temps que dure un état de chargement, et
 * reset le compteur dès qu'on en sort (pour ne pas afficher "5m" si l'user
 * a juste eu un re-trigger après une période de succès).
 */
export function useElapsedSeconds(active: () => boolean): () => number {
  const [seconds, setSeconds] = createSignal(0)
  let startedAt: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    startedAt = null
    setSeconds(0)
  }

  // createEffect ferait l'affaire mais on évite l'import pour rester
  // self-contained. On utilise un check manuel à chaque tick d'animation.
  // En pratique le composant qui appelle ce hook se re-render au change-
  // ment de `active()`, donc cette astuce suffit.
  onMount(() => {
    const tick = () => {
      const on = active()
      if (on && startedAt === null) {
        startedAt = Date.now()
        setSeconds(0)
      } else if (on && startedAt !== null) {
        setSeconds(Math.floor((Date.now() - startedAt) / 1000))
      } else if (!on && startedAt !== null) {
        stop()
      }
    }
    timer = setInterval(tick, 500) // 500ms : compromis fluidité / CPU
    tick() // tick immédiat pour ne pas attendre 500ms au premier rendu
  })

  onCleanup(stop)

  return seconds
}

/**
 * Format "Xm Ys" ou "Ys" selon la durée. Pas d'heure : on n'attend pas
 * qu'un chargement dure plus d'1h, et au-delà l'UX devra de toute façon
 * proposer de relancer.
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}
