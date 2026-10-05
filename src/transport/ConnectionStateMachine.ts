// src/transport/ConnectionStateMachine.ts
/**
 * 连接状态机（Stage B / T4）：跟踪编辑器 ↔ hub 的连接生命周期，并为断线
 * 重连提供指数退避调度。
 *
 * 职责边界（Stage B 任务书）：
 * - 只做状态迁移与重连定时：本类 emit 'stateChange'，VSCode 状态栏的更新由
 *   上层（TTSAdapter / extension.ts）订阅后自行处理——本类不 import vscode；
 * - 由 ClientTransport（T5）驱动：net.Socket 的连接成败事件转成
 *   notifyConnected / notifyDisconnected 调用，断开后由调用方按本类返回值
 *   决定是否 scheduleReconnect；
 * - 不实现应用层心跳（用户裁决）：心跳保活属于传输层策略，不属于状态机。
 *
 * 状态迁移一览：
 * - disconnected --notifyConnected--> connected
 * - connected    --notifyDisconnected--> reconnecting（返回 true，退避清零）
 * - reconnecting --scheduleReconnect--> 定时器到 → connecting → 执行建连回调
 * - connecting   --notifyConnected--> connected（退避清零）
 * - connecting   --notifyDisconnected--> reconnecting（返回 true，退避翻倍）
 * - reconnecting --cancelReconnect--> disconnected（取消在途定时器）
 * - 任意状态     --reset--> disconnected（dispose 用，清定时器与退避计数）
 * - disconnected / reconnecting 上的 notifyDisconnected 返回 false：
 *   前者是「从未建连」（如启动时首次连 hub 失败，降级策略由上层按
 *   config.fallback 决定），后者是「重连已在途」（防重复安排）。
 *
 * 注意：任务书接口未提供 notifyEnteringConnecting 之类的方法，故 'connecting'
 * 只由重连定时器触发进入（回调开始建连的瞬间）；首次建连期间的展示语义由
 * 上层自行处理，本状态机只从 notifyConnected / notifyDisconnected 获知结果。
 *
 * 退避序列：100ms → 200 → 400 → 800 → … 封顶于 reconnectMaxMs（默认 30000）。
 * reconnectMaxMs 由调用方从 config.getHubConfig().reconnectMaxMs 读出后经
 * 构造器注入（本类不依赖 vscode 模块，保证单测可在纯 Node 下运行）；每次
 * 成功建连、或已建立的连接断开时，退避从头（100ms）重计。
 */
import * as events from 'events';

/** 连接状态机的四态。 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** 重连退避的默认封顶，与 config.getHubConfig().reconnectMaxMs 的默认值一致。 */
export const DEFAULT_RECONNECT_MAX_MS = 30000;

/** 重连退避基数：首次 100ms，其后每次翻倍，直到封顶。 */
const RECONNECT_BASE_DELAY_MS = 100;

/**
 * 连接状态机对外接口（Stage B 任务书契约，ClientTransport 依赖此接口而非
 * 具体实现）。
 */
export interface IConnectionStateMachine {
  /** 当前状态 */
  readonly state: ConnectionState;

  /** 状态变化时触发（供 VSCode 状态栏更新） */
  on(event: 'stateChange', listener: (s: ConnectionState) => void): this;

  /** 记录连接成功（由 ClientTransport 调用） */
  notifyConnected(): void;

  /** 记录连接断开（由 ClientTransport 调用），返回是否安排重连 */
  notifyDisconnected(): boolean;

  /** 安排一次重连（指数退避）；返回延迟毫秒数 */
  scheduleReconnect(cb: () => void): number;

  /** 取消 pending 的重连 */
  cancelReconnect(): void;

  /** 重置（用于 dispose） */
  reset(): void;
}

/**
 * hub 连接状态机（Node EventEmitter 风格）。
 *
 * 用法：ClientTransport 持有一个实例，socket 连接成功时调
 * {@link ConnectionStateMachine.notifyConnected}，断开 / 连接失败时调
 * {@link ConnectionStateMachine.notifyDisconnected}，返回 true 则调
 * {@link ConnectionStateMachine.scheduleReconnect} 安排下次建连；状态栏订阅
 * 'stateChange' 刷新显示；dispose 时调 {@link ConnectionStateMachine.reset}。
 */
