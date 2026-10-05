// src/transport/JsonStreamDecoder.ts
/**
 * JSON 流分帧解码器：把 hub 扇出的裸 TCP 字节流切成一条条完整的 JSON 对象。
 *
 * 背景：hub 的 TCP 下行通道（默认 39997）把每条 TTS 入站消息序列化为 JSON
 * 字符串后原样写入 socket，不带换行等任何分隔符（见
 * tts-toolkit/src/hub/fanout.ts L7）。因此分帧不依赖分隔符，改用
 * brace counter + 字符串字面量跳过：
 *
 * - 状态机：Idle / InObject / InString / InStringEscape；
 * - Idle 遇 `{` 进入 InObject 并使 brace 计数 +1，InObject 遇 `}` 计数 -1，
 *   计数归 0 时一个完整 JSON 对象就绪，emit 'message'；
 * - 字符串字面量跳过：`"` 进入 InString，字符串内的 `{` / `}` 不参与计数；
 *   InString 中遇 `\` 进入 InStringEscape，转义的第二字符（如 `\"` 的引号、
 *   `\\` 的反斜杠）被消费后回到 InString，从而不误判字符串边界；
 * - 跨 chunk：半帧保留在内部缓冲，下一次 push 续接；多字节 UTF-8 字符被
 *   TCP 分包拆开时由 StringDecoder 兜底；
 * - 宽松模式（用户裁决）：JSON.parse 失败时 emit 'error'（含原始帧与错误），
 *   随后回到 Idle 继续扫描下一个 `{`，坏帧绝不卡死流；
 * - 不实现应用层心跳（用户裁决），也不感知消息语义
 *   （InboundId 分发表由协议层处理）。
 */
import * as events from 'events';
import {StringDecoder} from 'string_decoder';

/**
 * 分帧状态机四态。
 *
 * 不变量：state 为 InObject 时 brace 计数恒 ≥ 1；InString ⇔ 当前处于
 * JSON 字符串字面量内部（含其转义态）。
 */
export enum DecoderState {
  /** 帧外：丢弃噪声，等待下一帧的起始 `{`。 */
  Idle = 0,
  /** 帧体内：`{` / `}` 参与 brace 计数。 */
  InObject = 1,
  /** 字符串字面量内：`{` / `}` 不计数，只认 `"` 与 `\`。 */
  InString = 2,
  /** 字符串内转义的第二字符：仅消费一个字符后回到 InString。 */
  InStringEscape = 3,
}

/**
 * hub 扇出字节流的 JSON 分帧解码器（Node EventEmitter 风格）。
 *
 * 用法：把 net.Socket 的 'data' 事件原样喂给 {@link JsonStreamDecoder.push}，
 * 监听 'message' 收完整 JSON 对象、监听 'error' 收坏帧（宽松模式不中断流），
 * 重连时调 {@link JsonStreamDecoder.reset} 清空半帧与转义状态。
 */
export class JsonStreamDecoder extends events.EventEmitter {
  private _state: DecoderState = DecoderState.Idle;
  /** 当前帧的 brace 计数（InObject 状态下恒 ≥ 1，其余状态为 0）。 */
  private _depth = 0;
  /** 尚未消费完的原始文本（帧外噪声 + 进行中的半帧）。 */
  private _buf = '';
  /** 当前帧起始 `{` 在 _buf 中的下标；无进行中帧时为 -1。 */
  private _frameStart = -1;
  /** 扫描游标：_buf 中已扫描到的下标（下一次 push 从这里续扫）。 */
  private _scanned = 0;
  /** UTF-8 增量解码器：处理多字节字符被 TCP 分包拆到两个 chunk 的情况。 */
  private _decoder = new StringDecoder('utf8');

