# Tabletop Simulator Lua (Hub Edition)

> **This is a fork of [rolandostar/tabletopsimulator-lua-vscode](https://github.com/rolandostar/tabletopsimulator-lua-vscode)**
> (last upstream commit 2023-04, inactive for 3.5 years) with the following additions:
>
> - **Hub integration** — connect to a `tts-hub` daemon on port **39997** (TCP fan-out)
>   instead of binding 39998 directly, sharing a single TTS connection with the
>   [tts-toolkit](https://github.com/Smirk1921/tts-toolkit) CLI and any MCP-compatible
>   AI agent. No more "close the official extension first" conflicts.
> - **Dual-mode fallback** — when the hub is offline, either prompt the user to start
>   `tts-hub` (default, `ttslua.hub.fallback: "prompt"`) or temporarily bind 39998
>   like the upstream (`ttslua.hub.fallback: "bind"`).
> - **Updated api.json** — TTS Lua API definitions bumped from 13.2.1.1 to **14.0.3.2**.
> - **Robust script tracking** — `_lastSentScripts` persisted with sha256 checksum;
>   filenames with dots in object names now resolve correctly.
>
> Original plugin by **Rolando Romero**, **onelivesleft**, **OliPro007**, **Berserk Games** (MIT).
> Fork maintained by [Smirk1921](https://github.com/Smirk1921).
>
> Install from [GitHub Releases](https://github.com/Smirk1921/tts-lua-hub/releases)
> (`code --install-extension tts-lua-hub-<version>.vsix`) or — once published — from the
> [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=Smirk1921.tts-lua-hub).

---
## Why this fork exists

The official extension (`rolandostar.tabletopsimulator-lua`) binds TTS's
external-editor port **39998** directly. So does the [tts-toolkit](https://github.com/Smirk1921/tts-toolkit)
CLI when it needs a live connection (`tts pack pull/diff`, `tts test`, `tts push`,
`tts assets`, …). That meant you could only use one of them at a time — close
VSCode to run the CLI, close the CLI to use VSCode.

This fork adds a third mode: connect to a long-running **`tts-hub` daemon**
(from the tts-toolkit repo) on TCP **39997**. The hub is the only process that
owns 39998; the CLI, this extension, and any MCP-compatible AI agent all attach
to the hub as peers. Result: **you can use the CLI and VSCode at the same time,
against the same loaded save, without conflicts.**

## Architecture

```
                 ┌──────────────────────────────┐
                 │  Tabletop Simulator (game)   │
                 │   listens on 39998 / 39999   │
                 └──────────────┬───────────────┘
                                │ (single connection)
                       ┌────────┴────────┐
                       │    tts-hub      │     <- long-running daemon
                       │  (port 39997)   │        (from tts-toolkit repo)
                       └────────┬────────┘
              ┌─────────────────┼─────────────────┐
              │                 │                 │
        ┌─────┴─────┐    ┌──────┴──────┐   ┌──────┴──────┐
        │  tts CLI  │    │ this ext    │   │  MCP agent  │
        │ (pack /   │    │ (you are    │   │ (ZCode /    │
        │  test /…) │    │  here)      │   │  Claude…)   │
        └───────────┘    └─────────────┘   └─────────────┘
```

If `tts-hub` is not running, this extension can fall back to upstream behavior
(bind 39998 directly) — see `ttslua.hub.fallback` below.

## What you need the tts-toolkit CLI for

This extension **does not** require the CLI to function in standalone mode —
everything the upstream extension does, this fork also does (Get/Send Scripts,
Execute Lua, Console++, autocompletion, Go to Error, …).

You **do** want the CLI (and `tts-hub`) if you care about any of these:

| Capability | Where it lives | Why it matters |
|---|---|---|
| Run the hub daemon | `tts-hub` (CLI repo) | enables the coexistence this fork is built for |
| Pack workspace (`unpack / build / push / diff`) | `tts pack …` | edit decks/objects/scripts/UI as plain files, rebuild byte-identical saves |
| Lua test runner inside TTS | `tts test` | run `tests/**/*_test.lua` against a live game, get a structured `RunReport` |
| Deck atlas slicing/stitching | `tts deck …` | turn card sheets into TTS atlases (and back) with remainder absorption |
| Git-based version control for packs | `tts vcs …` | semantic diff, LFS for binary assets, upstream sync, review gates |
| Asset import + image hosts | `tts import / host` | bring external images/models into a pack, push to steamcloud / S3 / command hosts |
| Steam Workshop publishing | `tts build / publish` | BSON payload + kpsteam-powered upload + 7-step manual guide |
| MCP server for AI agents | `tts-mcp` | expose 12+ tools (status/exec/pull/diff/push/test/build/…) to any MCP client |

The CLI is the same project that produced this fork — they are designed to work
together. See [tts-toolkit](https://github.com/Smirk1921/tts-toolkit) for full
CLI documentation.

## Installation

### Option A — VSIX from GitHub Releases (recommended for now)

1. Download `tts-lua-hub-<version>.vsix` from
   [Releases](https://github.com/Smirk1921/tts-lua-hub/releases).
2. In VSCode: `Ctrl+Shift+P` → `Extensions: Install from VSIX...` → pick the file.
   Or from a terminal:
   ```bash
   code --install-extension tts-lua-hub-<version>.vsix
   ```
3. **Uninstall or disable the official "Tabletop Simulator Lua" extension**
   (`rolandostar.tabletopsimulator-lua`). Only one of them can be active —
   they register the same commands and would otherwise conflict.

### Option B — VSCode Marketplace (coming soon)

Will be published as `Smirk1921.tts-lua-hub` once Marketplace registration
completes. Track [issue #1](https://github.com/Smirk1921/tts-lua-hub/issues)
for status.

## Configuration

In VSCode `settings.json` (user or workspace):

```jsonc
{
  "ttslua.hub.host": "127.0.0.1",
  "ttslua.hub.port": 39997,
  "ttslua.hub.fallback": "prompt",       // or "bind"
  "ttslua.hub.reconnectMaxMs": 30000
}
```

| Setting | Values | Effect |
|---|---|---|
| `ttslua.hub.host` / `ttslua.hub.port` | default `127.0.0.1:39997` | where the `tts-hub` daemon listens |
| `ttslua.hub.fallback` | `"prompt"` (default) | only connect via hub; show a status-bar hint when the hub is offline |
|  | `"bind"` | probe 39998 for 500 ms; if the hub is unreachable, bind 39998 directly like the upstream extension |
| `ttslua.hub.reconnectMaxMs` | default `30000` | max backoff between reconnect attempts (100 ms → this cap, exponential) |

All other upstream settings (`ttslua.*`) are unchanged.

## End-to-end quick start (this extension + tts-toolkit CLI)

```bash
# 1. Terminal: clone and build the CLI
git clone https://github.com/Smirk1921/tts-toolkit.git
cd tts-toolkit && npm install && npm run build

# 2. Start Tabletop Simulator and load a save
#    (TTS only listens on 39998/39999 while a save is loaded)

# 3. Start the hub daemon (keep this terminal open)
node dist/cli/hub-main.js
#    or, after `npm install -g tts-toolkit`:  tts-hub

# 4. VSCode: install this fork per Option A above, set
#        "ttslua.hub.fallback": "prompt"
#    then Ctrl+Shift+P → Developer: Reload Window

# 5. Verify coexistence — the extension's status bar shows
#    "Connected to tts-hub". In another terminal you can now run:
node dist/cli/index.js status          # CLI works
node dist/cli/index.js pull --root .   # CLI pulls scripts; extension stays connected
#    …and from VSCode "TTS: Get Scripts" / "TTS: Execute Lua" also work
#    at the same time.
```

## When you don't want the hub

Set `"ttslua.hub.fallback": "bind"` and don't run `tts-hub`. The extension will
behave exactly like the upstream (bind 39998 when it needs a connection). You
just go back to the old rule: close the CLI before using VSCode, and vice versa.

---

## Hub 集成（本 fork 的改动）

本仓库是 [`rolandostar/tabletopsimulator-lua-vscode`](https://github.com/rolandostar/tabletopsimulator-lua-vscode) 的 fork，为 **TTS 图包制作维护工具**适配了它的 `tts-hub` 常驻进程：

- 默认经 hub 的 **39997 TCP 扇出**接收 TTS 推送；出站命令仍直发 TTS 本体 39999。
- hub 不在线时按 `ttslua.hub.fallback` 降级：
  - `prompt`（默认）：只连 hub，连不上时状态栏提示「请运行 tts-hub」；
  - `bind`：临时绑 39998 监听 TTS（与 CLI 独立模式同策略）。
- 连接配置（`ttslua.hub.host` / `port` / `fallback` / `reconnectMaxMs`）与完整说明见 [`../docs/editor.md`](../docs/editor.md) 的「VSCode 插件（深度层）」章节。
- 原版功能保留：Console++ 集成 / Lua 与 XML 自动补全 / 错误跳转（Go to Error）/ Execute Lua / Get-Send Scripts。

---

## Upstream README

The content below is preserved verbatim from the original
[rolandostar/tabletopsimulator-lua-vscode](https://github.com/rolandostar/tabletopsimulator-lua-vscode)
README for reference. Some links, badges and the sponsor section point to the
upstream author's accounts and are kept here for attribution; they do **not**
represent this fork.

<div align="center">
<h2>Tabletop Simulator Lua Extension for VSCode</h2>
<br>
<img width="500" src="https://raw.githubusercontent.com/rolandostar/tabletopsimulator-lua-vscode/main/media/docs/banner.png" alt="VSCode-TabletopSimulator-Lua">
<br>
<br>
</div>

<p align="center" color="#6a737d">
Extension for VSCode to make writing Lua scripts for  <a href="https://store.steampowered.com/app/286160/Tabletop_Simulator/">Tabletop Simulator</a> easier.
</p>

<div align="center">
<img src="https://badgen.net/badge/uses/TS/blue"/>
<img src="https://badgen.net/badge/designed in/MS Paint/yellow"/>
<img src="https://badgen.net/badge/made%20with/%E2%9D%A4/red"/>
</div>

## Features

- Get/Send Scripts
- <img src="media/docs/new.png" width="80"/> Execute Lua without Save & Play
- <img src="media/docs/new.png" width="80"/> Improved Code autocompletion for Lua
  - Smart `GUID` suggestions which scans your save file, it even detects newly-created objects.
  - Update to latest available TTS API without waiting for manual updates. ([Learn More](here))
- <img src="media/docs/new.png" width="80"/> Added Code autocompletion for XML!
- <img src="media/docs/new.png" width="80"/> Added Version Control Support, you can now more easily use Git to manage your scripts!
- <img src="media/docs/new.png" width="80"/> Hover over a `GUID` in VSCode to Highlight the object In-Game
- Nested file support
  - `require("")` for Lua
  - `<Include src=""/>` for XML
  - Configurable search patterns and lookup directories (yes, plural)
  - Works with absolute directories, perfect for source controlled projects
  - <img src="media/docs/new.png" width="80"/> Debug module resolution issues right in VSCode (Never again wonder why your file isn't reachable)
- <img src="media/docs/new.png" width="80"/> Improved Configuration (Made them clearer and categorized)
- Built-in Console
  - Integration with [Console++](https://github.com/onelivesleft/Console) by onelivesleft ([Tutorial](http://blog.onelivesleft.com/2017/09/debugging-your-tts-mods-with-console.html)) with Automatic Installation!
  - Send commands from VSCode (Adds `onExternalCommand`)
  - Receive output and debug information on VSCode Panel
  - BBCode and nested colors support!
- <img src="media/docs/new.png" width="80"/> Improved and extensive documentation available at [tts-vscode.rolandostar.com](tts-vscode.rolandostar.com)
  - Learn how to use version control, step-by-step debugging, and more!
- <img src="media/docs/new.png" width="80"/> Added an experimental asset downloader, which helps you download and rehost assets via Github

<br/>

![Demo Reel](https://raw.githubusercontent.com/rolandostar/tabletopsimulator-lua-vscode/main/media/docs/demo.gif)

---

## [Installation & Usage](https://tts-vscode.rolandostar.com/extension/setup)

## Additional Documentation

- [Extension Configurations](https://tts-vscode.rolandostar.com/extension/configuration)
- [Extension Commands](https://tts-vscode.rolandostar.com/extension/commands)
- [Module Resolution (AKA Nested Files)]()
- [Console++]()

## Release Notes

Check [CHANGELOG.md](https://github.com/rolandostar/tabletopsimulator-lua-vscode/blob/main/CHANGELOG.md)

## About

This project was motivated on trying out different solutions to communicate VSCode with TTS and being rather unsuccessful at that. I tried using [OliPro007's Extension](https://github.com/OliPro007/tabletopsimulator-lua-vscode) and was a bit finicky for me, I also checked out [dustinlacewell's vatts](https://github.com/dustinlacewell/vatts) and was able to retrieve scripts but not send them. I guess I'm just inexperienced setting up these extensions which is why I wanted to dive into it by making my own and hoped to streamline the process for someone else.

I kind of ended up doing my own thing.

If you have any suggestions feel free to contact me or submit a PR.

<div align="center">
<h2>Contact</h2>
<p>You can find me on <a href="http://steamcommunity.com/id/rolandostar/">Steam</a> and <a href="https://www.reddit.com/user/rolandostar">Reddit</a>!</p>
<p>If you like this extension, please consider a small donation.</p>
<a href="https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=7PK5YQ9HR3Z52"><img src="https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif" border="0" name="submit" title="PayPal - The safer, easier way to pay online!" alt="Donate with PayPal button"/></a>
</div>
