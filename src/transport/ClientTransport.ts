// src/transport/ClientTransport.ts
/**
 * T2：hub 39997 的客户端传输实现（ITransport 的 hub 模式）；send 仍走 39999。
 *
 * 与上游 TTSAdapter 的 `net.Server`（监听 39998 收 TTS 主动推送）方向相反，
 * 本类作为 `net.Socket` 主动连接 hub 的 39997 TCP 扇出端口收消息：
 *
 * - 下行（TTS→编辑器）：hub 39997 是裸 TCP 字节流、不带任何分隔符（见
 *   tts-toolkit/src/hub/fanout.ts L7），socket 的 'data' 原样喂给
 *   JsonStreamDecoder 分帧，解出的完整 JSON 对象经 onMessage 注册的回调上抛；
 * - 上行（编辑器→TTS）：send() 与上游 sendToTTS 同行为——直连 TTS 本体的
 *   39999 端口，连 → 写 → destroy，不接响应。绝不走 hub 39997 反向发送，
 *   hub 39997 是单向扇出通道；
 * - 断线与重连：可选注入 IConnectionStateMachine（T4 的 ConnectionStateMachine）。
 *   连接成功 → notifyConnected；意外断开（非主动 stop 的 'close'）→
 *   notifyDisconnected，返回 true 时由本类调 scheduleReconnect 安排下次建连
 *   （指数退避由状态机负责）；首连失败时状态机处于 disconnected 会返回 false，
 *   是否重连 / 降级由上层按 config.fallback 决定（T4 契约）；
 * - 主动 stop()：销毁 socket、复位状态机并清 decoder，不计为掉线、不触发重连；
 * - 不实现应用层心跳（用户裁决）。
 *
 * 本文件不依赖 vscode 模块：HubConfig / TTSTypes / ITransport /
 * IConnectionStateMachine 均为 type-only 导入（编译后不产生 require），
 * 运行时只依赖 net 与同目录的 JsonStreamDecoder，保证单测可在纯 Node
 * （npx mocha --ui tdd）下独立运行。
 */
import * as net from 'net';

import type {HubConfig} from '@/config';
import type * as TTSTypes from '@/TTSTypes';
import type {IConnectionStateMachine} from './ConnectionStateMachine';
import type {ITransport} from './ITransport';

import {JsonStreamDecoder} from './JsonStreamDecoder';

/** TTS 命令端口：出站消息（GetScripts / SaveAndPlay / CustomMessage / ExecuteLua）直连 TTS 本体。 */
const TTS_COMMAND_PORT = 39999;
/** 出站目标主机：与上游 sendToTTS 一致固定 localhost（TTS 与编辑器同机）。 */
const TTS_COMMAND_HOST = 'localhost';

/**
 * hub 39997 的客户端传输。
 *
 * 用法：`onMessage` 注册入站回调 → `start()` 建连（resolve 即已连上）→
 * `send()` 直发 TTS 39999 → 退出 / dispose 时 `stop()`。
 */
export class ClientTransport implements ITransport {
  /** 当前扇出连接；未连接 / 已断开为 null。 */
  private _socket: net.Socket | null = null;
  /** isConnected 的依据：'connect' 置 true，'close' / stop 置 false。 */
  private _connected = false;
  /** 主动 stop 进行中：其触发的 'close' 不算掉线、不进重连流程。 */
  private _stopping = false;
  /** 入站消息单分发槽位（与上游唯一 handleMessage 分发点语义一致）。 */
  private _messageHandler: ((msg: TTSTypes.GenericTTSMessage) => void) | null = null;
  /** 裸 TCP 字节流的 JSON 分帧器（跨 chunk 续扫、坏帧宽松续流）。 */
  private readonly _decoder = new JsonStreamDecoder();

  constructor(private config: HubConfig, private stateMachine?: IConnectionStateMachine) {
    this._decoder.on('message', msg => this._dispatch(msg));
    this._decoder.on('error', (err, raw) =>
      console.error(`[TTSLua] Bad frame from hub (${err.message}):\n${raw}`)
    );
  }

