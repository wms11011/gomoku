# AGENTS.md

本文件面向 AI 编码代理，描述本工作区的项目结构与开发约定。读者默认对本项目一无所知。

## 工作区布局

本目录是一个混合工作区，包含：

- `gomoku/` —— 唯一的代码项目（一个多游戏网站，详见下文）。所有开发工作都在此目录内进行。
- `AgentScope_Harness_学习笔记.md`、`AgentScope_Python_学习笔记.md` —— 个人学习笔记，与 gomoku 项目无关，不要当作项目文档引用。

## 项目概览（gomoku/）

一个零框架的 JavaScript 多游戏网站（中文界面），含四个游戏：

- **五子棋**：支持人机对战（自带 AI）、WebSocket 联机对战（房间制）、本地双人。
- **俄罗斯方块**、**贪吃蛇**：纯前端单机游戏（canvas 2D）。
- **迷你世界**：3D 体素沙盒（类 Minecraft 单机生存版），Three.js 渲染。种子化随机地形（山丘/湖泊/树木/煤矿）、挖放方块、重力碰撞、手机触屏操控、localStorage 存档；生存要素：昼夜循环、生命值/摔落伤害/死亡重生、夜晚刷僵尸（白天自燃）、猪（掉肉回血）、挖掘硬度与工具（镐/剑）、掉落物拾取、背包与点击式合成（木板/木棍/镐/剑/火把）、火把夜间点光源、和平模式开关。

技术栈：

- **前端**：原生 HTML/CSS/JavaScript，无任何框架与构建步骤，`public/` 下的文件直接静态托管。唯一的前端库是迷你世界用的 Three.js（`public/lib/three.min.js`，vendor 单文件，MIT 协议，不经过 npm）。
- **后端（双实现，协议与行为完全一致）**：
  - Node 版 `server/server.js`：本机 / Render 部署用，房间状态存内存，唯一 npm 依赖是 `ws`（WebSocket 库）。
  - Deno 版 `deno/main.js`：Deno Deploy 部署用，房间状态存 Deno KV（多实例下的一致性由 KV 原子比较并提交 + `kv.watch` 推送保证）。
- **运行环境**：Node >= 18；Deno 相关依赖为 jsr 的 `@std/http`、`@std/path`（见 `deno.lock`）。

关键架构事实：

- 联机对战采用**快照同步协议**（JSON 消息，`t` 字段为消息类型，客户端每条消息带 `cid` 标识自己；`cid` 存于 localStorage，断线重连凭它恢复座位）。协议细节见 `server/server.js` 顶部注释。
- **房间领域逻辑全部在 `server/room-ops.js`**（纯逻辑、不做 IO），被 Node 与 Deno 两个后端共用 —— 改规则只改这一个文件，两个后端行为自动一致。
- **五子棋核心规则在 `public/js/game.js`**（UMD 风格导出，前端通过 `window.GomokuCore`、Node 通过 `require` 使用同一文件）。`public/js/ai.js`（棋型打分 + alpha-beta 剪枝）也是同样的前后端共用模式。
- **访问门禁**：`server/auth.js` 实现手机号白名单 + HMAC-SHA256 签名 Cookie，未通过验证的 HTTP 请求一律返回门禁页 `server/gate.html`，WebSocket 握手同样拦截。未配置环境变量 `GOMOKU_PHONES` 时门禁关闭（方便本地开发）。

## 目录结构（gomoku/）

```
server/     后端：server.js（Node 版）、room-ops.js（共用房间逻辑）、auth.js（门禁）、gate.html（门禁页）
deno/       main.js（Deno Deploy 版服务器）
public/     前端：index.html（游戏大厅）、gomoku/tetris/snake/minecraft.html、css/style.css、
            js/game.js（五子棋规则）、ai.js、net.js（WS 客户端封装）、main.js、back.js、
            js/tetris/（core.js 纯逻辑 + main.js 界面）、js/snake/（同上结构）、
            js/minecraft/（core.js 纯逻辑：地形生成/区块网格化/拾取/存档 + main.js 渲染与操控
            + audio.js WebAudio 程序化音效与生成式背景音乐）、
            lib/three.min.js（Three.js r128 UMD vendor 文件，仅迷你世界使用）
test/       测试（见下节）
tools/      本地工具（deno.exe、cloudflared.exe），已在 .gitignore 中忽略
render.yaml Render 一键部署配置（Blueprint）
启动游戏.bat / 停止游戏.bat + start-game.ps1 / stop-game.ps1
            Windows 一键启动脚本：启动 Node 服务器 + Cloudflare 公网隧道（cloudflared），
            解析 tunnel.log 得到公网地址并复制到剪贴板
```

## 构建与运行

