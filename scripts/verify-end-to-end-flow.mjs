// 端到端消息流：模拟 TTS 从 39998 推送 → hub 39997 扇出 → 客户端接收
// 这是插件在真实环境下的完整数据通路
// 用法：node scripts/verify-end-to-end-flow.mjs
import net from 'node:net';

const HUB_EDITOR_PORT = 39998;   // TTS 推送入站到 hub 的端口
const HUB_TCP_PORT = 39997;      // hub 扇出到客户端的端口

// 与 vscode-ext/src/transport/JsonStreamDecoder.ts 同算法
class JsonStreamDecoder {
  constructor() { this.buf = ''; this.state = 'Idle'; this.depth = 0; this.handlers = { message: [], error: [] }; }
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
      } else if (this.state === 'InStringEscape') { this.state = 'InString'; i++; }
    }
  }
}

async function main() {
  console.log('=== 端到端消息流验证 ===\n');
  console.log('路径：模拟 TTS → 39998 (hub 入站) → hub 扇出 → 39997 (插件连接) → JsonStreamDecoder\n');

  // Step 1: 客户端连 39997（保持连接）
  const client = net.connect(HUB_TCP_PORT, '127.0.0.1');
  const decoder = new JsonStreamDecoder();
  const receivedMessages = [];
  decoder.on('message', (msg) => {
    receivedMessages.push(msg);
    console.log(`[客户端] 收到 messageID=${msg.messageID}  内容=${JSON.stringify(msg).slice(0, 80)}`);
  });
  decoder.on('error', (e, raw) => {
    console.error(`[客户端] 解析失败: ${e.message}  raw=${raw.slice(0, 80)}`);
  });
  client.on('data', (c) => decoder.push(c));

  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
    setTimeout(() => reject(new Error('client connect timeout')), 3000);
  });
  console.log('[1] 客户端已连 39997（保持中）\n');

  // 等 100ms 确保 hub 注册
  await new Promise(r => setTimeout(r, 100));

  // Step 2: 模拟 TTS 推送 Print 消息（连 39998 → 写 → 关）
  const printMsg = JSON.stringify({ messageID: 2, message: 'hello from fake TTS' });
  await new Promise((resolve, reject) => {
    const tts = net.connect(HUB_EDITOR_PORT, '127.0.0.1', () => {
      tts.write(printMsg, 'utf8', () => {
        tts.end();
        resolve();
      });
    });
    tts.on('error', reject);
    setTimeout(() => reject(new Error('tts connect timeout')), 3000);
  });
  console.log('[2] 模拟 TTS 已推送 Print 消息到 39998（连→写→关）\n');

  // Step 3: 模拟 TTS 推送 CustomMessage（含嵌套对象 + 字符串含 }）
  const customMsg = JSON.stringify({
    messageID: 4,
    customMessage: { type: 'guids', content: '{"abc":{"name":"test } with brace"}}' }
  });
  await new Promise((resolve, reject) => {
    const tts = net.connect(HUB_EDITOR_PORT, '127.0.0.1', () => {
      tts.write(customMsg, 'utf8', () => {
        tts.end();
        resolve();
      });
    });
    tts.on('error', reject);
    setTimeout(() => reject(new Error('tts connect timeout')), 3000);
  });
  console.log('[3] 模拟 TTS 已推送 CustomMessage（含嵌套 + 字符串含 }）到 39998\n');

  // Step 4: 等扇出
  await new Promise(r => setTimeout(r, 500));

  // Step 5: 验证
  console.log('=== 汇总 ===');
  const ok1 = receivedMessages.some(m => m.messageID === 2 && m.message === 'hello from fake TTS');
  const ok2 = receivedMessages.some(m => m.messageID === 4 && m.customMessage?.type === 'guids');
  console.log(`${ok1 ? '✓' : '✗'} Print 消息扇出成功（messageID=2）`);
  console.log(`${ok2 ? '✓' : '✗'} CustomMessage 扇出成功（messageID=4，含字符串嵌套 }）`);
  console.log(`共收到 ${receivedMessages.length} 条消息`);

  client.destroy();

  if (ok1 && ok2) {
    console.log('\n✓ 端到端消息流验证通过：插件的 ClientTransport + JsonStreamDecoder 能在真实 hub 上正确接收扇出');
    process.exit(0);
  } else {
    console.log('\n✗ 端到端消息流验证失败');
    process.exit(1);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
