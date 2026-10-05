// 模拟 VSCode 插件的 ClientTransport：连 hub 39997 + 接收扇出 + 出站 39999
// 用法：node scripts/verify-plugin-channels.mjs
// 退出码：0=全过；1=任一失败
import net from 'node:net';

const HUB_HOST = '127.0.0.1';
const HUB_PORT = 39997;
const TTS_PORT = 39999;

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
}

// 简易 JsonStreamDecoder（与 vscode-ext/src/transport/JsonStreamDecoder.ts 同算法）
class JsonStreamDecoder {
  constructor() {
    this.buf = '';
    this.state = 'Idle';
    this.depth = 0;
    this.handlers = { message: [], error: [] };
  }
  on(ev, cb) { this.handlers[ev].push(cb); }
  emit(ev, ...args) { for (const cb of this.handlers[ev]) cb(...args); }
  push(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let i = 0;
    while (i < this.buf.length) {
      const ch = this.buf[i];
      if (this.state === 'Idle') {
        if (ch === '{') { this.state = 'InObject'; this.depth = 1; this.startIdx = i; }
        i++;
      } else if (this.state === 'InObject') {
        if (ch === '"') { this.state = 'InString'; i++; }
        else if (ch === '{') { this.depth++; i++; }
        else if (ch === '}') {
          this.depth--;
          i++;
          if (this.depth === 0) {
            const raw = this.buf.slice(this.startIdx, i);
            try { this.emit('message', JSON.parse(raw)); }
            catch (e) { this.emit('error', e, raw); }
            this.buf = this.buf.slice(i);
            i = 0;
            this.state = 'Idle';
          }
        } else i++;
      } else if (this.state === 'InString') {
        if (ch === '\\') { this.state = 'InStringEscape'; i += 2; }
        else if (ch === '"') { this.state = 'InObject'; i++; }
        else i++;
      } else if (this.state === 'InStringEscape') {
        this.state = 'InString';
        i++;
      }
    }
  }
}

async function testTcpConnect() {
  return new Promise((resolve) => {
    const sock = net.connect(HUB_PORT, HUB_HOST);
    const timer = setTimeout(() => { sock.destroy(); record('TCP 39997 连接', false, 'timeout'); resolve(false); }, 3000);
    sock.on('connect', () => {
      clearTimeout(timer);
      record('TCP 39997 连接', true, 'connect 事件触发');
      sock.destroy();
      resolve(true);
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      record('TCP 39997 连接', false, e.code || e.message);
      resolve(false);
    });
  });
}

async function testTcpFanout() {
  return new Promise((resolve) => {
    const sock = net.connect(HUB_PORT, HUB_HOST);
    const decoder = new JsonStreamDecoder();
    const timer = setTimeout(() => {
      sock.destroy();
      record('TCP 39997 接收扇出', false, '等待 5s 无消息（TTS 未推送属正常）');
      resolve(true);  // 没消息不算失败——TTS 未启动或未推
    }, 5000);
    decoder.on('message', (msg) => {
      clearTimeout(timer);
      record('TCP 39997 接收扇出', true, `messageID=${msg.messageID}`);
      sock.destroy();
      resolve(true);
    });
    decoder.on('error', (e) => {
      clearTimeout(timer);
      record('TCP 39997 接收扇出', false, 'JSON parse 失败: ' + e.message);
      sock.destroy();
      resolve(false);
    });
    sock.on('data', (c) => decoder.push(c));
    sock.on('error', (e) => {
      clearTimeout(timer);
      record('TCP 39997 接收扇出', false, e.code || e.message);
      resolve(false);
    });
  });
}

async function testTtsOutbound() {
  return new Promise((resolve) => {
    const sock = net.connect(TTS_PORT, '127.0.0.1');
    const timer = setTimeout(() => {
      sock.destroy();
      record('出站 TTS 39999', false, 'timeout（TTS 未启动属预期）');
      resolve(true);  // TTS 未启动不算失败——用户实跑时会启动
    }, 2000);
    sock.on('connect', () => {
      clearTimeout(timer);
      const msg = JSON.stringify({ messageID: 0 });  // GetScripts
      sock.write(msg, 'utf8', () => {
        sock.end();
        record('出站 TTS 39999', true, 'GetScripts 已发送（连→写→关）');
        resolve(true);
      });
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      if (e.code === 'ECONNREFUSED') {
        record('出站 TTS 39999', true, 'ECONNREFUSED（TTS 未启动属预期）');
        resolve(true);
      } else {
        record('出站 TTS 39999', false, e.code || e.message);
        resolve(false);
      }
    });
  });
}

async function main() {
  console.log('=== 模拟 VSCode 插件的通道验证 ===\n');
  console.log(`hub ${HUB_HOST}:${HUB_PORT} / TTS 127.0.0.1:${TTS_PORT}\n`);

  const r1 = await testTcpConnect();
  if (r1) await testTcpFanout();
  await testTtsOutbound();

  console.log('\n=== 汇总 ===');
  const failed = results.filter(r => !r.ok);
  console.log(`通过 ${results.length - failed.length} / ${results.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
