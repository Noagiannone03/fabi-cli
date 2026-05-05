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

import { SWARM_DEFAULTS, SWARM_PROVIDER_ID } from "./defaults"

export interface SwarmProviderOverrides {
  /** URL HTTP du scheduler (avec ou sans trailing slash, sera normalisée). */
  schedulerUrl?: string
  /** ID du modèle exposé par le scheduler. */
  modelId?: string
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

  return {
    id: SWARM_PROVIDER_ID,
    name: "Fabi Swarm",
    npm: "@ai-sdk/openai-compatible",
    api: `${schedulerUrl}/v1`,
    options: {
      // Le scheduler accepte l'auth ouverte ; le SDK exige une valeur non-vide.
      apiKey: "fabi-no-auth",
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
        limit: { context: 32768, output: 8192 },
      },
    },
  } as const
}

/** Modèle par défaut au format provider/model attendu par le runtime. */
export function buildDefaultModelRef(overrides: SwarmProviderOverrides = {}): string {
  const modelId = overrides.modelId ?? SWARM_DEFAULTS.model
  return `${SWARM_PROVIDER_ID}/${modelId}`
}