  /** 连接 hub 扇出端口；resolve 即已连上，首连失败时以该错误 reject。 */
  start(): Promise<void> {
    if (this._socket) {
      // 幂等：建连中 / 已连接时重复 start 直接成功
      return Promise.resolve();
    }
    this._stopping = false;
    this._decoder.reset();
    return new Promise<void>((resolve, reject) => {
      const socket = net.connect(this.config.port, this.config.host);
      this._socket = socket;
      // promise 只 settle 一次；'error' 监听此后仍须挂着（避免击穿进程），
      // 统一交给随后的 'close' 走断开清理
      let settled = false;
      const onConnect = () => {
        if (settled) return;
        settled = true;
        this._connected = true;
        this.stateMachine?.notifyConnected();
        resolve();
      };
      const onError = (err: Error) => {
        if (!settled) {
          // 首连失败（如 ECONNREFUSED）：让 start() 以该错误拒绝
          settled = true;
          reject(err);
        } else {
          console.error(`[TTSLua] Hub connection error: ${err.message}`);
        }
      };
      socket.once('connect', onConnect);
      socket.on('error', onError);
      socket.on('data', chunk => this._decoder.push(chunk));
      socket.on('close', () => {
        // 只认当前 socket 的 close；旧 socket 的残留事件直接忽略
        if (this._socket !== socket) return;
        this._handleUnexpectedClose();
      });
    });
  }

  /** 主动断开：销毁 socket、复位状态机并清 decoder。幂等，可重复调用。 */
  async stop(): Promise<void> {
    this._stopping = true;
    this.stateMachine?.cancelReconnect();
    // 主动断开不计掉线（不调 notifyDisconnected，避免触发重连）；
    // reset 顺带把状态机拉回 disconnected，供下次 start 干净起步
    this.stateMachine?.reset();
    const socket = this._socket;
    this._socket = null;
    this._connected = false;
    if (socket && !socket.destroyed) {
      // 等 'close' 落地再返回，保证句柄已释放（服务端也随即看到断开）
      await new Promise<void>(resolve => {
        socket.once('close', () => resolve());
        socket.destroy();
      });
    }
    this._decoder.reset();
  }

  /** 注册入站消息回调；重复注册时后者覆盖前者（单分发槽位）。 */
  onMessage(handler: (msg: TTSTypes.GenericTTSMessage) => void): void {
    this._messageHandler = handler;
  }

  /**
   * 发送出站消息到 TTS 本体的 39999 端口（与上游 sendToTTS 同款
   * 「连 → 写 → destroy」，不接响应；destroy 推迟到写回调，确保 SaveAndPlay
   * 的大载荷完整刷入内核后再断开）。与 hub 连接状态无关，未 start 也可用。
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

  /** 当前 hub 扇出连接是否存活。 */
  isConnected(): boolean {
    return this._connected;
  }

  /** 把分帧出的 JSON 对象上抛给 onMessage 注册的回调。 */
  private _dispatch(msg: object): void {
    if (this._messageHandler) this._messageHandler(msg as TTSTypes.GenericTTSMessage);
  }

  /** 意外断开（非主动 stop）：清状态并按状态机契约驱动重连。 */
  private _handleUnexpectedClose(): void {
    this._socket = null;
    this._connected = false;
    this._decoder.reset();
    if (this._stopping) return; // 防御：主动 stop 的 close 不走这里
    console.log('[TTSLua] Hub connection closed');
    if (!this.stateMachine) return;
    // 首连失败（disconnected）时返回 false：是否重连 / 降级由上层决定
    if (this.stateMachine.notifyDisconnected()) {
      this.stateMachine.scheduleReconnect(() => {
        if (this._stopping) return;
        // 建连失败由 'close' → notifyDisconnected 驱动下一轮退避，此处吞 rejection
        this.start().catch(() => {});
      });
    }
  }
}
