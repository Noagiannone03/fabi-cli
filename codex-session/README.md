# Transfert de session Codex

Ce dossier contient une conversation Codex complète, compressée, pour la reprendre sur un autre PC.

- **Fichier** : `rollout-2026-07-20T09-36-43-019f7e74-...jsonl.gz` (~73 Mo compressé, ~234 Mo décompressé)
- **Session** : `019f7e74-ac4e-7b52-b15b-9e0e3647a19e`
- **Projet** : fabi-IDE / swarm-engine

## Récupérer sur un autre PC

```bash
git checkout dev
git pull
cd codex-session
chmod +x restore.sh && ./restore.sh
```

Le script décompresse le fichier vers `~/.codex/sessions/2026/07/20/` puis affiche la commande de reprise.

Prérequis : Codex CLI installé (`codex --version`), même compte.
