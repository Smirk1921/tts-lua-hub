// src/transport/ServerTransport.ts
/**
 * T12 降级 bind 模式：hub 不在线时临时绑定 39998 接收 TTS 推送（ITransport 的
 * server 实现），与 CLI 独立模式同策略。
 *
 * 代码自上游 Fork（581f0c2）的 TTSAdapter.ts server 部分原样提取，保留上游
 * 收发语义：
 * - 下行（TTS→编辑器）：`net.createServer` + `socket.on('data', ...)` 累积
 *   分片，`socket.on('close')` 时对全量载荷做一次 `JSON.parse` 后喂 onMessage
 *   回调——TTS 每次推送独占一条短连接，写完即关；
 * - 上行（编辑器→TTS）：send() 与 ClientTransport.send 完全同实现——直连
 *   TTS 本体 39999，连 → 写 → destroy，不接响应（T12.2 任务书允许重复一份，
 *   避免为共享函数新增文件）；
 * - 监听：`listen(39998, 'localhost')`（构造可注入端口，默认 39998），
 *   EADDRINUSE 报错弹窗与上游 isServerRunning 同语义（文案逐字保留）。
 *
 * 与上游的差异只有防御性补齐（正常路径行为不变）：
 * - 上游对空载荷 / 坏 JSON 直接 `JSON.parse` 抛进事件循环（会击穿扩展宿主），
 *   这里记日志后跳过该连接；上游用 `chunks.join('')` 拼分片，这里改用
 *   `Buffer.concat`（对跨 TCP 段拆开的多字节 UTF-8 字符等价且正确）；
 * - 上游未挂 socket 'error' 监听，这里补一个（只记日志，不中断监听）；
 * - stop() 先断开在途连接再 close，避免 close 一直等待未结束的短连接。
 *
 * 本文件对 vscode 的依赖仅限 EADDRINUSE 弹窗（上游同款文案），其余逻辑只
 * 依赖 net。
 */
import * as net from 'net';
import * as vscode from 'vscode';

import type * as TTSTypes from '@/TTSTypes';
import type {ITransport} from './ITransport';

/** 入站监听端口：TTS 主动推送脚本 / 消息的固定端口（上游 _serverPort 默认值）。 */
const TTS_EDITOR_PORT = 39998;
/** TTS 命令端口：出站消息（GetScripts / SaveAndPlay / CustomMessage / ExecuteLua）直连 TTS 本体。 */
const TTS_COMMAND_PORT = 39999;
/** 出站目标主机：与上游 sendToTTS 一致固定 localhost（TTS 与编辑器同机）。 */
const TTS_COMMAND_HOST = 'localhost';
/** 入站监听主机：与上游 listen(39998, 'localhost') 一致。 */
const TTS_EDITOR_HOST = 'localhost';

/**
 * 降级 bind 模式的传输层：临时绑 39998 收 TTS 主动推送，出站仍直发 39999。
 *
 * 用法：`onMessage` 注册入站回调 → `start()` 起监听（resolve 即已 listening）
 * → `send()` 直发 TTS 39999 → dispose / 切回 hub 模式时 `stop()`。
 */
export class ServerTransport implements ITransport {
  /** 监听中的 server；构造时创建（上游同款），start() 时才 listen。 */
  private readonly _server: net.Server;
  /** 在途 TTS 短连接（stop 时统一断开，避免 close 等待未结束的连接）。 */
  private readonly _sockets = new Set<net.Socket>();
  /** start() 并发去重：listen 在途时返回同一个 Promise（重复 start 幂等）。 */
  private _starting: Promise<void> | null = null;
  /** 入站消息单分发槽位（与上游唯一 handleMessage 分发点语义一致）。 */
  private _messageHandler: ((msg: TTSTypes.GenericTTSMessage) => void) | null = null;

  /**
   * @param port - 监听端口，默认 39998（上游 _serverPort）；测试 / 特殊部署
   *   可注入其他端口。
   */
  constructor(readonly port: number = TTS_EDITOR_PORT) {
    this._server = net.createServer(socket => this._accept(socket));
  }

