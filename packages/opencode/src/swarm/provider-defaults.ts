// Provider Fabi prêt à être mergé dans la config par défaut.
//
// L'idée : zéro config requise pour l'utilisateur final. Au boot, on injecte
// ce provider dans la config pour que `fabi/Qwen/Qwen3-Coder-30B-A3B-Instruct`
// soit dispo et soit le modèle par défaut.
//
// L'utilisateur peut toujours :
//   - changer son modèle (config user surcharge)
//   - désactiver Fabi (`disabled_providers: ["fabi"]`)
//   - ajouter d'autres providers sans casser celui-ci

import { getAccountToken } from "./account-token"
import { SWARM_DEFAULTS, SWARM_PROVIDER_ID } from "./defaults"

export interface SwarmProviderOverrides {
  /** URL HTTP du scheduler (avec ou sans trailing slash, sera normalisée). */
  schedulerUrl?: string
  /** ID du modèle exposé par le scheduler. */
  modelId?: string
  /** Fenêtre publiée par le registry; 64k tant qu'elle est inconnue. */
  maxContextTokens?: number
}

/**
 * Construit le bloc provider Fabi à merger dans la config runtime.
 *
 * Format = celui attendu pour un provider OpenAI-compatible :
 * `npm: "@ai-sdk/openai-compatible"`, `api: "<scheduler>/v1"`, `models: { ... }`.
 */
export function buildSwarmProvider(overrides: SwarmProviderOverrides = {}) {
  const schedulerUrl = (overrides.schedulerUrl ?? SWARM_DEFAULTS.scheduler).replace(/\/+$/, "")
  const modelId = overrides.modelId ?? SWARM_DEFAULTS.model
  const context = overrides.maxContextTokens && overrides.maxContextTokens > 0
    ? overrides.maxContextTokens
    : 65536

  return {
    id: SWARM_PROVIDER_ID,
    name: "Fabi Swarm",
    npm: "@ai-sdk/openai-compatible",
    api: `${schedulerUrl}/v1`,
    options: {
      // Jeton de compte = apiKey : la porte de contribution n'autorise la
      // consommation que si ce compte a un worker actif. Même jeton que celui
      // passé au worker (cf. account-token.ts) → « tu contribues = tu consommes ».
      apiKey: getAccountToken(),
      timeout: SWARM_DEFAULTS.inferenceTimeoutMs,
      chunkTimeout: SWARM_DEFAULTS.inferenceChunkTimeoutMs,
    },
    models: {
      [modelId]: {
        id: modelId,
        name: `${modelId.split("/").pop() ?? modelId} — via Fabi swarm`,
        family: "qwen",
        tool_call: true,
        reasoning: false,
        temperature: true,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context, output: Math.min(8192, context) },
      },
    },
  } as const
}

/** Modèle par défaut au format provider/model attendu par le runtime. */
export function buildDefaultModelRef(overrides: SwarmProviderOverrides = {}): string {
  const modelId = overrides.modelId ?? SWARM_DEFAULTS.model
  return `${SWARM_PROVIDER_ID}/${modelId}`
}
