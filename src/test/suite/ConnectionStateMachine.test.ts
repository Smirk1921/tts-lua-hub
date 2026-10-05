// src/test/suite/ConnectionStateMachine.test.ts
/**
 * ConnectionStateMachine 单测（纯 Node，不依赖 vscode 模块）。
 *
 * 任务书允许「jest-style 假定时器或缩短 reconnectMaxMs 加速测试」：本项目
 * 测试栈是 Mocha（compliance §五 禁止新增依赖，不引入 jest），且退避基数
 * 100ms 为任务书固定值、不随 reconnectMaxMs 缩放，故采用真实定时器：
 * - 退避序列直接断言 scheduleReconnect 的同步返回值，无需等待；
 * - 定时器触发 / 取消行为用 ≤300ms 的短真实等待验证（远小于 Mocha 默认
 *   2s 用例超时）。
 * 与 src/test/suite/JsonStreamDecoder.test.ts 同模板：Mocha TDD UI（suite /
 * test 全局）。每个用例结束前都 reset() 清掉在途定时器，避免挂起定时器
 * 拖慢 Mocha 进程退出。
 */
import * as assert from 'assert';

// 相对路径导入：tsc 编译后为 dist/test/suite -> dist/transport，
// 保证本用例可在纯 Node（npx mocha --ui tdd）下独立运行
import {
  ConnectionState,
  ConnectionStateMachine,
  DEFAULT_RECONNECT_MAX_MS,
  IConnectionStateMachine,
} from '../../transport/ConnectionStateMachine';

/** 空回调：仅用于占据 scheduleReconnect 的定时器。 */
const noop = (): void => undefined;

/** 等待真实毫秒数（Mocha 异步用例：返回 Promise 即可）。 */
function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

/** 带状态收集器的状态机实例，供各用例断言 stateChange 序列。 */
interface MachineCollector {
  sm: ConnectionStateMachine;
  /** 'stateChange' 事件按序收集到的状态。 */
  states: ConnectionState[];
}

/** 创建挂好 'stateChange' 收集器的状态机；不传封顶则用默认 30000。 */
function collect(maxReconnectMs?: number): MachineCollector {
  const states: ConnectionState[] = [];
  const sm =
    maxReconnectMs === undefined
      ? new ConnectionStateMachine()
      : new ConnectionStateMachine(maxReconnectMs);
  sm.on('stateChange', s => {
    states.push(s);
  });
  return {sm, states};
}

