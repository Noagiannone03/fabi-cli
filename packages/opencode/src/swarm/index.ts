// Module swarm Fabi : barrel export.
//
// Le swarm est le moteur d'inférence distribué P2P qui sous-tend Fabi.
// Quand l'utilisateur lance `fabi`, le binaire :
//   1. ping le scheduler Fabi (info)
//   2. spawn un worker Parallax local (= rejoint le swarm comme contributeur)
//   3. lance la TUI / commande
//   4. à l'exit : kill propre du worker (= quitte le swarm)
//
// Voir lifecycle.ts pour l'orchestration ; index.ts (root) pour le branchement
// avec yargs ; config/config.ts pour l'injection du provider par défaut.

export { SWARM_DEFAULTS, SWARM_PROVIDER_ID } from "./defaults"
export type { SwarmDefaults } from "./defaults"
export { checkScheduler } from "./scheduler"
export type { SchedulerInfo } from "./scheduler"
export { spawnWorker } from "./worker"
export type { WorkerHandle, WorkerStatus, SpawnWorkerOptions } from "./worker"
export {
  resolveSwarmRuntime,
  shouldStartSwarm,
  startSwarm,
  switchSwarm,
  armSwarmRuntime,
  shutdownActive,
  shutdownActiveSync,
  SwarmWorkerRequiredError,
} from "./lifecycle"
export type { SwarmRuntime, SwarmHandle, SwarmStartEvent } from "./lifecycle"
export { buildSwarmProvider, buildDefaultModelRef } from "./provider-defaults"
export type { SwarmProviderOverrides } from "./provider-defaults"
export { tryInstallParallax, managedParallaxBin } from "./installer"
export type { InstallResult, InstallFailReason } from "./installer"
export { discoverSwarm, fetchRegistrySwarms } from "./registry"
export type { RegistrySwarm, DiscoverResult, DiscoverOptions } from "./registry"
export { readSwarmPreference, writeSwarmPreference } from "./preference"
export type { SwarmPreference } from "./preference"
export {
  requestSwarmSwitch,
  registerSwarmSwitchHandler,
  planSwarmSwitch,
} from "./control"
export type { SwarmSwitchResult, SwarmSwitchPlan } from "./control"
export { resolveStartupSwarm } from "./startup"
export { planSwarmStartup, isSwarmHealthy, isSwarmUsable, sortByHealth } from "./startup-picker"
export type { StartupPlan, PlanInput } from "./startup-picker"
