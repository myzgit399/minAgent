# CodeBuddy 模型接入（custom:codebuddy）

把腾讯 CodeBuddy（CodeBuddy CN IDE）账号下的模型接进 minAgent，作为普通的自定义
Provider 使用。已配置在 `%LOCALAPPDATA%\minAgent\config.yaml`：

```yaml
providers:
  codebuddy:
    api: https://copilot.tencent.com/v2
    key_cmd: <python.exe> C:/Users/<you>/grok/minAgent/scripts/codebuddy_token.py
    transport: chat_completions
    default_model: hy4flash-free
    context_length: 200000
    models: [auto, hy4std, hy4flash, hy4flash-free, step-5-preview, space-bunny,
             deepseek-v4.1-flash, deepseek-v4-pro, glm-5.4, glm-5.3, glm-5.3-flash,
             glm-5.2, kimi-k3.1-pro, kimi-k3-1, kimi-k2.8-preview,
             minimax-m3.1-flash, mimo-v2.6-pro]
auxiliary:
  stream_only_base_urls: ["copilot.tencent.com"]
```

模型 ID 形如 `custom:codebuddy:hy4flash-free`。

## 为什么用 `key_cmd` 而不是 `api_key`

CodeBuddy 没有可复制的静态 API Key：IDE 登录后拿到的是 OAuth session
（`accessToken` + `refreshToken`，约 28 天），存在 IDE 的 VS Code secret storage 里
（`%APPDATA%\CodeBuddy CN\User\globalStorage\state.vscdb`，值为 Electron
`safeStorage` 的 `v10` 密文，密钥在 `%APPDATA%\CodeBuddy CN\Local State` 里由
DPAPI 包裹）。

`scripts/codebuddy_token.py` 每次被 `key_cmd` 调用时现场解密并打印
`{"access_token": ..., "expires_in": ...}`：

- IDE 自己负责刷新 token，Hermes 只是读取，所以不会把 IDE 挤下线（本脚本**不**调用
  refresh 接口 —— refresh 会轮换 refreshToken 并让 IDE 掉线）。
- `CommandTokenSource` 会缓存到 `expires_in` 前 60s，没有 TTL 时按 15 分钟重取。
- IDE 退出登录 / token 过期时脚本以非零码退出并打印一行原因。

需要 `cryptography`，所以 `key_cmd` 指到装了它的 Python（本机是
`%LOCALAPPDATA%\Programs\Python\Python311\python.exe`）；minAgent 自带的
Python 3.14 没有该包。

## 两个已知约束

1. **只支持流式**：网关对非流式请求返回 400 `Non-stream chat request is currently
   not supported`。Hermes 主循环本身走流式，`auxiliary.stream_only_base_urls`
   让辅助调用（标题、压缩等）也强制流式。
2. **本地网络策略**：`hermes_bootstrap.install_local_network_policy()` 只放行
   loopback + `config.yaml` 里出现过的域名。`copilot.tencent.com` 已写进
   `providers.codebuddy.api`，但**改动对已启动的 gateway 进程不生效**，必须重启
   gateway（`hermes gateway restart -y --detach`，或桌面端设置里的重启）才会
   放行，否则模型调用报 `Connection error`。

## 额度

免费档只有 `hy4flash-free` 可用；其余模型在当前账号上返回 429
`额度已用尽`（CodeBuddy 控制台 <https://www.codebuddy.cn/profile/usage>）。