  /** 当解析出完整 JSON 对象时触发。 */
  on(event: 'message', listener: (msg: object) => void): this;
  /** 当 JSON.parse 失败时触发（含原始字符串与错误）。 */
  on(event: 'error', listener: (err: Error, raw: string) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  /** 事件分发（带类型标注，供内部 emit 使用）。 */
  emit(event: 'message', msg: object): boolean;
  emit(event: 'error', err: Error, raw: string): boolean;
  emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  /**
   * 喂入字节块；可能跨 chunk 边界（半帧留在内部缓冲，下一次 push 续接）。
   * @param chunk - TCP 下行收到的原始字节（或直接给字符串，便于测试）
   */
  push(chunk: Buffer | string): void {
    // StringDecoder 只收 Buffer（@types/node@18 签名如此）；字符串本就是
    // 完整文本直接透传。生产路径（socket 'data' 事件）恒为 Buffer。
    const text = typeof chunk === 'string' ? chunk : this._decoder.write(chunk);
    this._buf += text;
    const frames = this._scan();
    // 扫描与分发分离：监听器若在回调里重入 push，也不会破坏扫描游标
    for (const raw of frames) this._dispatch(raw);
  }

  /**
   * 重置内部状态（用于重连）：丢弃半帧、字符串 / 转义状态与
   * 未完成的多字节 UTF-8 前缀。
   */
  reset(): void {
    this._state = DecoderState.Idle;
    this._depth = 0;
    this._buf = '';
    this._frameStart = -1;
    this._scanned = 0;
    this._decoder = new StringDecoder('utf8');
  }

  /**
   * 从扫描游标起对缓冲区逐字符跑状态机，返回本次扫出的就绪帧
   * （原始字符串，含首尾花括号），并把游标与缓冲压缩结果提交回实例字段。
   */
  private _scan(): string[] {
    const frames: string[] = [];
    const buf = this._buf;
    let state = this._state;
    let depth = this._depth;
    let frameStart = this._frameStart;
    let i = this._scanned;
    while (i < buf.length) {
      const ch = buf[i];
      i++;
      switch (state) {
        case DecoderState.Idle:
          if (ch === '{') {
            state = DecoderState.InObject;
            depth = 1;
            frameStart = i - 1;
          }
          break;
        case DecoderState.InObject:
          if (ch === '{') {
            depth++;
          } else if (ch === '}') {
            depth--;
            if (depth === 0) {
              // brace 计数归 0：一个完整 JSON 对象就绪
              frames.push(buf.slice(frameStart, i));
              state = DecoderState.Idle;
              frameStart = -1;
            }
          } else if (ch === '"') {
            state = DecoderState.InString;
          }
          break;
        case DecoderState.InString:
          if (ch === '\\') {
            state = DecoderState.InStringEscape;
          } else if (ch === '"') {
            state = DecoderState.InObject;
          }
          break;
        case DecoderState.InStringEscape:
          // 转义的第二字符（" \ u 等）按普通字符消费，不改变状态
          state = DecoderState.InString;
          break;
      }
    }
    // 提交扫描结果
    this._state = state;
    this._depth = depth;
    this._scanned = i;
    this._frameStart = frameStart;
    // 压缩缓冲：无进行中帧则整段丢弃（已扫描部分全是帧外噪声），
    // 否则只保留从帧头开始的半帧，游标随之前移
    if (frameStart === -1) {
      this._buf = '';
      this._scanned = 0;
    } else if (frameStart > 0) {
      this._buf = buf.slice(frameStart);
      this._scanned = i - frameStart;
      this._frameStart = 0;
    }
    return frames;
  }

  /**
   * 分发一帧就绪文本：JSON.parse 成功则 emit 'message'；失败则按宽松模式
   * emit 'error'（原始帧 + 错误）后返回——扫描已回到 Idle，继续找下一个 `{`。
   * @param raw - 就绪帧的原始字符串（含首尾花括号）
   */
  private _dispatch(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      this.emit(
        'error',
        err instanceof Error ? err : new Error(`JSON parse failed: ${String(err)}`),
        raw
      );
      return;
    }
    this.emit('message', msg as object);
  }
}