无构建步骤。常用命令（均在 `gomoku/` 目录下执行）：

```bash
npm install          # 安装唯一依赖 ws
npm start            # 启动 Node 服务器，默认端口 3000（PORT 环境变量可改）
npm test             # 跑全部离线测试
```

Deno 版本地运行（需 `tools/deno.exe` 或自行安装 Deno）：

```bash
tools/deno.exe run --unstable-kv --allow-net --allow-read --allow-env deno/main.js
```

Windows 用户也可直接双击 `启动游戏.bat`（起服务器 + 公网隧道）、`停止游戏.bat` 停止。

## 测试

无测试框架，全部用 Node 内置 `assert` 编写，脚本跑完打印 `✔` 并以退出码标识成败。`npm test` 依次执行：

- `test/core.test.js` —— 五子棋规则与 AI 单元测试
- `test/net.test.js` —— 联机对战集成测试：启动真实服务器子进程，用两个 WebSocket 客户端跑完整对局（建房/加入/落子/胜负/重开协商/断线重连）。默认测 Node 后端；`SERVER_KIND=deno node test/net.test.js` 测 Deno 后端（会拉起 `tools/deno.exe`，KV 用 `:memory:`）
- `test/auth.test.js` —— 门禁（白名单、签名 Cookie、拦截）测试
- `test/tetris-core.test.js`、`test/snake-core.test.js` —— 两个 2D 单机游戏的核心逻辑测试
- `test/minecraft-core.test.js` —— 迷你世界核心逻辑测试（地形确定性、面剔除网格化、DDA 拾取、挖掘/工具/掉落规则、背包与合成、昼夜状态、刷怪选址、存档往返）
- `test/minecraft-ui-smoke.test.js` —— 迷你世界界面层冒烟测试：用最小 DOM/THREE 桩件在 Node 里真实执行 `main.js`，验证启动流程与主循环（昼夜推进/刷怪/怪物 AI/掉落拾取/背包开合）不抛错。注意：桩件从 `public/minecraft.html` 解析合法元素 id，main.js 引用不存在的 id 会直接报错

另有一个**不在 `npm test` 中**的 `test/live.test.js`：连接线上 Deno Deploy 部署做冒烟验证，需先设置环境变量 `GOMOKU_TEST_PHONE`（白名单手机号之一），手动执行 `node test/live.test.js`。

修改联机规则（`room-ops.js`）后应至少跑 `node test/net.test.js`；有条件时两种后端各跑一遍。

## 代码风格约定

- 语言：注释、日志、提交信息、UI 文案一律用**简体中文**；标识符用英文。
- 服务端为 CommonJS（`'use strict'` + `require`/`module.exports`），2 空格缩进，单引号。
- 前端文件用 IIFE 包裹，通过 `window.GomokuCore` / `window.GomokuAI` / `window.GomokuNet` 挂全局，同时保持 `module.exports` 兼容以便 Node 测试直接 `require`。
- **单一事实来源原则**：规则逻辑放共享文件（`game.js`、`room-ops.js`、各游戏 `core.js`），界面与传输层只做渲染和消息收发；新增规则不要复制粘贴到多处。
- 游戏结构惯例：每个游戏分 `core.js`（纯逻辑，可被 Node 测试引用）与 `main.js`（画布渲染与交互）。
- 优先最小改动，保持与周边代码一致的风格；不要为了"改进"顺手重构无关代码。

## 安全注意事项

- **手机号白名单与密钥只走环境变量**（`GOMOKU_PHONES`、`GOMOKU_SECRET`），严禁写入代码或提交进仓库；测试用的手机号走 `GOMOKU_TEST_PHONE`。
- 未设置 `GOMOKU_SECRET` 时门禁用随机密钥，重启后所有访客需重新验证（属预期行为，部署时应配置固定值）。
- 门禁 Cookie 为 HttpOnly + SameSite=Lax，HTTPS 下加 Secure；登录失败固定延迟 800ms 以提高穷举成本；校验用 `crypto.timingSafeEqual` 防时序攻击 —— 修改 `auth.js` 时不要破坏这些性质。
- 静态文件服务需防路径穿越（现有 `path.normalize` + 前缀检查），WebSocket 握手必须过门禁。
- `tools/` 下的可执行文件与 `tunnel.log` 已在 `.gitignore` 中，不要提交。

## 部署

- **Render**：`render.yaml`（Blueprint，`npm install` + `node server/server.js`）。
- **Deno Deploy**：入口 `deno/main.js`，需绑定 Deno KV；KV 不可用时优雅降级（静态页与人机对战仍可用，仅联机对战提示不可用）。线上冒烟用 `test/live.test.js`。
- **本机分享**：`启动游戏.bat` 通过 Cloudflare 临时隧道暴露公网地址。