  /**
   * 启动监听（'localhost'，与上游同址）；resolve 即开始收 TTS 推送。
   *
   * - EADDRINUSE（如另一个 TTSLua / Atom 实例或 tts-hub 已占 39998）：按上游
   *   isServerRunning 同语义弹模态错误框后 resolve——server 未监听，
   *   isConnected() 保持 false，与上游 resolve(false) 不抛错的行为一致；
   * - 其余 listen 错误：记日志（上游同款 `[TTSLua] Server ${err}`）并 reject。
   */
  start(): Promise<void> {
    if (this._server.listening) return Promise.resolve();
    if (this._starting) return this._starting;
    this._starting = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this._server.removeListener('listening', onListening);
        this._server.removeListener('error', onError);
      };
      const onListening = () => {
        cleanup();
        console.log(`[TTSLua] ServerTransport listening on ${this.port}`);
        resolve();
      };
      const onError = (err: NodeJS.ErrnoException) => {
        cleanup();
        if (err.code === 'EADDRINUSE') {
          // 与上游 isServerRunning 逐字同款的弹窗
          vscode.window.showErrorMessage('Another instance of TTSLua or Atom is already running', {
            modal: true,
            detail: 'Please close the other instance and try again.',
          });
          resolve();
        } else {
          console.error(`[TTSLua] Server ${err}`);
          reject(err);
        }
      };
      this._server.once('listening', onListening);
      this._server.once('error', onError);
      this._server.listen(this.port, TTS_EDITOR_HOST);
    }).finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  /**
   * 停止监听：先断开所有在途连接再 close，等 'close' 落地后返回（句柄已释放）。
   * 幂等，可重复调用；未监听时直接返回。
   */
  async stop(): Promise<void> {
    for (const socket of this._sockets) socket.destroy();
    this._sockets.clear();
    if (!this._server.listening) return;
    await new Promise<void>(resolve => this._server.close(() => resolve()));
  }

  /** 注册入站消息回调；重复注册时后者覆盖前者（单分发槽位）。 */
  onMessage(handler: (msg: TTSTypes.GenericTTSMessage) => void): void {
    this._messageHandler = handler;
  }

  /**
   * 发送出站消息到 TTS 本体的 39999 端口（与 ClientTransport.send / 上游
   * sendToTTS 同款「连 → 写 → destroy」，不接响应；destroy 推迟到写回调，
   * 确保 SaveAndPlay 的大载荷完整刷入内核后再断开）。与监听状态无关。
   */
  send(messageID: TTSTypes.TxMsgType, object?: object): Promise<void> {
    const payload = JSON.stringify({messageID, ...object});
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const client = net.connect(TTS_COMMAND_PORT, TTS_COMMAND_HOST);
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        client.destroy();
        if (err) reject(err);
        else resolve();
      };
      client.on('connect', () => {
        client.write(payload, err => settle(err ?? undefined));
      });
      client.on('error', err => settle(err));
    });
  }

  /** 监听是否在位（与上游以 server.listening 判定运行状态一致）。 */
  isConnected(): boolean {
    return this._server.listening;
  }

  /**
   * 接收入站连接：按上游方式累积字节，'close' 时一次 JSON.parse 全量载荷，
   * 解析成功即经 onMessage 上抛（上游此处直接调 handleMessage）。
   */
  private _accept(socket: net.Socket): void {
    this._sockets.add(socket);
    const chunks: Buffer[] = [];
    // 防御：上游未挂 error 监听，对端 RST / 半开连接不应击穿扩展宿主
    socket.on('error', (err: Error) => {
      console.error(`[TTSLua] Server socket ${err}`);
    });
    socket.on('data', (data: Buffer) => chunks.push(data));
    socket.on('close', () => {
      this._sockets.delete(socket);
      // 防御：空载荷（如探活连接）或坏 JSON 只记日志跳过，不中断监听
      const raw = Buffer.concat(chunks).toString();
      if (raw.length === 0) return;
      let msg: TTSTypes.GenericTTSMessage;
      try {
        msg = JSON.parse(raw) as TTSTypes.GenericTTSMessage;
      } catch (err) {
        console.error(`[TTSLua] Bad JSON from TTS (${(err as Error).message}):\n${raw}`);
        return;
      }
      if (this._messageHandler) this._messageHandler(msg);
    });
  }
}
