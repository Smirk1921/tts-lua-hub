# NOTICE

本目录（`vscode-ext/`）是 [`rolandostar/tabletopsimulator-lua-vscode`](https://github.com/rolandostar/tabletopsimulator-lua-vscode)
的本地复刻（fork），用于 TTS 图包制作维护工具（窗口 F / 阶段 6 / 6B 深度层）的
VSCode 插件改造。本文件说明第三方组件的许可与署名情况。

## 一、上游许可：四份 MIT 声明的复合体

`./LICENSE` 保留了上游全部四份 MIT 声明，按出现顺序：

| # | 著作权人 | 年份 | 上游仓库 | 贡献 |
|---|---------|------|---------|------|
| 1 | Rolando Romero | 2019 | [rolandostar/tabletopsimulator-lua-vscode](https://github.com/rolandostar/tabletopsimulator-lua-vscode) | 主插件 |
| 2 | onelivesleft | 2017 | [onelivesleft/Console](https://github.com/onelivesleft/Console) | Console++ 模块 |
| 3 | OliPro007 | 2018 | [OliPro007/vscode-tabletopsimulator-lua](https://github.com/OliPro007/vscode-tabletopsimulator-lua) | Lua 自动补全 |
| 4 | Berserk Games | 2015 | [Berserk-Games/atom-tabletopsimulator-lua](https://github.com/Berserk-Games/atom-tabletopsimulator-lua) | 基于 Atom 官方插件 |

复刻在 `./LICENSE` 第一份声明（Rolando Romero）的著作权行上方追加了本项目的
著作权行，**未修改、未删除、未重排**任何上游声明。

## 二、`@vscode/codicons`（CC-BY-4.0）

`package.json` 依赖中包含 `@vscode/codicons`，该包采用
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) 许可。

**署名**：Visual Studio Code 图标库 © Microsoft Corporation，依据 CC-BY-4.0 使用。
原仓库：https://github.com/microsoft/vscode-codicons

CC-BY-4.0 与 MIT 兼容（CC-BY 仅要求署名），不影响主代码的 MIT 许可。

## 三、`draivin.hscopes`（外部 VSCode 扩展依赖）

`package.json` 的 `extensionDependencies` 声明了对第三方 VSCode 扩展
[`draivin.hscopes`](https://marketplace.visualstudio.com/items?itemName=draivin.hscopes)
的依赖。该扩展是**独立分发的 VSCode 扩展**，不包含在本仓库内、不会被复制、不会
被再分发——只是声明运行时依赖。其许可见其自身市场页。

## 四、本窗口（窗口 F）的合规边界

- 本窗口**未修改** `src/` 下任何业务代码
- 本窗口**未修改** `package.json`、`package-lock.json`
- 本窗口**未运行** `npm install` / `npm run build` / `vsce package`
- 本窗口的全部修改仅限于：
  1. `./LICENSE` 头部追加本项目的著作权行
  2. 新建 `./NOTICE.md`（本文件）

后续窗口（F2 / G）若修改 `src/` 业务代码或 `package.json` 依赖，需在
`./NOTICE.md` 中补充相应的合规说明（特别是引入新第三方依赖时）。

## 五、参考

- 复刻合规详细说明：`../docs/vscode-ext-compliance.md`
- 协议适配层设计（下一步的改造方案）：`../docs/vscode-ext-protocol-adapter.md`
- 方案设计 §7.4（复刻的注意事项）：`../方案设计.md`
