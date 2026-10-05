// src/test/suite/ClientTransport.test.ts
/**
 * ClientTransport 单测（纯 Node，不依赖 vscode 模块、不依赖真实 39997 端口）。
 *
 * hub 侧用 net.createServer 起本地测试服务器（ephemeral 端口）模拟扇出字节流；
 * 唯一例外是 send 用例——出站端口 39999 在 ClientTransport 内硬编码（与上游
 * sendToTTS 一致，无法注入），因此该用例真实占用 39999（被占用时跳过）。
 * HubConfig 以字面量对象注入；状态机用记录调用的 MockStateMachine，另接两条
 * 真实 ConnectionStateMachine 用例验证「首连失败不自动重连」与「断线自动重连」。
 * 与 src/test/suite/JsonStreamDecoder.test.ts 同模板：Mocha TDD UI（suite / test 全局），
 * 相对路径导入保证 tsc 编译后可在纯 Node（npx mocha --ui tdd）下独立运行。
 */
import * as assert from 'assert';
import * as events from 'events';
import * as net from 'net';

import * as TTSTypes from '../../TTSTypes';
import {ClientTransport} from '../../transport/ClientTransport';
import {ConnectionStateMachine} from '../../transport/ConnectionStateMachine';
import type {
  ConnectionState,
  IConnectionStateMachine,
} from '../../transport/ConnectionStateMachine';
import type {HubConfig} from '../../config';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 轮询等待条件成立；超时抛错（避免用例静默挂到 mocha 全局超时）。 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`);
    await sleep(10);
  }
}

/** HubConfig 字面量：不经过 vscode 配置系统（transport 层只依赖该形状）。 */
function makeConfig(port: number): HubConfig {
  return {host: '127.0.0.1', port, fallback: 'prompt', reconnectMaxMs: 30000};
}

/** 取一个当前无监听的端口：listen(0) 占位拿端口号，随后关闭供连接失败用例使用。 */
async function getClosedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const {port} = server.address() as net.AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** 本地测试服务器：模拟 hub 扇出（或 TTS 39999 入站），记录连接与收到的字节。 */
interface TestServer {
  server: net.Server;
  port: number;
  /** 服务端视角的入站连接（按到达顺序） */
  connections: net.Socket[];
  /** 已关闭的入站连接 */
  closed: net.Socket[];
  /** 收到的全部数据块（按到达顺序，断言时用 Buffer.concat 拼接） */
  received: Buffer[];
  /** 销毁所有连接并关闭监听 */
  close(): Promise<void>;
}

/**
 * 起一个本地测试服务器。
 * @param port - 0（默认）由系统分配 ephemeral 端口并绑 127.0.0.1（hub 用例）；
 *   39999 用于出站用例：不指定绑址，双栈监听以兼容 'localhost' 的解析结果。
 * @param onConnection - 新连接建立时的回调（写入帧 / 模拟踢线等）。
 */
async function startTestServer(
  port = 0,
  onConnection?: (socket: net.Socket) => void
): Promise<TestServer> {
  const connections: net.Socket[] = [];
  const closed: net.Socket[] = [];
  const received: Buffer[] = [];
  const server = net.createServer(socket => {
    connections.push(socket);
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.on('close', () => closed.push(socket));
    // 客户端主动 destroy 可能带来 ECONNRESET / EPIPE，测试不关心
    socket.on('error', () => {});
    if (onConnection) onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (port === 0) server.listen(0, '127.0.0.1', () => resolve());
    else server.listen(port, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server failed to report a port');
  }
  return {
    server,
    port: address.port,
    connections,
    closed,
    received,
    close: () =>
      new Promise<void>(resolve => {
        for (const conn of connections) conn.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * 记录型假状态机：只数调用、不真正定时；scheduleReconnect 存回调待手动触发。
 * 继承 EventEmitter 并照 ConnectionStateMachine 的写法重写带类型的 on。
 */
class MockStateMachine extends events.EventEmitter implements IConnectionStateMachine {
  state: ConnectionState = 'disconnected';
  connectedCount = 0;
  disconnectedCount = 0;
  scheduledCount = 0;
  canceledCount = 0;
  resetCount = 0;
  /** notifyDisconnected 的返回值：是否应安排重连。 */
  willReconnect = true;
  readonly reconnectCallbacks: Array<() => void> = [];

  on(event: 'stateChange', listener: (s: ConnectionState) => void): this {
    return super.on(event, listener);
  }

  notifyConnected(): void {
    this.connectedCount++;
    this.state = 'connected';
  }

  notifyDisconnected(): boolean {
    this.disconnectedCount++;
    this.state = this.willReconnect ? 'reconnecting' : 'disconnected';
    return this.willReconnect;
  }

  scheduleReconnect(cb: () => void): number {
    this.scheduledCount++;
    this.reconnectCallbacks.push(cb);
    return 100;
  }

  cancelReconnect(): void {
    this.canceledCount++;
  }

  reset(): void {
    this.resetCount++;
  }
}

suite('ClientTransport', function () {
  this.timeout(10000);

  let cleanups: Array<() => Promise<void>>;
  setup(() => {
    cleanups = [];
  });
  teardown(async () => {
    // 逆序清理：先停 transport，再关测试服务器
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });
  const defer = (fn: () => Promise<void>) => {
    cleanups.push(fn);
  };

  suite('start / isConnected', () => {
    test('connects to the hub and flips isConnected on; repeated start is idempotent', async () => {
      const hub = await startTestServer();
      defer(() => hub.close());
      const transport = new ClientTransport(makeConfig(hub.port));
      defer(() => transport.stop());

      assert.strictEqual(transport.isConnected(), false);
      await Promise.all([transport.start(), transport.start()]);
      assert.strictEqual(transport.isConnected(), true);
      await waitFor(() => hub.connections.length > 0, 'hub sees the client');
      // 并发两次 start 只应建一条连接（幂等）
      assert.strictEqual(hub.connections.length, 1);
    });

    test('rejects with ECONNREFUSED when nothing listens on the hub port', async () => {
      const port = await getClosedPort();
      const transport = new ClientTransport(makeConfig(port));
      defer(() => transport.stop());

      await assert.rejects(transport.start(), (err: NodeJS.ErrnoException) => {
        assert.strictEqual(err.code, 'ECONNREFUSED');
        return true;
      });
      assert.strictEqual(transport.isConnected(), false);
    });

    test('isConnected flips off when the hub drops the connection', async () => {
      const hub = await startTestServer();
      defer(() => hub.close());
      const transport = new ClientTransport(makeConfig(hub.port));
      defer(() => transport.stop());

      await transport.start();
      assert.strictEqual(transport.isConnected(), true);
      hub.connections[0].destroy();
      await waitFor(() => !transport.isConnected(), 'isConnected to flip off');
    });
  });

  suite('inbound frames', () => {
    test('dispatches complete JSON frames pushed by the hub', async () => {
      // 两条帧拼在同一次 write 里：分帧不依赖写边界，也不依赖任何分隔符
      const hub = await startTestServer(0, conn => {
        conn.write('{"messageID":2,"message":"hello hub"}{"messageID":3,"message":"again"}');
      });
      defer(() => hub.close());
      const received: TTSTypes.GenericTTSMessage[] = [];
      const transport = new ClientTransport(makeConfig(hub.port));
      transport.onMessage(msg => received.push(msg));
      defer(() => transport.stop());

      await transport.start();
      await waitFor(() => received.length === 2, 'both frames dispatched');
      assert.deepStrictEqual(received, [
        {messageID: 2, message: 'hello hub'},
        {messageID: 3, message: 'again'},
      ]);
    });

    test('reassembles a JSON frame split across TCP chunks', async () => {
      // 40KB 大帧：即便没有写间隔也必然跨多个 TCP 段；拆分点故意落在帧体与
      // 字符串字面量中间，覆盖 JsonStreamDecoder 的跨 chunk 续扫
      const pad = 'x'.repeat(40000);
      const frame = JSON.stringify({messageID: TTSTypes.RxMsgType.ObjectPushed, pad});
      const hub = await startTestServer(0, conn => {
        conn.setNoDelay(true);
        conn.write(frame.slice(0, 7));
        setTimeout(() => conn.write(frame.slice(7, 25000)), 5);
        setTimeout(() => conn.end(frame.slice(25000)), 10);
      });
      defer(() => hub.close());
      const received: TTSTypes.GenericTTSMessage[] = [];
      const transport = new ClientTransport(makeConfig(hub.port));
      transport.onMessage(msg => received.push(msg));
      defer(() => transport.stop());

      await transport.start();
      await waitFor(() => received.length === 1, 'the split frame to be reassembled');
      const frameMsg = received[0] as unknown as {messageID: number; pad: string};
      assert.strictEqual(frameMsg.messageID, TTSTypes.RxMsgType.ObjectPushed);
      assert.strictEqual(frameMsg.pad, pad);
    });
  });

  suite('stop', () => {
    test('destroys the socket, flips isConnected off, and is idempotent', async () => {
      const hub = await startTestServer();
      defer(() => hub.close());
      const transport = new ClientTransport(makeConfig(hub.port));
      defer(() => transport.stop());

      await transport.start();
      assert.strictEqual(transport.isConnected(), true);
      await waitFor(() => hub.connections.length > 0, 'hub sees the client');

      await transport.stop();
      assert.strictEqual(transport.isConnected(), false);
      // 服务端视角：客户端的连接已断开
      await waitFor(() => hub.closed.length === 1, 'server-side socket closed');
      // 重复 stop 不抛错、也不重连
      await transport.stop();
      assert.strictEqual(transport.isConnected(), false);
    });
  });

  suite('state machine interaction', () => {
    test('drives connected → disconnected → scheduled reconnect → reconnected', async () => {
      const hub = await startTestServer();
      defer(() => hub.close());
      const csm = new MockStateMachine();
      const transport = new ClientTransport(makeConfig(hub.port), csm);
      defer(() => transport.stop());

      await transport.start();
      assert.strictEqual(csm.connectedCount, 1);
      assert.strictEqual(csm.disconnectedCount, 0);

      // hub 掉线 → 通知状态机并按返回值安排重连
      hub.connections[0].destroy();
      await waitFor(() => csm.disconnectedCount === 1, 'disconnect notification');
      assert.strictEqual(transport.isConnected(), false);
      assert.strictEqual(csm.scheduledCount, 1);

      // 退避到期：手动触发建连回调 → 重连成功 → 再次 notifyConnected
      csm.reconnectCallbacks[0]();
      await waitFor(() => csm.connectedCount === 2, 'reconnection');
      assert.strictEqual(transport.isConnected(), true);
      assert.strictEqual(hub.connections.length, 2);
    });

    test('stop cancels reconnects and resets the state machine without notifyDisconnected', async () => {
      const hub = await startTestServer();
      defer(() => hub.close());
      const csm = new MockStateMachine();
      const transport = new ClientTransport(makeConfig(hub.port), csm);

      await transport.start();
      await transport.stop();

      assert.strictEqual(csm.canceledCount, 1);
      assert.strictEqual(csm.resetCount, 1);
      // 主动断开不计掉线，也不安排重连
      assert.strictEqual(csm.disconnectedCount, 0);
      assert.strictEqual(csm.scheduledCount, 0);
      assert.strictEqual(transport.isConnected(), false);
    });

    test('notifies the state machine when the initial connect fails', async () => {
      const port = await getClosedPort();
      const csm = new MockStateMachine();
      const transport = new ClientTransport(makeConfig(port), csm);
      defer(() => transport.stop());

      await assert.rejects(transport.start(), /ECONNREFUSED/);
      // 首连失败同样经 'close' 通知状态机（是否安排重连由状态机决定）
      await waitFor(() => csm.disconnectedCount === 1, 'disconnect notification');
      assert.strictEqual(csm.scheduledCount, 1);
    });
  });

  suite('real ConnectionStateMachine integration', () => {
    test('initial connect failure does not schedule an automatic reconnect', async () => {
      const port = await getClosedPort();
      const csm = new ConnectionStateMachine(30000);
      const transport = new ClientTransport(makeConfig(port), csm);
      defer(() => transport.stop());

      await assert.rejects(transport.start(), /ECONNREFUSED/);
      // T4 契约：从未建连（disconnected）时 notifyDisconnected 返回 false，
      // 不自动重连——降级策略由上层按 config.fallback 决定
      await sleep(150);
      assert.strictEqual(csm.state, 'disconnected');
      assert.strictEqual(transport.isConnected(), false);
    });

    test('an established connection auto-reconnects after a drop', async () => {
      const hub = await startTestServer();
      defer(() => hub.close());
      const csm = new ConnectionStateMachine(30000);
      const transport = new ClientTransport(makeConfig(hub.port), csm);
      defer(() => transport.stop());

      await transport.start();
      hub.connections[0].destroy();

      // 首轮退避 100ms 后自动重连成功
      await waitFor(
        () => csm.state === 'connected' && hub.connections.length === 2,
        'automatic reconnection'
      );
      assert.strictEqual(transport.isConnected(), true);
    });
  });

  suite('send (outbound to TTS 39999)', () => {
    test('delivers the message to port 39999 and tears the connection down', async function (): Promise<void> {
      let tts: TestServer;
      try {
        tts = await startTestServer(39999);
      } catch (err) {
        // 39999 被占用（如真实 TTS 正在运行）时跳过：出站端口硬编码，无法改道
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') return this.skip();
        throw err;
      }
      defer(() => tts.close());

      // 出站通道与 hub 连接无关：无需 start() 即可发送
      const transport = new ClientTransport(makeConfig(0));
      defer(() => transport.stop());
      assert.strictEqual(transport.isConnected(), false);

      await transport.send(TTSTypes.TxMsgType.ExecuteLua, {script: 'print("hi")', guid: '-1'});
      await waitFor(() => tts.received.length > 0, 'TTS-side server to receive the payload');
      assert.deepStrictEqual(JSON.parse(Buffer.concat(tts.received).toString('utf8')), {
        messageID: TTSTypes.TxMsgType.ExecuteLua,
        script: 'print("hi")',
        guid: '-1',
      });
      // 连 → 写 → destroy：载荷刷完即断开
      await waitFor(() => tts.closed.length === 1, 'outbound connection torn down');
    });
  });
});
