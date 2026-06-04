<h1 align="center">Fabi</h1>
<p align="center">Distributed AI · powered by the swarm.</p>
<p align="center">
  <a href="https://github.com/Noagiannone03/fabi-cli/actions/workflows/release.yml"><img alt="Release status" src="https://img.shields.io/github/actions/workflow/status/Noagiannone03/fabi-cli/release.yml?style=flat-square&label=release" /></a>
</p>

Fabi is an open source agentic CLI that joins a peer-to-peer swarm of distributed
LLM inference. Forked from [opencode](https://github.com/sst/opencode) and made
our own.

---

### Installation

```bash
curl -fsSL https://raw.githubusercontent.com/Noagiannone03/fabi-cli/dev/install | bash
```

Install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/Noagiannone03/fabi-cli/dev/install | bash -s -- --version 0.1.0
```

Once installed, run `fabi` from anywhere:

```bash
fabi          # start Fabi
```

> [!TIP]
> If `fabi` is "command not found" right after install, your current shell
> hasn't picked up the updated `PATH` yet. Open a new terminal, or run the
> `source ...` line the installer printed.

#### Installation Directory

The install script picks the install directory in this priority order:

1. `$FABI_INSTALL_DIR` — custom installation directory
2. `$XDG_BIN_DIR` — XDG Base Directory compliant path
3. `$HOME/.local/bin` — default (usually already on your `PATH`)

```bash
# Examples
FABI_INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/Noagiannone03/fabi-cli/dev/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

### FAQ

#### How is this different from Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. Although we recommend the models we provide through [OpenCode Zen](https://opencode.ai/zen), OpenCode can be used with Claude, OpenAI, Google, or even local models. As models evolve, the gaps between them will close and pricing will drop, so being provider-agnostic is important.
- Built-in opt-in LSP support
- A focus on TUI. OpenCode is built by neovim users and the creators of [terminal.shop](https://terminal.shop); we are going to push the limits of what's possible in the terminal.
- A client/server architecture. This, for example, can allow OpenCode to run on your computer while you drive it remotely from a mobile app, meaning that the TUI frontend is just one of the possible clients.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
