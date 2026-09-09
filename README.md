# Pixel Agents for GitHub Copilot CLI

An unofficial fork of [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)
with GitHub Copilot CLI integration.

View your Copilot CLI sessions as animated characters in a pixel-art office,
in a browser or inside VS Code. This fork adds cross-directory session discovery,
live tool activity, recent request and response previews, and separate characters
for delegated agents. Context usage is displayed when reported by the CLI.
The original office renderer, layout editor, furniture and pets are retained.

**Build this fork from source to use the Copilot integration.** The upstream npm
package and Marketplace extension are not releases of this fork. See the
[compatibility notes](#compatibility-and-limits) for platform support; native
browser terminal controls are Windows-only.
This is not an official GitHub or Microsoft release.

[Build and run](#build-and-run) · [VS Code setup](#vs-code-copilot-office) ·
[Compatibility](#compatibility-and-limits) · [Upstream project](#upstream-project)

## GitHub Copilot CLI edition

This checkout adds a **Copilot CLI office**. Its monitoring is read-only and adopts already-open
sessions from the current user's `~/.copilot/session-state/`, including sessions
started in other terminals and working directories. Claude Code is not required
in this mode, and neither Copilot nor Claude settings are modified.
Its agent/seat state uses `~/.pixel-agents/copilot-state.json`, separate from
the upstream Claude office's `standalone-state.json`.

### Build and run

Clone this fork to any directory, enter its repository root, and use Node.js 22
(the version in `.nvmrc`). Install and authenticate GitHub Copilot CLI separately.

```sh
npm ci
npm run build
node dist/cli.js --copilot --watch-all-sessions --no-reuse
```

The server prints a local URL. Keep the terminal running; Ctrl+C stops the
office, not your Copilot sessions. From another directory, invoke the built
`dist/cli.js` with its full path. There is no required drive or checkout name.

On **Windows**, an optional PowerShell launcher is available after building.
Run this from the repository root:

```powershell
.\start-copilot-office.ps1
```

The Windows launcher resolves files relative to itself. It opens the private
control URL, starts on port 56276 with terminal controls, and reuses an
already-running compatible office without creating another server. Keep the
console open when it owns the server. Use `-NoBrowser` to print the URL without
opening an external browser, or `-Port` to select another port:

```powershell
.\start-copilot-office.ps1 -Port 3100
```

Use this built checkout, **not** `npx pixel-agents`, which downloads the upstream
release without this modification. The PowerShell launcher is a source-checkout
convenience, not part of the npm package's current file allowlist.

### Compatibility and limits

| Component                         | Support                                                                                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser office and session reader | Node-based, uses the current user's home directory. Windows is the exercised environment; macOS/Linux support is not yet verified for this fork.                                                                      |
| Optional PowerShell launcher      | Windows only: uses `powershell.exe`, `USERPROFILE` and Windows process discovery.                                                                                                                                     |
| Browser native terminal actions   | Windows only, opt-in for the Node command. Omit `--terminal-controls` on other OSes.                                                                                                                                  |
| VS Code adapter                   | Requires VS Code 1.105+ and Copilot CLI on the integrated terminal's PATH. Windows is the exercised environment. Remote/WSL windows read sessions on the extension host, not automatically on the local Windows host. |
| Copilot format                    | Developed against Copilot CLI 1.0.83 session files; see the file contract below. Not a guarantee for all older/future CLI releases.                                                                                   |

The reader expects `~/.copilot/session-state/<session-id>/workspace.yaml`,
`events.jsonl`, and a live `inuse.<pid>.lock` containing the same PID as its name.
It reads activity such as `tool.execution_start`, `tool.execution_complete`,
`assistant.message`, and `subagent.*`. This is an on-disk format dependency, not
a stable public API. Missing lifecycle records can leave status conservatively
active; missing context records produce "not reported", never a guessed percentage.
Session discovery currently uses the default home location; alternate Copilot
storage roots are not exposed as a launcher option.

Each live session has a character, its Copilot session title, and its project
folder. Reading, tool execution, thinking, completion, and explicit input/approval
requests update from the local event log. Process-backed `inuse.<pid>.lock` files
identify open sessions: idle-but-open sessions remain visible; historical sessions
and stale locks are excluded. Polling updates approximately once a second.
The **Watch All Sessions** setting controls cross-directory visibility;
without `--watch-all-sessions`, discovery starts scoped to the launch directory.
The launcher enables cross-directory visibility on each start.
Personal Skills and machine-specific shortcuts are intentionally not distributed.
No Skill registration is required to run the public launcher.

Hover a character for a concise description of its current action (file name,
search query, or command description). **Click a character**, or use **Sessions**
at the top right, to open its live details: full working directory, current tool
targets and commands, latest request and assistant response, and the last eight
completed actions with success/failure status. Parallel tool calls appear separately.
These details also reload when the browser reconnects.

Message and tool-input previews are bounded to 2,000 characters per field; longer
previews are marked as truncated. Model internals, reasoning, tool results, and
full conversation history are not displayed. **The office now contains local
conversation excerpts and command text**; leave it bound to `127.0.0.1` and do not
expose it to an untrusted network. Nothing is uploaded to an external service.

Named delegated workers appear as teammates with their own seats and details;
unnamed helpers appear as sub-agent characters near their parent. Background work
survives the parent's completed turn and disappears when Copilot reports completion.
Nested child events are routed independently rather than shown as the parent's tools.
Some CLI integrations buffer child events until completion: in that case the office
shows the known task and running state, not fabricated live tool activity.

Context gauges use Copilot's `session.usage_info` occupancy/window values or
reported token usage for the matching main model and its declared context window.
Cached prompt tokens are counted once; billing totals and helper-model calls are
never used as context occupancy. **Some CLI sessions do not write these metrics**
(including some hosted-model paths). They explicitly show "not reported" instead
of a guessed percentage. Reported compaction/model changes reset stale readings.

### Native terminals (Windows browser office)

The PowerShell launcher enables **+ Agent**, **Open session in terminal**, and
**Focus terminal** by default. When launching `node dist/cli.js` directly, pass
`--terminal-controls` to enable them:

```powershell
node .\dist\cli.js --copilot --watch-all-sessions --terminal-controls --no-reuse
```

Open the **private `?token=` URL printed by the launcher** to use these controls.
The bare URL is still a read-only viewer. Every launch requires an explicit click,
starts interactive Copilot without an automatic prompt, and never enables
permission bypass. Opening an existing session uses Copilot's `--session-id`
resume/attach behavior. Native focus is limited to terminal windows opened by
this running office that Windows exposes as focusable; arbitrary pre-existing
Windows Terminal tabs cannot be reliably selected. Unsupported focus is reported
as an error rather than opening another session silently. Use the VS Code adapter
for exact focus of terminals it owns.

Dismissing a character hides it from the office; it does not terminate an external
Copilot process or approve tools. The integration targets local Copilot **CLI**
sessions, not VS Code Copilot Chat, cloud sessions, or another machine. It reads
Copilot's current on-disk format; format changes may require an update.
The upstream Claude integration remains available when `--copilot` is omitted.

### VS Code Copilot office

Build an installable VSIX from this checkout:

```sh
npm exec --yes --package @vscode/vsce -- vsce package --no-dependencies --out pixel-agents-copilot.vsix
code --install-extension pixel-agents-copilot.vsix
```

Then open
`pixel-agents-copilot.code-workspace` for the Copilot office with cross-directory
visibility. The workspace changes only its own Pixel Agents settings, not your
global editor configuration.

In any other window, run **Pixel Agents: Start Copilot Office** from the command
palette. That explicit command selects Copilot globally and reloads the window;
the default provider remains Claude until selected. Alternatively set
`pixel-agents.agentProvider` to `copilot` and reload. **+ Agent** launches an
interactive Copilot CLI terminal in the selected workspace folder. Characters
launched by this adapter focus their exact terminal when clicked. Externally
started sessions show details without being silently relaunched; use **Open session
in terminal** to attach explicitly. No Claude hooks are installed in Copilot mode.

VS Code must be 1.105 or newer. Copilot CLI must be installed, on the terminal's
PATH, and authenticated. Copilot Chat's own conversation history is a separate
integration and is not read by this CLI provider.

### Optional layout and local customizations

The [generic four-room studio](examples/layouts/README.md) uses bundled furniture
and neutral room names. Import it explicitly and map your own folders through
**Layout > Areas**. It is not installed automatically.

Personal layouts, folder mappings, fixed-path Skills and layout-install helpers
are ignored by Git in this checkout. They are not runtime/build dependencies.
Use `local/` for additional private variants. The active office configuration,
seats, tokens and session data remain in your home directory; do not copy them
into source control. Screenshots can contain private conversation excerpts.

### Source fork versus package publication

The package name, publisher and original release workflows still identify upstream
`pixel-agents` / `pablodelucca.pixel-agents`. Installing this VSIX replaces an
extension with that same ID. **Do not treat the upstream publishing workflow as
ready to publish a separate product.** Before enabling release publishing, select
your own npm scope/extension publisher and configure the workflow accordingly.
Keep the upstream license and asset credits.

## Upstream project

The following sections and links describe the original Pixel Agents project,
its Claude integration and its releases, not this fork's distribution.

<p align="center">
  <a href="https://github.com/pixel-agents-hq/pixel-agents">
    <img src="webview-ui/public/banner.png" alt="Original Pixel Agents project">
  </a>
</p>

[Upstream releases](https://github.com/pixel-agents-hq/pixel-agents/releases) ·
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) ·
[Open VSX](https://open-vsx.org/extension/pablodelucca/pixel-agents) ·
[npm](https://www.npmjs.com/package/pixel-agents) ·
[Discussions](https://github.com/pixel-agents-hq/pixel-agents/discussions) ·
[Discord](https://discord.gg/Yk7jXebv9H)

Pixel Agents turns the AI coding agents running in your terminals into animated
pixel-art characters working in a tiny office. They walk to their desks, sit down,
type when they're editing files, read when they're searching, and flag you visually
when they're stuck waiting for input.

It ships in two forms from the same codebase:

- **VS Code extension** — [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) and [Open VSX](https://open-vsx.org/extension/pablodelucca/pixel-agents). Agents launch into VS Code terminals; characters render in the panel area.
- **Standalone CLI** — `npx pixel-agents` starts a local server and serves the same office as a browser app, useful for tmux, remote, and non-VS Code workflows.

The architecture is fully agent-agnostic and editor-agnostic: a typed `HookProvider` interface defines the integration boundary so adding a new AI tool is a single subdirectory of code. Claude Code is the reference implementation today; Codex, Gemini, Cursor, and others are on the roadmap.

![Pixel Agents screenshot](webview-ui/public/office.png)

## Features

- **One agent, one character** — every Claude Code terminal gets its own animated character
- **Live activity tracking** — characters animate based on what the agent is actually doing (writing, reading, running commands)
- **Office layout editor** — design your office with floors, walls, and furniture using a built-in editor
- **Speech bubbles** — visual indicators when an agent is waiting for input or awaiting permission
- **Sound notifications** — optional chimes when an agent finishes its turn or requests permission
- **Sub-agents and Agent Teams** — see ephemeral sub-agents and persistent Claude teammates as separate characters, including team roles and lifecycle changes
- **Persistent layouts** — your office design is saved and shared across VS Code windows
- **Shared layout and assets** — import/export layouts and load external character, pet, and furniture packs
- **Areas** — paint named areas onto the office, map workspace folders to them, and new agents sit inside the areas mapped to their folder
- **Diverse characters** — 6 diverse characters. These are based on the amazing work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Where This Is Going

The vision is: play a game, build a product. Two goals follow from it: to build a familiar, intuitive interface for running and orchestrating a lot of agents; and to make the hours you spend doing it feel less like administration and more like play.

Roughly three stages get there:

1. **Everywhere, with everything.** Today it's Claude Code in VS Code or the browser. It should be whatever agent you run, wherever you work. A new CLI is a subdirectory, not a rewrite — this is where help is most useful right now.
2. **Actually a game.** Health bars for rate limits and token budgets. Scores for whatever you care about. Furniture that _does_ things. Offices you open like save files, one per project.
3. **Expand the orchestration frontier.** Orchestrator characters. Form a team by dragging a box around them. Hand work between agents. Point them at a board and let them pick up tasks themselves.

Most of this is still ahead. See [Issues](https://github.com/pixel-agents-hq/pixel-agents/issues) and [Discussions](https://github.com/pixel-agents-hq/pixel-agents/discussions) for what's open, and [CONTRIBUTING.md](CONTRIBUTING.md) to jump in.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured
- **VS Code extension:** VS Code 1.105.0 or later
- **Standalone CLI:** Node.js 20 or later
- Windows, Linux, or macOS

## Getting Started

### VS Code extension

1. Install Pixel Agents from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) or [Open VSX](https://open-vsx.org/extension/pablodelucca/pixel-agents).
2. Open the **Pixel Agents** panel beside the terminal.
3. Click **+ Agent** to launch Claude Code. In a multi-root workspace, select the folder first.

To use Claude with `--dangerously-skip-permissions`, hover over **+ Agent** to find the **Skip permissions mode** button. Only use this when you accept the security implications.

Pixel Agents also detects Claude sessions started outside the extension. Turn on **Settings → Watch All Sessions** to include sessions from other workspaces.

### Standalone CLI

Run Pixel Agents from the workspace whose Claude sessions you want to see:

```bash
cd /path/to/your/project
npx pixel-agents
```

The CLI chooses a free local port and prints the URL. Standalone does not launch Claude for you; start Claude Code in a terminal for the same workspace. To install the command globally instead:

```bash
npm install --global pixel-agents
pixel-agents
```

Use a fixed address or port when needed:

```bash
pixel-agents --port 3100
pixel-agents --host 127.0.0.1 --port 3100
pixel-agents --help
```

The default bind address is `127.0.0.1`. Binding to `0.0.0.0` exposes the UI and WebSocket to the local network; do this only on a trusted network.

Open the URL the CLI prints - it carries a `?token=` for this session. Any browser can watch the office without it, but installing or removing hooks (which edits your agent tool's own settings file, like the `~/.claude/settings.json`) is only offered to a session that has the token, so an untokened client on the network cannot approve it. Open the bare address instead and the hooks toggle in Settings is refused, and reports the actual install state rather than appearing to work.

Treat that URL as a secret: the token is a bearer capability, not proof of being local. Whoever holds it can approve the hook install from anywhere the server is reachable — so don't paste the URL into a shared channel, and note that it also lands in your browser history and (unredacted) in the server's own request log.

Pass `--no-terminal` to disable the embedded terminal — watch agents without launching or attaching to them from the browser.

### Running the extension and standalone together

The extension and standalone CLI can run at the same time. Each server registers under `~/.pixel-agents/servers/`; the hook script sends events to all active registrations. VS Code and standalone keep separate agents, seats, and settings while using the shared office layout.

Stop a standalone server with **Ctrl+C**. It removes only its own registration.

## Customizing the Office

Click **Layout** to edit the office:

- Paint floor patterns and walls, with color and contrast controls.
- Place, rotate, recolor, select, and remove furniture.
- Paint auto-tiling carpets and customize their main and accent colors.
- Add animated pets; click a pet in the office to interact with it.
- Create named **Areas**, paint their tiles, and assign workspace folders to them.
- Undo/redo changes, then import or export the complete layout as JSON.

Layouts can grow to 64×64 tiles by clicking the ghost border outside the current grid.

### Office assets

Bundled furniture, floors, walls, carpets, characters, and pets live under `webview-ui/public/assets/`. Furniture manifests describe sprites, rotation groups, state groups, and animation frames.

Use **Settings → Add Asset Directory** to load external characters, pets, and furniture. See [docs/external-assets.md](docs/external-assets.md) for furniture directory structure and manifest details. The visual asset manager at `scripts/asset-manager.html` helps create furniture manifests.

## How It Works

Pixel Agents uses two Claude Code detection paths:

- **Hooks mode** (default) — a hook script receives Claude events such as `SessionStart`, `PreToolUse`, `PermissionRequest`, and `Stop`. It discovers active Pixel Agents servers and sends authenticated events to each one.
- **Heuristic mode** (fallback) — when hooks are unavailable, the runtime infers agent status by scanning Claude's JSONL session transcripts under `~/.claude/projects/`. Transcripts are also read in hooks mode for details not present in an event.

The Claude provider normalizes both sources into a shared `AgentEvent` model. `AgentRuntime` updates the central state store, and the active transport sends typed messages to the React webview. The office renders through Canvas 2D with pathfinding and character state machines.

Pixel Agents does not modify Claude Code. Its hook configuration and persistent data live under `~/.claude/` and `~/.pixel-agents/` respectively.

### Architecture

- **`core/`** — provider, adapter, transport, schema, and AsyncAPI message contracts with no runtime side effects.
- **`server/`** — shared Fastify server, agent runtime, persistence, Claude provider, transcript scanning, and standalone CLI.
- **`adapters/vscode/`** — the VS Code adapter: terminal, persistence, and webview bridge.
- **`webview-ui/`** — React 19, Vite, Canvas 2D, and adapter-specific transports for VS Code and browser WebSocket clients.

The extension and CLI are bundled with esbuild; the webview is built with Vite. Unit tests use Vitest and Node's test runner, and end-to-end coverage uses Playwright against VS Code and standalone.

## Development

```bash
git clone https://github.com/pixel-agents-hq/pixel-agents.git
cd pixel-agents
npm install
npm run build
```

Press **F5** in VS Code to launch the Extension Development Host. To run the standalone bundle built from source:

```bash
node dist/cli.js
```

Common checks:

```bash
npm run check-types
npm run lint
npm test
npm run e2e
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [e2e/README.md](e2e/README.md) for the end-to-end suite.

### Hosted Test Reports

Build the combined Allure report locally and stage it for Vercel:

```bash
npm run test
npm run e2e
npm run e2e -- --attach-videos-on-success
npm run vercel:prepare
```

Use `npm run test:report` to build the combined report without preparing the Vercel output, then `npm run test:report:open` to serve it locally.

The staged output serves the combined `e2e`, `server`, and `webview` Allure report at `/reports/allure/`; it does not include a standalone webview preview. GitHub Actions creates a Vercel Preview deployment only for same-repository pull requests targeting `main`. The deploy job expects `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` secrets and skips fork pull requests.

## Troubleshooting

- **Standalone will not start:** verify Node.js 20+, omit `--port` to choose a free port, or select another fixed port.
- **An agent is missing:** confirm **Settings → Instant Detection (Hooks)** is on and that the session belongs to the current workspace. Enable **Watch All Sessions** if needed.
- **The UI looks disconnected:** open **Settings → Debug View** to inspect the server connection, transcript path, and latest agent data.
- **Extension and standalone are both running:** this is supported. Current versions create separate files under `~/.pixel-agents/servers/`; stopping one does not remove the other.

## Community & Contributing

Join the [Discord](https://discord.gg/Yk7jXebv9H) to chat with other users and follow development. Use [Issues](https://github.com/pixel-agents-hq/pixel-agents/issues) to report bugs or request features, and [Discussions](https://github.com/pixel-agents-hq/pixel-agents/discussions) for questions and ideas.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Supporting the Project

<a href="https://github.com/sponsors/pablodelucca">
  <img src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github" alt="GitHub Sponsors">
</a>
<a href="https://ko-fi.com/pablodelucca">
  <img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi" alt="Ko-fi">
</a>

## Star History

<a href="https://www.star-history.com/?repos=pixel-agents-hq%2Fpixel-agents&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&theme=dark&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
 </picture>
</a>

## License

Pixel Agents is available under the [MIT License](LICENSE).
