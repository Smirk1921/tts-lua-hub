// 长连接验证：连 hub 39997 → 通过 /v1/status 看到 tcpClients=1 → 关连接 → 看到 tcpClients=0
// 用法：node scripts/verify-fanout-registration.mjs
import net from 'node:net';
import http from 'node:http';

const HUB_HOST = '127.0.0.1';
const HUB_PORT = 39997;
const STATUS_URL = 'http://127.0.0.1:39995/v1/status';

function fetchStatus() {
  return new Promise((resolve, reject) => {
    http.get(STATUS_URL, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('=== hub fanout 注册验证 ===\n');

  // Step 1: 基线（无连接）
  const before = await fetchStatus();
  console.log(`[基线] tcpClients=${before.hub.tcpClients}  wsClients=${before.hub.wsClients}`);

  // Step 2: 建立长连接
  const sock = net.connect(HUB_PORT, HUB_HOST);
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
  console.log('[动作] TCP 39997 已连接（保持中）');

  // Step 3: 等 200ms 让 hub 注册到集合
  await new Promise(r => setTimeout(r, 200));

  // Step 4: 查 status
  const during = await fetchStatus();
  const registered = during.hub.tcpClients >= 1;
  console.log(`[连接中] tcpClients=${during.hub.tcpClients}  ${registered ? '✓ 已注册' : '✗ 未注册'}`);

  // Step 5: 关连接
  sock.destroy();
  await new Promise(r => setTimeout(r, 200));

  // Step 6: 再查 status
  const after = await fetchStatus();
  const deregistered = after.hub.tcpClients === 0;
  console.log(`[关闭后] tcpClients=${after.hub.tcpClients}  ${deregistered ? '✓ 已摘除' : '✗ 未摘除'}`);

  console.log('\n=== 汇总 ===');
  if (registered && deregistered) {
    console.log('✓ hub 39997 fanout 注册/摘除机制正常');
    process.exit(0);
  } else {
    console.log('✗ hub 39997 fanout 注册/摘除机制异常');
    process.exit(1);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