export class ConnectionStateMachine extends events.EventEmitter implements IConnectionStateMachine {
  private _state: ConnectionState = 'disconnected';
  /** 已连续安排的重连次数（退避指数）；成功建连或已建立连接断开时清零。 */
  private _attempt = 0;
  /** 退避封顶毫秒数；构造器注入，非法值回落默认。 */
  private _maxReconnectMs: number;
  /** 在途重连定时器；无在途重连时为 null。 */
  private _timer: NodeJS.Timeout | null = null;
  /** 定时器到期后要执行的建连回调（与 _timer 同生命周期）。 */
  private _pendingCb: (() => void) | null = null;

  /**
   * @param maxReconnectMs - 退避封顶毫秒数；调用方传入
   *   config.getHubConfig().reconnectMaxMs。0 / 负数 / NaN 等非法值回落默认
   *   30000，避免退避上限失效。
   */
  constructor(maxReconnectMs: number = DEFAULT_RECONNECT_MAX_MS) {
    super();
    this._maxReconnectMs =
      Number.isFinite(maxReconnectMs) && maxReconnectMs > 0
        ? maxReconnectMs
        : DEFAULT_RECONNECT_MAX_MS;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /** 状态变化时触发（供 VSCode 状态栏更新）。 */
  on(event: 'stateChange', listener: (s: ConnectionState) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  /** 事件分发（带类型标注，供内部 emit 使用）。 */
  emit(event: 'stateChange', state: ConnectionState): boolean;
  emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  /**
   * 记录连接成功（由 ClientTransport 调用）：清退避计数、取消可能在途的
   * 重连定时器（防御：绝不在已连接后二次建连），迁移到 'connected'。
   * 幂等：已在 'connected' 时不重复 emit。
   */
  notifyConnected(): void {
    this._clearTimer();
    this._attempt = 0;
    this._transition('connected');
  }

  /**
   * 记录连接断开（由 ClientTransport 调用）。
   * @returns 是否应安排重连：仅当「已建立的连接断开」（connected）或
   *   「重连尝试失败」（connecting）时为 true，此时调用方应接着调
   *   scheduleReconnect；reconnecting 上重复断开（如 'error' 与 'close'
   *   连发）或从未建连（disconnected）返回 false，防止重复安排。
   */
  notifyDisconnected(): boolean {
    switch (this._state) {
      case 'connected':
        // 已建立的连接断开：进入新一轮重连周期，退避从头计
        this._attempt = 0;
        this._transition('reconnecting');
        return true;
      case 'connecting':
        // 'connecting' 只由重连定时器触发进入，此处必为重连尝试失败
        this._transition('reconnecting');
        return true;
      default:
        // reconnecting：重连已在途；disconnected：本就未建连
        return false;
    }
  }

  /**
   * 安排一次重连（指数退避）：100ms 起每次翻倍，封顶 maxReconnectMs；
   * 重复调用时替换旧定时器，绝不并发两个在途重连。定时器到期时先迁移到
   * 'connecting' 再执行回调（回调内发起建连尝试，其成败经 notifyConnected /
   * notifyDisconnected 回报本状态机）。
   * @param cb - 定时器到期后执行的建连回调
   * @returns 本次安排的延迟毫秒数（供日志与测试断言）
   */
  scheduleReconnect(cb: () => void): number {
    this._clearTimer();
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this._attempt, this._maxReconnectMs);
    this._attempt++;
    this._pendingCb = cb;
    this._transition('reconnecting');
    this._timer = setTimeout(() => {
      this._timer = null;
      const fn = this._pendingCb;
      this._pendingCb = null;
      this._transition('connecting');
      if (fn) {
        fn();
      }
    }, delay);
    return delay;
  }

  /**
   * 取消 pending 的重连：清掉在途定时器；若处于 'reconnecting' 则回落到
   * 'disconnected'（状态栏不应停留在「重连中」）。
   */
  cancelReconnect(): void {
    if (this._clearTimer() && this._state === 'reconnecting') {
      this._transition('disconnected');
    }
  }

  /** 重置（用于 dispose）：清定时器与退避计数，回到 'disconnected'。 */
  reset(): void {
    this._clearTimer();
    this._attempt = 0;
    this._transition('disconnected');
  }

  /** 迁移状态；仅在实际变化时 emit 'stateChange'（幂等）。 */
  private _transition(next: ConnectionState): void {
    if (this._state === next) {
      return;
    }
    this._state = next;
    this.emit('stateChange', next);
  }

  /** 清除在途重连定时器；返回是否确有定时器被清除。 */
  private _clearTimer(): boolean {
    if (this._timer === null) {
      return false;
    }
    clearTimeout(this._timer);
    this._timer = null;
    this._pendingCb = null;
    return true;
  }
}
