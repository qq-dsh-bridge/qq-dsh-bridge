# qq-dsh-bridge

QQ（OneBot v11 / SnowLuma）与 DeepSeek 之间的桥接：群消息变成 DSH agent 的提示词，agent 的回复发回 QQ。

## 依赖

| 依赖 | 要求 | 用途 | 必需 |
|---|---|---|---|
| **Node.js** | `>= 22.13.0`（见 `engines`） | 运行桥接。**零 npm 运行时依赖**，不需要 `npm install` | ✅ |
| **SnowLuma**（OneBot v11 实现） | 需开启 HTTP 动作端（默认 `:3000`）与正向 WebSocket（默认 `:3001`） | QQ 侧的收发 | ✅ |
| **DeepSeekWeb（DSH）** 桌面端 | 装了 **qq-dsh** 插件（另一个仓库 `ChengChe-yi/qq-dsh`），宿主端默认监听 `:3130` | agent 侧：建会话、投递提示词、收事件流 | ✅ |
| **Agent preset `qq`** | DSH 里必须有同名 preset | 建会话时用它。**安全关键**：preset 缺失会回落到默认 preset（含 bash / 文件读写 / 子 agent），而 QQ 会话是暴露给群友的 | ✅ |
| **sharp** | 可选 | 把过大的图片压到 DSH 能接受的 base64 线以下。桥接会自己找 DSH 自带的那份；找不到只是"大图退回原样"，不会报错。可用 `QQ_SHARP_URL` 指定 | ⬜ |
| **mcp-latex / mcp-md / mcp-websearch** | 可选，不在本仓库 | 图片转短链、联网搜索等工具能力 | ⬜ |

端口占用：桥接 API `3110`、控制台 `3111`；SnowLuma `3000` / `3001`；DSH 宿主 `3130`。

## 安装

1. **装 Node 22+**

   ```powershell
   node -v   # 需要 >= v22.13.0
   ```

2. **克隆并进入目录**

   ```powershell
   git clone https://github.com/qq-dsh-bridge/qq-dsh-bridge.git
   cd qq-dsh-bridge
   ```

   不需要 `npm install`（无依赖）。`state/`、`logs/` 会在首次启动时自动创建。

3. **生成宿主令牌**

   ```powershell
   node scripts/make-host-token.mjs          # 写入 state/host-token
   ```

   若仓库没有 `scripts/`，自己生成一个写进去即可：`state/host-token` 里放 32 字节 hex（一行）。
   **这个值必须与 DSH 侧 qq-dsh 插件配置里的 token 完全一致**，否则每次调用都是 401。

4. **配置**：复制模板再改

   ```powershell
   copy config.example.json config.json
   ```

   | 字段 | 说明 |
   |---|---|
   | `snowluma.homeDir` | SnowLuma 安装目录。填了就会从 `<homeDir>/config/onebot_<QQ号>.json` 自动发现端点和**两个** token，比手填省事 |
   | `snowluma.wsUrl` / `httpUrl` / `wsToken` / `accessToken` | 不填 `homeDir` 时手填这四个。注意 `accessToken`（HTTP）与 `wsToken`（WS）是**两个不同的值** |
   | `snowluma.selfQq` | 本号 QQ，**用字符串写**（`"123456789"`） |
   | `owner.qq` | 管理者 QQ，同样用字符串 |
   | `allow.groups` / `allow.private` | 白名单。空列表且 `allowAllWhenEmpty=false` ⇒ 谁都不放行（fail-closed） |
   | `dsh.hostUrl` | DSH 宿主地址，默认 `http://127.0.0.1:3130` |
   | `dsh.hostTokenFile` | 上一步那个令牌文件，默认 `state/host-token` |
   | `dsh.agentPreset` | **必须是 `qq`**。填错会静默回落到默认 preset |
   | `console.password` | 控制台密码；留空 = 不鉴权（启动会打 WARN）。建议设，或用环境变量 `QQBRIDGE_CONSOLEPASSWORD` |
   | `chatlog.root` / `media.root` | 聊天记录与图片缓存目录（建议放在仓库外） |
   | `decide.apiKeyFile` | 判定层用的凭据文件；不配则判定层不启用 |

5. **（可选）会话级覆盖**：不同群用不同人格/宽严时

   ```powershell
   copy config.sessions.example.json config.sessions.json
   ```

6. **自检**

   ```powershell
   npm run check
   ```

   通过会打印 `--check：配置校验通过` 并退出。

7. **启动**

   ```powershell
   copy start.example.bat start.bat    # 改了端口的记得同步改里面的 DSH_PROBE / SNOWLUMA_PORT
   start.bat
   ```

   或者直接：

   ```powershell
   npm start
   ```

8. **打开控制台**：<http://127.0.0.1:3111/>（桥接 API 在 `http://127.0.0.1:3110/api`）

## 环境变量覆盖（可选）

任何配置项都能用 `QQBRIDGE_` + 扁平大写名覆盖，**环境变量优先于 `config.json`**：

```powershell
setx QQBRIDGE_CONSOLEPASSWORD "换成你的密码"
setx QQBRIDGE_SNOWLUMAHOMEDIR "C:\path\to\SnowLuma"
```

其余常用：`QQBRIDGE_OWNERQQ`、`QQBRIDGE_ALLOWGROUPS`（逗号分隔）、`QQBRIDGE_SNOWLUMAWSURL`。
被环境变量覆盖的键会写进启动日志 —— 改了 `config.json` 却不生效时先看那一行。
