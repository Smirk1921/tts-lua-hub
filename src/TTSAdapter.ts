/**
 * TTS Adapter singleton（Stage C / T1.3 传输层解耦）：
 *
 * 上游版本在本类内起 `net.Server` 监听 39998 收 TTS 推送，出站则在 sendToTTS
 * 里现起 `net.connect` 直发 TTS 本体 39999。本版本把字节通道全部抽到
 * ITransport（src/transport/）之后，本类只保留消息语义：
 *
 * - 入站（TTS→编辑器）：transport.onMessage 回调直喂 handleMessage（T6）；
 *   默认传输为 ClientTransport——主动连 hub 39997 扇出端口，裸 TCP 字节流
 *   由 JsonStreamDecoder 分帧；
 * - 出站（编辑器→TTS）：sendToTTS 经 transport.send 直发 39999，前置
 *   transport.isConnected() 门槛（T8.3，替代上游的 isServerRunning）；
 * - 降级双模式（T12.2）：`ttslua.hub.fallback='bind'` 时启动先探测 hub 端口，
 *   不可达则改用 ServerTransport 临时绑 39998 直连 TTS；'prompt' 恒用
 *   ClientTransport，不回落，断开时状态栏提示启动 tts-hub；
 * - 连接生命周期由 ConnectionStateMachine 跟踪，状态栏镜像其 'stateChange'；
 * - Go-to-Error 用的 _lastSentScripts：GetScripts 响应（T5.2）与 SaveAndPlay
 *   两条路径都登记，并带内容 hash 持久化到 LocalStorageService（T8.2），
 *   窗口重载后仍可恢复。
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as net from 'net';

import path = require('path');
import bundler from 'luabundle';
import {resolveModule} from 'luabundle/bundle/process';
import * as bundleErr from 'luabundle/errors';

import * as ws from '@/vscode/workspace';
import * as TTSTypes from '@/TTSTypes';
import TTSConsolePanel from '@/TTSConsole';
import TTSWorkDir from '@/vscode/TTSWorkDir';
import LocalStorageService from './vscode/LocalStorageService';
import {getHubConfig} from '@/config';
import type {HubConfig} from '@/config';
import {ClientTransport} from '@/transport/ClientTransport';
import {ConnectionStateMachine} from '@/transport/ConnectionStateMachine';
import type {ConnectionState} from '@/transport/ConnectionStateMachine';
import type {ITransport} from '@/transport/ITransport';
import {ServerTransport} from '@/transport/ServerTransport';

type InGameObjectsList = {[key: string]: {name?: string; type?: string; iname?: string}};

/** T8.2：持久化到 LocalStorageService 的 _lastSentScripts 条目（带内容 hash）。 */
interface PersistedScriptEntry {
  scriptState: TTSTypes.ScriptState;
  /** sha256(script) 前 16 位；恢复时校验，不一致则丢弃该条目 */
  hash: string;
}

/** 连接状态 → 状态栏文案（T1.3；disconnected 文案按 T12.2 prompt 模式要求）。 */
const HUB_STATUS_TEXT: {[key in ConnectionState]: string} = {
  connected: '$(check) Connected to hub',
  connecting: '$(sync~spin) Connecting...',
  reconnecting: '$(sync~spin) Connecting...',
  disconnected: '$(error) hub 未连接：请运行 tts-hub',
};

/** T12.2：bind 模式降级到 ServerTransport（绑 39998 直连 TTS）时的状态栏文案。 */
const HUB_FALLBACK_BIND_STATUS = '$(warning) tts-hub 未连接：已降级为直连 TTS（绑 39998）';

/** T12.2：bind 模式启动时探测 hub 可达性的超时（任务书规定 500ms）。 */
const HUB_PROBE_TIMEOUT_MS = 500;

/**
 * T12.2：一次性探测 hub 端口是否可达（bind 模式的启动决策，超时 500ms）。
 * net.connect 连上即 resolve(true)；'error'（如 hub 未启动的 ECONNREFUSED）
 * 或超时即 resolve(false)。探测连接随即销毁，不影响后续传输层选型。
 */
