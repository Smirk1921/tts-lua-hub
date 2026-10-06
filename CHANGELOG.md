# Change Log

All notable changes to the "tabletopsimulator-lua" extension will be documented in this file.

## [2.0.0-hub.1] — 2026-10-06 (fork: hub integration)

> Fork of [rolandostar/tabletopsimulator-lua-vscode](https://github.com/rolandostar/tabletopsimulator-lua-vscode) @ commit `581f0c2` (last upstream activity 2023-04-07).

### Added — Hub integration

- New `src/transport/` layer:
  - `ITransport` interface (`start/stop/onMessage/send/isConnected`).
  - `JsonStreamDecoder` — brace counter with string/escape state machine (24 unit tests).
  - `ClientTransport` — connects to `tts-hub` daemon on TCP 39997 to receive fan-out;
    outbound commands still go directly to TTS on 39999.
  - `ConnectionStateMachine` — 4-state (disconnected/connecting/connected/reconnecting)
    with exponential backoff 100ms → 30s (20 unit tests).
  - `ServerTransport` — exact upstream behavior preserved (EADDRINUSE dialog).
- `TTSAdapter` refactored to depend on `ITransport`; no longer binds 39998 when
  the hub is reachable.
- Dual-mode fallback via `ttslua.hub.fallback`:
  - `"prompt"` (default) — only try the hub; show a status-bar hint when offline.
  - `"bind"` — probe 39998 for 500ms; fall back to upstream `ServerTransport`
    if hub is unreachable.
- New configuration section `ttslua.hub.{host, port, fallback, reconnectMaxMs}`.
- `_lastSentScripts` persisted via `LocalStorageService` (globalState) with sha256
  checksum for corruption detection.
- Filenames with dots in object names now resolve correctly
  (`/^(.+)\.([^.]+)\.lua$/` — last segment is the guid).
- `transport.isConnected()` guard on outbound paths.
- `api.json` upgraded **13.2.1.1 → 14.0.3.2** (Berserk Games official source,
  byte-level round-trip verified). Original 13.2.1.1 kept as `media/api.json.v13.bak`
  (not shipped in the VSIX).

### Changed

- `package.json` identity fields updated for the fork:
  - `name`: `tabletopsimulator-lua` → `tts-lua-hub`
  - `displayName`: → `Tabletop Simulator Lua (Hub Edition)`
  - `version`: `2.0.0-rc1` → `2.0.0-hub.1`
  - `publisher`: `rolandostar` → `Smirk1921`
  - `repository` / `bugs` / `homepage` / `sponsor` → point at this fork
  - Removed `__metadata` (upstream Marketplace publisherId residue).
- README: added fork declaration at the top (English) and kept the original
  Chinese "Hub 集成" section; upstream README content preserved below for
  attribution.
- LICENSE: appended fork copyright line above the four upstream MIT notices
  (Rolando Romero 2019 / onelivesleft 2017 / OliPro007 2018 / Berserk Games 2015).
- Added `NOTICE.md` explaining the fork relationship and third-party licenses.
- Removed `.github/workflows/deploy-to-marketplace.yaml` (pointed to upstream
  `secrets.VS_MARKETPLACE_TOKEN`, unusable for this fork); kept `build-docs.yaml`.

### Tests

- 56 unit tests passing (JsonStreamDecoder 24 + ClientTransport 14 +
  ConnectionStateMachine 20, minus 2 overlaps).
- `tsc` clean; `webpack --mode development` and `--mode production` clean.
- 9 end-to-end verification scripts against a real `tts-hub` + TTS instance pass.

## [2.0.0] 🎉

- Execute Lua without Save & Play
- Hover over a GUID in VSCode to Highlight the object In-Game
- Added config to debug module resolution
- Changes to configuration items, made them clearer and validate input
- Added API updater for autocompletion
- Rewrote autocompletion completely (heh)
- Added simple autocomplete for XML
- Added HyperScope dependency (To resolve TextMate/WASM issues)
- Improved all informational messages
TODO - Added command history to console++
- Git workspace support
- Added a new documentation site [tts-vscode.rolandostar.com](https://tts-vscode.rolandostar.com/)

## [1.1.4]

- Updated VSCode's extension development environment
- Upped VSCode version
- Temporarily removed autocompletion, it's outdated and it's causing issues with other language providing extensions

## [1.1.3]

- Merged PR adding a "Go To Error" button to Error Messages (Thanks @nabbydude)

## [1.1.2]

- Fixed command mode not triggering on vscode panel

## [1.1.1]

- Fixed bug where installing Console++ would delete entire workspace folder

## [1.1.0]

- Refactored to use Typescript and AirBnB Linting ✨
- Fixed autocompletion and snippets (Thanks Omnium_ and RVycer)
- Added Webpack for faster loading
- Changed extension's language from `.ttslua` to `.lua`
- Added generateSnippets from OliPro07 repo
- Deprecated include in favor of require with luabundle. (Thanks @Benjamin-Dobell)
- Output to console is now sanitized. (Thanks @Demiko)
- CSP according to suggestion. (Thanks @mjbvz)
- Added multiple include path config. (Thanks @andymeneely)
- Autocomplete and snippets working again.
- Adopted VSCode workspace.fs API
- Changed scripts folder to "Tabletop Simulator Lua" to match with Atom's
- Added new command "Add include folder to workspace"
- Console++ Panel now opens to the side of the active editor
- Changed the way some error display, now in modal form
- Added status bar messages when sending or receiving files
- Spaces now show up properly in Console++ panel
- Can now include files from XML

Thanks to the people who helped me test during development: @stom66, @andymeneely and ZBRA

## [1.0.5]

- Fixed published packaging versioning issue

## [1.0.4]

- Fixes multiple includes (Thanks to @jonahwh)

## [1.0.3]

- Fixed issue where multiple objects with same object name would overwrite each other. (Thanks stom66 @ GitHub)

## [1.0.2]

- Fixed onObjectDrop suggestion (Thanks Eldin @ Discord)

## [1.0.1]

- README fixes

## [1.0.0]

- Initial release
- Added LICENCE
- Added README.md
- Added documentation assets
- Feature Complete: Integration with Console++ by onelivesleft
  - Added WebPanelView for output
  - Added CSS/JS for WebPanelView
  - Added Command Input to be sent via CustomMessage
- Feature Complete: Get Scripts / Save And Play
  - Added Print/Debug Message Communication
  - Added Error Messages with special formatting
- Feature Complete: #include Support
  - Handling of nested includes
  - Root includes
  - Scoped includes
- Added Feature: Syntax Highlight
- Added Feature: Code autocompletion based on OliPro007's Extension
- Bundled default Console++ and expanded it to add onExternalCommand()