suite('ConnectionStateMachine', () => {
  suite('initial state', () => {
    test('starts disconnected and emits nothing', () => {
      const {sm, states} = collect();
      assert.strictEqual(sm.state, 'disconnected');
      assert.deepStrictEqual(states, []);
    });

    test('default cap aligns with config.getHubConfig default (30000)', () => {
      assert.strictEqual(DEFAULT_RECONNECT_MAX_MS, 30000);
      const {sm} = collect();
      sm.notifyConnected();
      sm.notifyDisconnected();
      assert.strictEqual(sm.scheduleReconnect(noop), 100); // 首次重连 100ms
      sm.cancelReconnect(); // 有在途定时器时取消，应回落 disconnected
      assert.strictEqual(sm.state, 'disconnected');
      sm.reset();
    });
  });

  suite('notifyConnected', () => {
    test('transitions disconnected -> connected and emits stateChange', () => {
      const {sm, states} = collect();
      sm.notifyConnected();
      assert.strictEqual(sm.state, 'connected');
      assert.deepStrictEqual(states, ['connected']);
    });

    test('is idempotent while already connected (no duplicate emit)', () => {
      const {sm, states} = collect();
      sm.notifyConnected();
      sm.notifyConnected();
      assert.strictEqual(sm.state, 'connected');
      assert.deepStrictEqual(states, ['connected']);
    });

    test('clears a pending reconnect timer and the backoff attempt', () => {
      const {sm} = collect();
      sm.scheduleReconnect(noop);
      sm.scheduleReconnect(noop); // attempt = 2，退避已达 400ms
      sm.notifyConnected(); // 成功建连：清定时器、退避清零
      assert.strictEqual(sm.state, 'connected');
      sm.notifyDisconnected();
      // 退避已重置：下一个重连延迟应从 100ms 重新开始
      assert.strictEqual(sm.scheduleReconnect(noop), 100);
      sm.reset();
    });
  });

  suite('notifyDisconnected', () => {
    test('from connected: returns true and transitions to reconnecting (first drop)', () => {
      const {sm, states} = collect();
      sm.notifyConnected();
      states.length = 0;
      assert.strictEqual(sm.notifyDisconnected(), true);
      assert.strictEqual(sm.state, 'reconnecting');
      assert.deepStrictEqual(states, ['reconnecting']);
    });

    test('from reconnecting: returns false without duplicate stateChange', () => {
      const {sm, states} = collect();
      sm.notifyConnected();
      sm.notifyDisconnected(); // 已进入 reconnecting
      states.length = 0;
      // 模拟 'error' 与 'close' 连发：第二次断开不得重复安排
      assert.strictEqual(sm.notifyDisconnected(), false);
      assert.strictEqual(sm.state, 'reconnecting');
      assert.deepStrictEqual(states, []);
    });

    test('from disconnected: returns false (never connected, fallback is up to caller)', () => {
      const {sm, states} = collect();
      // 启动时首次连 hub 失败：状态机停在 disconnected，由上层按
      // config.fallback 决定降级，状态机不自动重试
      assert.strictEqual(sm.notifyDisconnected(), false);
      assert.strictEqual(sm.state, 'disconnected');
      assert.deepStrictEqual(states, []);
    });

    test('from connecting (failed retry): returns true and goes back to reconnecting', async () => {
      const {sm, states} = collect();
      sm.notifyConnected();
      assert.strictEqual(sm.notifyDisconnected(), true);
      sm.scheduleReconnect(noop); // 100ms
      await delay(150); // 等定时器触发进入 connecting
      assert.strictEqual(sm.state, 'connecting');
      states.length = 0;
      assert.strictEqual(sm.notifyDisconnected(), true);
      assert.strictEqual(sm.state, 'reconnecting');
      assert.deepStrictEqual(states, ['reconnecting']);
      sm.reset();
    });
  });

  suite('scheduleReconnect backoff', () => {
    test('doubles from 100ms up to the default cap of 30000', () => {
      const {sm} = collect();
      const expected = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 30000, 30000];
      for (const ms of expected) {
        assert.strictEqual(sm.scheduleReconnect(noop), ms);
      }
      // 重复安排替换旧定时器而非叠加：最后仍只有一次 pending
      sm.reset();
    });

    test('caps at a custom maxReconnectMs', () => {
      const {sm} = collect(1000);
      const expected = [100, 200, 400, 800, 1000, 1000];
      for (const ms of expected) {
        assert.strictEqual(sm.scheduleReconnect(noop), ms);
      }
      sm.reset();
    });

    test('enters reconnecting even when scheduled from disconnected', () => {
      const {sm, states} = collect();
      assert.strictEqual(sm.scheduleReconnect(noop), 100);
      assert.strictEqual(sm.state, 'reconnecting');
      assert.deepStrictEqual(states, ['reconnecting']);
      sm.reset();
    });
  });

  suite('reconnect timer', () => {
    test('fires the callback once and enters connecting', async () => {
      const {sm, states} = collect();
      let fired = 0;
      sm.notifyConnected();
      states.length = 0; // 丢弃 setup 阶段的 'connected'
      sm.notifyDisconnected(); // → reconnecting
      assert.strictEqual(
        sm.scheduleReconnect(() => fired++),
        100
      );
      await delay(250);
      assert.strictEqual(fired, 1);
      assert.strictEqual(sm.state, 'connecting');
      assert.deepStrictEqual(states, ['reconnecting', 'connecting']);
      sm.reset();
    });

    test('full reconnect cycle emits the expected state sequence', async () => {
      const {sm, states} = collect();
      sm.notifyConnected();
      states.length = 0;
      // 断开 → 第 1 次重连（100ms）失败 → 第 2 次重连（200ms）成功
      assert.strictEqual(sm.notifyDisconnected(), true);
      assert.strictEqual(sm.scheduleReconnect(noop), 100);
      await delay(150);
      assert.strictEqual(sm.state, 'connecting');
      assert.strictEqual(sm.notifyDisconnected(), true); // 重连尝试失败
      assert.strictEqual(sm.scheduleReconnect(noop), 200); // 退避翻倍
      await delay(300);
      assert.strictEqual(sm.state, 'connecting');
      sm.notifyConnected(); // 重连成功
      assert.strictEqual(sm.state, 'connected');
      assert.deepStrictEqual(states, [
        'reconnecting',
        'connecting',
        'reconnecting',
        'connecting',
        'connected',
      ]);
      sm.reset();
    });
  });

  suite('cancelReconnect', () => {
    test('clears the pending timer and falls back to disconnected', async () => {
      const {sm, states} = collect();
      let fired = 0;
      sm.notifyConnected();
      sm.notifyDisconnected();
      sm.scheduleReconnect(() => fired++);
      sm.cancelReconnect();
      assert.strictEqual(sm.state, 'disconnected');
      assert.strictEqual(states[states.length - 1], 'disconnected');
      await delay(200); // 原定 100ms 触发，取消后必须保持静默
      assert.strictEqual(fired, 0);
      assert.strictEqual(sm.state, 'disconnected');
    });

    test('is a no-op when nothing is pending', () => {
      const {sm, states} = collect();
      sm.notifyConnected();
      states.length = 0;
      sm.cancelReconnect(); // 无在途定时器：状态与事件流均不受影响
      assert.strictEqual(sm.state, 'connected');
      assert.deepStrictEqual(states, []);
      sm.reset();
    });
  });

  suite('reset', () => {
    test('clears the pending timer and returns to disconnected', async () => {
      const {sm, states} = collect();
      let fired = 0;
      sm.notifyConnected();
      sm.notifyDisconnected();
      sm.scheduleReconnect(() => fired++);
      sm.reset();
      assert.strictEqual(sm.state, 'disconnected');
      await delay(200);
      assert.strictEqual(fired, 0);
      assert.strictEqual(states[states.length - 1], 'disconnected');
    });

    test('resets the backoff attempt to zero', () => {
      const {sm} = collect();
      sm.scheduleReconnect(noop);
      sm.scheduleReconnect(noop); // attempt = 2，退避 400ms
      sm.reset();
      // 若 reset 未清退避计数，这里会是 400
      assert.strictEqual(sm.scheduleReconnect(noop), 100);
      sm.reset();
    });

    test('emits disconnected only when the state actually changes', () => {
      const {sm, states} = collect();
      sm.notifyConnected();
      states.length = 0;
      sm.reset();
      assert.deepStrictEqual(states, ['disconnected']);
      sm.reset(); // 已是 disconnected：不重复 emit
      assert.deepStrictEqual(states, ['disconnected']);
    });
  });

  suite('interface conformance', () => {
    test('satisfies IConnectionStateMachine', () => {
      const sm: IConnectionStateMachine = new ConnectionStateMachine();
      assert.strictEqual(sm.state, 'disconnected');
      sm.notifyConnected();
      assert.strictEqual(sm.state, 'connected');
      sm.reset();
    });
  });
});