function probeHubReachable(
  host: string,
  port: number,
  timeoutMs: number = HUB_PROBE_TIMEOUT_MS
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const socket = net.connect(port, host);
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

/**
 * Forms an array with directory paths where to look for files to be included
 * @param searchPattern - Patterns array to form paths with
 */
function getSearchPaths(searchPattern: string[]): string[] {
  const includePaths: string[] =
    vscode.workspace.getConfiguration('ttslua.fileManagement').get('includePaths') || [];
  // Search pattern can be undefined, if it is
  const vsFolders = vscode.workspace.workspaceFolders || [];

  /* DISABLED:
   * This would make relative require work anywhere, but will probably be too many locations to
   * search for modules
   */
  // const possibleLocations = vsFolders
  //   .map(vsFolder => glob.sync('**/*/', {cwd: vsFolder.uri.fsPath, absolute: true}))
  //   .reduce((acc, cur) => acc.concat(cur), []);

  /* We could only do that when we are working with version control */
  // const workDirLocs = !TTSWorkDir.instance.isDefault()
  //   ? glob.sync('**/*/', {
  //       cwd: TTSWorkDir.instance.getUri().fsPath,
  //       absolute: true,
  //     })
  //   : [];

  const paths = searchPattern
    .filter(pattern => pattern.length > 0)
    .map(pattern => [
      path.join(ws.docsFolder, pattern),
      ...includePaths.map(p => path.join(p, pattern)),
      ...vsFolders.map(val => path.join(val.uri.fsPath, pattern)),
      // ...workDirLocs.map(val => path.join(val, pattern)),
      pattern, // For absolute paths
    ])
    // Flatten so all paths are in one top level array
    .reduce((acc, val) => acc.concat(val), []);
  // Flatten res
  if (vscode.workspace.getConfiguration('ttslua.misc').get('debugSearchPaths'))
    console.log('[TTSLua] Search Paths:\n->', paths.join('\n-> '), '\n');
  return paths;
}

/**
 * Returns a list patterns, validating that '?.lua' is always included
 */
function getLuaSearchPatterns(): string[] {
  const patterns = vscode.workspace
    .getConfiguration('ttslua.fileManagement')
    .get('luaSearchPattern') as string[];
  if (!patterns.includes('?')) patterns.push('?');
  if (!patterns.includes('?.lua')) patterns.push('?.lua');
  return patterns;
}

/**
 * TTS Adapter singleton
 */
export default class TTSAdapter extends vscode.Disposable {
  private static instance: TTSAdapter;
  private _inGameObjects: InGameObjectsList = {};
  /**
   * 出入站共用传输层（T1.3）：默认连 hub 39997 扇出、出站直发 TTS 39999；
   * T12.2 起 bind 降级时也可能是绑 39998 的 ServerTransport。bind 模式的
   * 启动探测（≤500ms）期间尚未选定，故允许为空——空等价于「未连接」，
   * sendToTTS 直接跳过。
   */
  private transport?: ITransport;
  /** T12.2：bind 探测期间被 dispose 时置位，防止探测完成后又挂上传输层 */
  private _disposed = false;
  private _lastSentScripts: {[key: string]: TTSTypes.ScriptState} = {};
  private _retIdCounter = 0;
  /** hub 连接状态的常驻状态栏消息；每次 stateChange 换新前先 dispose 旧的 */
  private _hubStatusBar?: vscode.Disposable;
  /** T8.2：_lastSentScripts 在 LocalStorageService 中的键名 */
  private static readonly LAST_SENT_SCRIPTS_KEY = 'lastSentScripts';

  public static getInstance(): TTSAdapter {
    if (!TTSAdapter.instance) TTSAdapter.instance = new TTSAdapter();
    return TTSAdapter.instance;
  }

  /**
   * Wires message handling to a transport at init time.
   *
   * 默认（未注入 transport 时）按 `ttslua.hub.*` 配置选传输层（T12.2）：
   * - 'prompt'：ClientTransport——主动连接 hub 39997 扇出端口收 TTS 推送，
   *   出站仍直发 TTS 本体 39999；连不上不回落，由 ConnectionStateMachine
   *   的指数退避重连，状态栏提示「请运行 tts-hub」；
   * - 'bind'：先探测 hub 端口（500ms 超时）——可达走 ClientTransport，
   *   不可达降级为 ServerTransport（临时绑 39998 收 TTS，与 CLI 独立模式
   *   同策略）。
   * 启动为异步，不阻塞构造（bind 探测最长 500ms）。
   * @param transport - 可选注入的 ITransport（测试 / 其他模式）；缺省时按
   *   `ttslua.hub.fallback` 选型
   */
  constructor(transport?: ITransport) {
    super(() => this.dispose());
    if (transport) {
      // 测试 / 其他模式注入的 transport：原样使用，不做降级选型
      this.attachTransport(transport);
    } else {
      const hubCfg = getHubConfig();
      const csm = new ConnectionStateMachine(hubCfg.reconnectMaxMs);
      void this.selectTransport(hubCfg, csm).catch((err: Error) => {
        console.error(`[TTSLua] Transport selection failed: ${err.message}`);
      });
    }
    TTSAdapter.instance = this;
  }

  /**
   * 按 `ttslua.hub.fallback` 与 hub 可达性选择传输层（T12.2）：
   * - 'prompt'：恒用 ClientTransport，不回落；csm 'disconnected' 时状态栏
   *   显示「$(error) hub 未连接：请运行 tts-hub」；
   * - 'bind'：启动时探测 hub 端口（HUB_PROBE_TIMEOUT_MS 超时）——可达走
   *   ClientTransport（与 prompt 同），不可达回落 ServerTransport（绑 39998）。
   *   探测连接不参与后续收发。
   */
  private async selectTransport(hubCfg: HubConfig, csm: ConnectionStateMachine): Promise<void> {
    if (hubCfg.fallback === 'bind') {
      const reachable = await probeHubReachable(hubCfg.host, hubCfg.port);
      // 探测期间已被 dispose：不再挂传输层（dispose 已把 stop 交给空 transport）
      if (this._disposed) return;
      if (!reachable) {
        // hub 不在线：降级为直连 TTS；ServerTransport.start 若发现 39998 被占
        // （如 hub 刚好抢占）会按上游语义弹 EADDRINUSE 错误框
        console.log('[TTSLua] tts-hub unreachable, falling back to ServerTransport (bind 39998)');
        this._hubStatusBar?.dispose();
        this._hubStatusBar = vscode.window.setStatusBarMessage(HUB_FALLBACK_BIND_STATUS);
        this.attachTransport(new ServerTransport());
        return;
      }
    }
    // prompt 模式，或 bind 模式探测到 hub 可达：走 hub 客户端
    // 状态栏镜像 hub 连接生命周期（保留上游 setStatusBarMessage 模式）
    csm.on('stateChange', state => this.updateHubStatusBar(state));
    this.updateHubStatusBar(csm.state);
    this.attachTransport(new ClientTransport(hubCfg, csm));
  }

  /**
   * 挂载传输层（T1.3 的接线逻辑，T12.2 抽成方法供两条选型路径复用）：
   * 注册入站回调并异步启动，不阻塞构造；启动失败只记日志——建连成功后的
   * 断线重连由状态机驱动，bind 模式的降级已在 selectTransport 定夺。
   */
  private attachTransport(transport: ITransport): void {
    this.transport = transport;
    // T6：入站触发源由上游「socket 'close' + JSON.parse」改为 transport 回调
    transport.onMessage(msg => this.handleMessage(msg));
    // 异步启动、不阻塞构造
    void transport.start().catch((err: Error) => {
      console.error(`[TTSLua] Transport start failed: ${err.message}`);
    });
  }

  /**
   * 把 hub 连接状态镜像到状态栏（保留上游 setStatusBarMessage 模式）：
   * connected → $(check)、connecting / reconnecting → $(sync~spin)、
   * disconnected → $(error) hub 未连接：请运行 tts-hub（T12.2 prompt 模式要求）。
   * 先 dispose 上一条再挂新消息，避免状态堆叠。
   */
  private updateHubStatusBar(state: ConnectionState): void {
    this._hubStatusBar?.dispose();
    this._hubStatusBar = vscode.window.setStatusBarMessage(HUB_STATUS_TEXT[state]);
  }

  /**
   * Sends a custom structured object
   * @param object - Table to be sent to game
   */
  public customMessage(object: unknown) {
    this.sendToTTS(TTSTypes.TxMsgType.CustomMessage, {customMessage: object});
  }

  /**
   * Requests a list of all scripts from the game
   */
  public getScripts() {
    this.sendToTTS(TTSTypes.TxMsgType.GetScripts);
  }

  /**
   * Sends all Scripts to the game
   */
  public async saveAndPlay() {
    // When sending scripts, the Temp folder must be present in workspace
    if (!ws.isPresent(TTSWorkDir.instance.getUri())) {
      vscode.window.showErrorMessage(
        'The workspace does not contain the Tabletop Simulator folder.\n' +
          'Get Lua Scripts from game before trying to Save and Play.',
        {modal: true}
      );
      return;
    }
    // Save all files
    await vscode.workspace.saveAll(false);
    // Read files contained in the Temp folder
    let files: [string, vscode.FileType][];
    try {
      files = await vscode.workspace.fs.readDirectory(TTSWorkDir.instance.getUri());
    } catch (reason: unknown) {
      vscode.window.showErrorMessage(
        'Unable to read TTS Scripts directory.\n' + `Details: ${reason}`
      );
      return;
    }

    // An indexed array is used to backreference the guids when parsing the UI portion
    const scripts: {[key: string]: TTSTypes.ScriptState} = {};
    for (const [file] of files.filter(([file]) => file.endsWith('.lua'))) {
      // T8.1：对象名里可能含点号，按「最后一个点号到 .lua 之间」解析 guid，
      // 其前缀整体作为对象名（与 executeLua 的解析一致）
      const m = /^(.+)\.([^.]+)\.lua$/.exec(file);
      if (!m) continue;
      const [, name, guid] = m;
      const fileContents = (await TTSWorkDir.instance.readFile(file)).toString();
      try {
        scripts[guid] = {
          name,
          guid,
          script: bundler.bundleString(fileContents, {
            paths: getSearchPaths(getLuaSearchPatterns()),
            isolate: true,
            rootModuleName: file,
          }),
        };
      } catch (err) {
        if (err instanceof bundleErr.ModuleResolutionError) {
          vscode.window
            .showErrorMessage(
              `Unable to find module "${err.moduleName}" from ${err.parentModuleName}<${err.line}:${err.column}>\n`,
              'Learn More',
              'Enable Debug'
            )
            .then(selection => {
              if (selection === 'Learn More')
                vscode.env.openExternal(
                  vscode.Uri.parse(
                    'https://tts-vscode.rolandostar.com/support/debuggingModuleResolution'
                  )
                );
              else if (selection === 'Enable Debug') {
                if (!vscode.workspace.getConfiguration('ttslua.misc').get('debugSearchPaths')) {
                  vscode.workspace
                    .getConfiguration('ttslua.misc')
                    .update('debugSearchPaths', true, vscode.ConfigurationTarget.Global);
                  vscode.commands.executeCommand('workbench.action.toggleDevTools');
                  console.log(
                    '[TTSLua] Search Paths debug enabled, this window will now output the search paths when attempting to resolve modules.'
                  );
                } else {
                  vscode.window
                    .showInformationMessage(
                      'Search Paths debug is already enabled',
                      'Toggle DevTools'
                    )
                    .then(selection => {
                      if (selection === 'Toggle DevTools')
                        vscode.commands.executeCommand('workbench.action.toggleDevTools');
                    });
                }
              }
            });
          return;
        } else if (err instanceof SyntaxError) {
          const e = err as unknown as TTSTypes.BundleSyntaxError;
          const option = await vscode.window.showErrorMessage(
            `Syntax Error in ${file}${err.message}`,
            'Go to Error'
          );
          if (!option) return;
          await vscode.window.showTextDocument(TTSWorkDir.instance.getFileUri(file)),
            {
              selection: new vscode.Range(e.line - 1, e.column, e.line, 0),
            };
          return;
        }
        vscode.window.showErrorMessage(`${name}:\n${err}`);
        return;
      }
    }
    // Iterate over found scripts, and check if UI file exists
    for (const guid in scripts) {
      const script = scripts[guid];
      try {
        // Check if file exists with same name and guid
        const filetext = await TTSWorkDir.instance.readFile(`${script.name}.${script.guid}.xml`);
        // If Found, add it to the script state object under `ui`
        scripts[guid].ui = await TTSAdapter.insertXmlFiles(filetext.toString());
      } catch (reason) {
        if ((reason as vscode.FileSystemError).code !== 'FileNotFound') {
          vscode.window.showErrorMessage(`Error reading UI file for ${script.name}:\n${reason}`);
        }
      }
    }
    // Validate empty global to avoid lockup
    if (scripts['-1'] === undefined || scripts['-1'].script === '') {
      vscode.window
        .showErrorMessage('Global Script must not be empty', 'Learn More')
        .then(selection => {
          if (selection === 'Learn More')
            vscode.env.openExternal(
              vscode.Uri.parse('https://tts-vscode.rolandostar.com/support/globalScriptLock')
            );
        });
      return;
    }
    // Do the sending
    this._lastSentScripts = scripts;
    // T8.2：带内容 hash 快照到 LocalStorageService，窗口重载后 Go-to-Error 仍可用
    this.persistLastSentScripts();
    this.sendToTTS(TTSTypes.TxMsgType.SaveAndPlay, {
      scriptStates: [...Object.values(scripts)],
    });
    // Update status bar
    const statusBar = vscode.window.setStatusBarMessage(
      `$(cloud-upload) Sent ${files.length} files`
    );
    setTimeout(() => {
      statusBar.dispose();
    }, 1500);
    // Clear the console if configured to do so
    if (vscode.workspace.getConfiguration('ttslua.console').get('clearOnReload'))
      TTSConsolePanel.currentPanel?.clearPanel();

    return true;
  }

  /**
   * Calls corresponding function according to message type
   * @param rawMessage - Message received from TTS
   */
  private handleMessage(rawMessage: TTSTypes.GenericTTSMessage) {
    // console.log('[TTSLua] Received message:');
    // console.log(rawMessage);
    switch (rawMessage.messageID) {
      case TTSTypes.RxMsgType.ObjectPushed: {
        const ttsMessage = <TTSTypes.ObjectPushedMessage>rawMessage;
        ws.addWorkDirToWorkspace();
        // add guid to suggestion
        this.readFilesFromTTS(ttsMessage.scriptStates, {single: true});
        break;
      }

      case TTSTypes.RxMsgType.NewGame: {
        const ttsMessage = <TTSTypes.NewGameMessage>rawMessage;
        // if (!this.savedAndPlayed)
        this.requestObjectGUIDs();
        ws.addWorkDirToWorkspace();
        this.readFilesFromTTS(ttsMessage.scriptStates);
        // this.savedAndPlayed = false;
        break;
      }

      case TTSTypes.RxMsgType.PrintDebug: {
        const ttsMessage = <TTSTypes.PrintDebugMessage>rawMessage;
        TTSConsolePanel.currentPanel?.appendToPanel(ttsMessage.message);
        break;
      }

      case TTSTypes.RxMsgType.Error: {
        const ttsMessage = <TTSTypes.ErrorMessage>rawMessage;
        TTSConsolePanel.currentPanel?.appendToPanel(ttsMessage.errorMessagePrefix, {
          class: 'callout error',
        });
        this.goToTTSError(ttsMessage).catch(err => vscode.window.showErrorMessage(err.message));
        break;
      }

      case TTSTypes.RxMsgType.CustomMessage: {
        const ttsMessage = <TTSTypes.CustomMessage>rawMessage;
        const content = JSON.parse(ttsMessage.customMessage.content);
        switch (ttsMessage.customMessage.type) {
          // Process guids for autocompletion
          case 'guids': {
            this._inGameObjects = content;
            break;
          }
          default: {
            console.log('Unknown custom message type');
          }
        }
        break;
      }

      case TTSTypes.RxMsgType.Return: {
        const ttsMessage = <TTSTypes.ReturnMessage>rawMessage;
        if (TTSConsolePanel.currentPanel?.isVisible()) {
          TTSConsolePanel.currentPanel?.appendToPanel(ttsMessage.returnValue, {
            class: 'callout return',
          });
        } else vscode.window.showInformationMessage(ttsMessage.returnValue);
        break;
      }

      case TTSTypes.RxMsgType.GameSaved: {
        const ttsMessage = <TTSTypes.GameSavedMessaged>rawMessage;
        if (vscode.workspace.getConfiguration('ttslua.console').get('logSaves')) {
          const d = new Date();
          const h = `${d.getHours()}`.padStart(2, '0');
          const m = `${d.getMinutes()}`.padStart(2, '0');
          const s = `${d.getSeconds()}`.padStart(2, '0');
          const timestamp = `${h}:${m}:${s}`;
          TTSConsolePanel.currentPanel?.appendToPanel(`[${timestamp}] 💾 Game Saved`, {
            class: 'save',
          });
        }
        LocalStorageService.setValue('lastSavePath', ttsMessage.savePath);
        if (!TTSWorkDir.instance.isDefault()) {
          const saveName = vscode.workspace
            .getConfiguration('ttslua.fileManagement')
            .get('saveName');
          vscode.workspace.fs
            .copy(
              vscode.Uri.file(path.normalize(ttsMessage.savePath)),
              TTSWorkDir.instance.getFileUri(saveName + '.json'),
              {overwrite: true}
            )
            .then(() => {
              vscode.window.showInformationMessage('Game Saved');
            });
        }
        break;
      }
      case TTSTypes.RxMsgType.ObjectCreated: {
        const ttsMessage = <TTSTypes.ObjectCreatedMessage>rawMessage;
        // Add it to the guid suggestions if not already
        if (this._inGameObjects[ttsMessage.guid]) return;
        this._inGameObjects[ttsMessage.guid] = {};
        break;
      }

      default:
        break;
    }
  }

  /**
   * Shows an error from TTS and a button to jump to the line it came from
   * @param message - Error Message received from TTS
   */
  private async goToTTSError(
    message: TTSTypes.ErrorMessage
  ): Promise<vscode.TextEditor | undefined> {
    // Confirm that message.error exists
    // If the error is from Execute Lua or no pattern found, no button is needed
    const match = message.error.match(/.*:\((\d*),(\d*)-(\d*)\):/) ?? null;
    if (message.errorMessagePrefix.search(/.*function <exec.*/) >= 0 || !match) {
      // not a jumpable error message, show it and return
      vscode.window.showErrorMessage(message.error);
      return;
    }
    // Extract components
    const [, line, startChar, endChar] = match;
    // Parse as Int to form Error Range
    const lineNum = parseInt(line, 10);
    const startCharNum = parseInt(startChar, 10);
    const endCharNum = parseInt(endChar, 10);
    const errorRange = new vscode.Range(lineNum - 1, startCharNum, lineNum - 1, endCharNum);

    // Show Button to User
    const option = await vscode.window.showErrorMessage(message.error, 'Go to Error');
    if (!option) return; // Dismissed
    if (Object.keys(this._lastSentScripts).length === 0) {
      // T8.2：内存里没有快照（如窗口刚重载）——先从 LocalStorageService
      // 恢复（逐条校验内容 hash），再决定是否报错
      this.restoreLastSentScripts();
    }
    if (Object.keys(this._lastSentScripts).length === 0) {
      vscode.window.showErrorMessage(
        'Unable to locate Error. Make sure you have sent scripts first with Save & Play'
      );
      return;
    }

    const script = this._lastSentScripts[message.guid];
    if (!script) throw Error('No such script loaded.');
    try {
      // Will throw if file isn't bundled
      const unbundled = bundler.unbundleString(script.script);
      const modules = Object.values(unbundled.modules);
      for (const m of modules) {
        const mRange = new vscode.Range(m.start.line, m.start.column, m.end.line, m.end.column);
        if (mRange.contains(errorRange)) {
          let uri: vscode.Uri;
          if (m.name === unbundled.metadata.rootModuleName) {
            uri = TTSWorkDir.instance.getFileUri(`${script.name}.${script.guid}.lua`);
          } else {
            // Find the file the same way we did when we bundled it
            const path = resolveModule(m.name, getSearchPaths(getLuaSearchPatterns()));
            if (!path) throw Error('Module containing error not found in search paths.');
            uri = vscode.Uri.file(path);
          }

          return vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(
              errorRange.start.line - mRange.start.line + 1,
              errorRange.start.character,
              errorRange.end.line - mRange.start.line + 1,
              errorRange.end.character
            ),
          });
        }
      }
      return;
    } catch (err: unknown) {
      if (!(err instanceof bundleErr.NoBundleMetadataError)) throw err;
      // file wasnt bundled, no complexity needed
      return vscode.window.showTextDocument(
        TTSWorkDir.instance.getFileUri(`${script.name}.${script.guid}.lua`),
        {selection: errorRange}
      );
    }
  }

  /**
   * T8.2：把 _lastSentScripts 整表快照进 LocalStorageService，每个条目附带
   * 脚本内容的 sha256 前 16 位；恢复时以此校验，防止过期快照误导 Go-to-Error。
   * 持久化失败绝不影响主流程（吞掉并记日志）。
   */
  private persistLastSentScripts(): void {
    try {
      const payload: {[guid: string]: PersistedScriptEntry} = {};
      for (const guid in this._lastSentScripts) {
        const scriptState = this._lastSentScripts[guid];
        payload[guid] = {
          scriptState,
          hash: TTSAdapter.hashScript(scriptState.script),
        };
      }
      void LocalStorageService.setValue(TTSAdapter.LAST_SENT_SCRIPTS_KEY, payload);
    } catch (err) {
      console.error(`[TTSLua] Unable to persist sent scripts: ${err}`);
    }
  }

  /**
   * T8.2：从 LocalStorageService 恢复 _lastSentScripts（窗口重载后内存为空
   * 时的兜底）。存储值缺 hash 或 hash 与脚本内容不一致的条目直接丢弃。
   */
  private restoreLastSentScripts(): void {
    try {
      const payload = LocalStorageService.getValue<{
        [guid: string]: PersistedScriptEntry;
      }>(TTSAdapter.LAST_SENT_SCRIPTS_KEY);
      if (!payload) return;
      for (const guid in payload) {
        const entry = payload[guid];
        if (!entry?.scriptState) continue;
        if (TTSAdapter.hashScript(entry.scriptState.script) !== entry.hash) continue;
        this._lastSentScripts[guid] = entry.scriptState;
      }
    } catch {
      // LocalStorageService 未初始化等场景：无快照可恢复，保持现状即可
    }
  }

  /** 脚本内容的短 hash（sha256 前 16 位），用于持久化条目的新鲜度校验。 */
  private static hashScript(script: string): string {
    return crypto.createHash('sha256').update(script).digest('hex').slice(0, 16);
  }

  /**
   * Creates files into workspace from received scriptStates
   * @param scriptStates - State of all received scripts
   */
  private async readFilesFromTTS(
    scriptStates: TTSTypes.ScriptState[],
    options?: {single?: boolean}
  ) {
    // Read scriptStates, write them to files and determine which should be opened
    const filesRecv: ws.FileHandler[] = [];
    const globalHandlers: ws.FileHandler[] = [];
    const autoOpen = vscode.workspace
      .getConfiguration('ttslua.fileManagement')
      .get('autoOpen') as string;
    const createXml = vscode.workspace
      .getConfiguration('ttslua.fileManagement')
      .get('createXML') as boolean;
    // This would create a status bar with spinning icon, but it finishes too fast to see :(
    /* let statusBar = wd.setStatusBarMessage('$(sync~spin) Receiving scripts'); */
    if (scriptStates) {
      for (const scriptState of scriptStates) {
        // Sanitize script name
        scriptState.name = scriptState.name.replace(/([":<>/\\|?*])/g, '');
        // T5.2：记录刚收到的脚本（与 saveAndPlay 的
        // `this._lastSentScripts = scripts` 同语义），Go-to-Error 由此定位
        this._lastSentScripts[scriptState.guid] = scriptState;
        // XML File Creation
        // If the file received has UI Data or if user explicitly wants to create UI file for each.
        if (scriptState.ui || createXml) {
          const xmlHandler = new ws.FileHandler(`${scriptState.name}.${scriptState.guid}.xml`);
          await xmlHandler.write(
            scriptState.ui?.replace(
              /(<!--\s+include\s+([^\s].*)\s+-->)[\s\S]+?\1/g,
              (_matched, _open, src) => `<Include src="${src}"/>`
            ) ?? ''
          );
          // if (scriptState.name === 'Global') globalHandlers.push(handler);
          filesRecv.push(xmlHandler);
        }
        // Lua File Creation
        // First create the file as-is
        const luaHandler = new ws.FileHandler(
          `${scriptState.name}.${scriptState.guid}.lua`.replace(/\n/gi, '')
        );
        await luaHandler.write(scriptState.script);
        try {
          // Then, attempt to unbundle
          const data = bundler.unbundleString(scriptState.script);
          const {content} = data.modules[data.metadata.rootModuleName];
          // If unbundle was successful, overwrite the file with the unbundled content
          if (content !== '') await luaHandler.write(content);
        } catch (err: unknown) {
          // If unbundle failed for any reason other than no metadata, make it known. Be silent otherwise.
          if (!(err instanceof bundleErr.NoBundleMetadataError)) {
            vscode.window.showErrorMessage((err as Error).message);
            throw err;
          }
        }
        if (scriptState.name === 'Global') globalHandlers.push(luaHandler);
        filesRecv.push(luaHandler);
      }
      // T8.2：本轮接收完成后，把快照（含内容 hash）同步到 LocalStorageService
      this.persistLastSentScripts();
    }
    // Remove files not marked as received from the workFolder.
    // If a single object was pushed, do not remove files.
    if (!options?.single) {
      await ws.syncFiles(filesRecv);
      switch (autoOpen) {
        case 'All':
          filesRecv.forEach(handler => handler.open());
          break;
        case 'Global':
          globalHandlers.forEach(handler => handler.open());
          break;
        case 'None':
        default:
          break;
      }
    } else filesRecv[0].open({preview: true});

    const statusBar = vscode.window.setStatusBarMessage(
      `$(cloud-download) Received ${Object.keys(filesRecv).length} scripts from TTS`
    );
    setTimeout(() => statusBar.dispose(), 1500);
  }

  /**
   * Sends a message to the game
   * @param messageID - Type of message to be sent
   * @param object - Mutable object according to type
   */
  private async sendToTTS(messageID: TTSTypes.TxMsgType, object?: object) {
    // T8.3：hub 扇出连接不在位时不发（替代上游的 isServerRunning 检查）；
    // T12.2：bind 模式启动探测期间 transport 尚未选定，同样按「未连接」跳过
    if (!this.transport?.isConnected()) return;
    const statusBar = vscode.window.setStatusBarMessage('$(sync~spin) Connecting to TTS');
    try {
      await this.transport.send(messageID, object);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        vscode.window.showErrorMessage(
          'Unable to connect to Tabletop Simulator.\n\n' +
            'Check that the game is running and a save has been loaded.',
          {modal: true}
        );
      } else console.error(`[TTSLua] Net Client ${err}`);
    } finally {
      statusBar.dispose();
    }
  }

  executeLua(script?: string, guid?: string) {
    // Get Current selection from vscode
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (!script && !guid) {
      script = editor.document.getText(editor.selection);
      // T8.1：对象名里可能含点号，取「最后一个点号与 .lua 之间」的字段为
      // guid（与 saveAndPlay 的解析一致）；解析失败保持 undefined（原行为）
      const m = /^(.+)\.([^.]+)\.lua$/.exec(path.basename(editor.document.fileName));
      if (m) guid = m[2];
    } else if (!script || !guid) {
      console.error('Script or GUID not provided');
      return;
    }
    // Check that script is defined and not empty
    if (script === '') {
      vscode.window.showErrorMessage('No script selected');
      return;
    }
    // Send to TTS
    this.sendToTTS(TTSTypes.TxMsgType.ExecuteLua, {script, guid, returnID: this._retIdCounter++});
  }

  getInGameObjects() {
    return this._inGameObjects;
  }

  /**
   * Recursive XML Include
   * @param text - Text to be replaced
   * @param alreadyInserted - Tracking array to prevent cyclical includes
   */
  private static async insertXmlFiles(
    text: string | Uint8Array,
    alreadyInserted: string[] = []
  ): Promise<string> {
    if (typeof text !== 'string') text = Buffer.from(text).toString('utf-8');
    const pattern = /(^|\n)([\s]*)(.*)<Include\s+src=('|")(.+)\4\s*\/>/;
    const getNonce = () => Math.random().toString(36).substring(7);
    const nonce = getNonce();
    // First we extract comments and leave a placeholder, so we don't try to parse them
    // Remember to store them for reinsertion later
    const comments: string[] = [];
    text = text.replace(/<!--[\s\S]*?-->/g, comment => {
      comments.push(comment);
      return `<!--${nonce}:${comments.length - 1}-->`;
    });
    // Then we perform the actual replacement

    // Split text by lines
    const lines = text.split(/\r?\n/);
    // Iterate each line
    for (const [index, line] of lines.entries()) {
      // If line contains an include (with regex)
      const match = line.match(pattern);
      if (match) {
        const [, pre, indent, before, , insertPath] = match;
        const prefix = pre + indent + before;
        const marker = `<!-- include ${insertPath} -->`;
        const possiblePaths = getSearchPaths([insertPath]);
        // Try to open each path, and insert the first one that works
        for (const lookupPath of possiblePaths) {
          // Check if the file exists before attempting to open it
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(lookupPath));
          } catch (err) {
            if ((err as vscode.FileSystemError).code !== 'FileNotFound') {
              vscode.window.showErrorMessage(`Error reading ${lookupPath}: ${err}`);
              throw err;
            }
            // If it doesn't, just try with the next one
            continue;
          }
          // Found an existing file, so open it
          const moduleUri = vscode.Uri.file(lookupPath);
          const moduleContent = await vscode.workspace.fs.readFile(moduleUri);
          if (moduleContent.length > 0) {
            // If the file has already been inserted, skip it
            if (alreadyInserted.includes(lookupPath)) {
              vscode.window.showErrorMessage(
                `Cyclical include detected. ${insertPath} was previously included`
              );
              lines[index] = line.replace(pattern, prefix);
              break;
            }
            // File hasn't been inserted yet.
            alreadyInserted.push(lookupPath);
            const newText = await TTSAdapter.insertXmlFiles(moduleContent, alreadyInserted);
            const content = newText.replace('\n', `\n${indent}`);
            lines[index] = line.replace(
              pattern,
              `${prefix + marker}\n${indent}${content}\n${indent}${marker}`
            );
            break;
          }
          // Went through all possible paths but no return yet. Inform of error
          vscode.window.showErrorMessage(
            `Could not catalog <Include /> - file not found: ${insertPath}`
          );
          lines[index] = line.replace(pattern, `${prefix + marker}\n${indent}${marker}`);
        }
      }
    }

    // Reinsert comments
    return lines
      .join('\n')
      .replace(new RegExp(`<!--${nonce}:(\\d+)-->`, 'g'), (_match, index) => comments[index]);
  }

  private requestObjectGUIDs() {
    // read file from disk
    this.sendToTTS(TTSTypes.TxMsgType.ExecuteLua, {
      guid: '-1',
      script: fs.readFileSync(path.join(__dirname, '../lua/requestObjectGUIDs.lua'), 'utf8'),
    });
  }

  public dispose() {
    // T12.2：bind 探测期间 dispose 时 transport 可能尚未选定（见 selectTransport）
    this._disposed = true;
    void this.transport?.stop();
    this._hubStatusBar?.dispose();
    console.log('TTSAdapter disposed');
  }
}
