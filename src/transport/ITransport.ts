/**
 * 协议适配层的传输层接口抽象（Stage A / T1.2）。
 *
 * TTSAdapter 目前直接持有 `net.Server`（监听 39998 收 TTS 推送）。
 * 本接口把「字节如何到达」与「消息如何被消费」解耦：
 * T1.3 将让 TTSAdapter 依赖 ITransport 而非具体的 server 实现，
 * 后续 Stage 再分别提供基于 `net.Server`（兼容上游直连 TTS）与
 * 基于 `net.Socket`（主动连 hub 39997 收扇出）的实现。
 *
 * 本文件只有接口定义，不含任何实现代码。
 */
import * as TTSTypes from '@/TTSTypes';

export interface ITransport {
  /** 启动传输层（连接 / 监听） */
  start(): Promise<void>;

  /** 停止传输层（断开 / 关闭） */
  stop(): Promise<void>;

  /** 注册入站消息回调（TTS→编辑器） */
  onMessage(handler: (msg: TTSTypes.GenericTTSMessage) => void): void;

  /** 发送出站消息到 TTS（编辑器→TTS 39999） */
  send(messageID: TTSTypes.TxMsgType, object?: object): Promise<void>;

  /** 当前是否已连接 */
  isConnected(): boolean;
}
