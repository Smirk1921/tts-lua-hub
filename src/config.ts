import * as vscode from 'vscode';

/**
 * hub 连接配置（T7）
 *
 * 读取 `ttslua.hub.*` 配置节（package.json contributes.configuration order=50），
 * 供 transport 层的 hub socket 客户端使用。
 *
 * - 编辑器作为 net.Socket 主动连接 hub 的 39997 TCP 扇出端口；
 *   hub 侧为裸 TCP 字节流（无分隔符），分帧由 JsonStreamDecoder 负责。
 * - `fallback` 决定 hub 不在线时的降级策略：
 *   - 'prompt'：提示用户先启动 hub（默认）；
 *   - 'bind'  ：临时绑 39998 监听 TTS（与 CLI 独立模式同策略）。
 */
export interface HubConfig {
  host: string;
  port: number;
  fallback: 'prompt' | 'bind';
  reconnectMaxMs: number;
}

/**
 * 读取 hub 连接配置。
 * 值缺失或类型不符时回落到 package.json 声明的默认值。
 */
export function getHubConfig(): HubConfig {
  const config = vscode.workspace.getConfiguration('ttslua.hub');

  const host = config.get<string>('host', '127.0.0.1');
  const port = config.get<number>('port', 39997);
  const reconnectMaxMs = config.get<number>('reconnectMaxMs', 30000);

  // fallback 手改 settings.json 时可能越出枚举，越界则回落到 'prompt'
  const fallbackValue = config.get<string>('fallback', 'prompt');
  const fallback: HubConfig['fallback'] = fallbackValue === 'bind' ? 'bind' : 'prompt';

  return {host, port, fallback, reconnectMaxMs};
}
