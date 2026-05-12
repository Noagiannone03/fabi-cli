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
 * Renvoie un getter qui cycle à travers `words` toutes les `intervalMs`.
 * L'index repart à 0 en boucle. Premier mot affiché immédiatement (pas
 * d'attente d'un tick avant le premier rendu).
 */
export function useCyclingWord(words: readonly string[], intervalMs: number = 2200): () => string {
  const [i, setI] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | null = null

  onMount(() => {
    if (words.length <= 1) return
    timer = setInterval(() => {
      setI((v) => (v + 1) % words.length)
    }, intervalMs)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  return () => words[i()] ?? words[0] ?? ""
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
