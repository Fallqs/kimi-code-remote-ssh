# SSH 远程会话

Kimi Code CLI 可以运行一个工作目录位于远程主机上的会话，通过 SSH 连接。所有组件——界面、Agent 引擎、会话存储和 LLM 调用——都在本地运行，只有工具执行（文件操作和进程派生）发生在远程机器上。本页介绍如何启用该特性、如何用 `ssh://` 规格连接、OpenSSH 配置如何生效、哪些在本地哪些在远程、断连处理、当前限制与故障排查。

> SSH 远程工作区是实验特性，默认关闭。请先启用 `ssh-workdir` 实验开关：在 TUI 的 [`/experiments`](../reference/slash-commands.md) 面板中打开，或设置环境变量 `KIMI_CODE_EXPERIMENTAL_SSH_WORKDIR=1`，或在 `config.toml` 的 `[experimental]` 下添加 `ssh-workdir = true`。开关关闭时，`ssh://` 规格会被拒绝并报出明确的错误。

## 连接远程主机

在 TUI 中通过 [`/new`](./sessions.md#在-tui-中切换会话) 传入 `ssh://` 规格（代替本地目录），即可启动 SSH 会话：

```sh
/new ssh://dev@gpu-box.example.com/work/project
```

规格格式为 `ssh://[user@]host[:port]/path`，其中 `path` 是远程主机上的绝对 POSIX 路径。`/new` 的参数补全会提示本地目录和最近使用的目录（包括之前的 `ssh://` 规格），但不会补全远程路径——新的规格仍需手动输入。SSH 会话与本地会话一样保存和恢复：连接信息存放在会话元数据中，不存储任何密钥。

在网页版中，Add Workspace 对话框同样接受 `ssh://` 规格：在路径输入框中键入规格（对话框会显示实验特性提示）并确认即可。规格在添加时由服务端校验，连接失败等引擎错误会内联显示在对话框中。网页输入框的 `!` bash 模式在 SSH 工作区同样可用，命令在远程主机上执行。

## 连接的工作方式

首次连接时，CLI 会通过系统 OpenSSH 客户端探测远程主机，并把 Remote Tool Server（RTS）部署到远程，部署有两种形态。当本地备有对应远程平台的预构建 RTS 二进制——在仓库中通过 `pnpm --filter @moonshot-ai/remote-ssh build:sea` 构建，或随安装好的 CLI 放在 `~/.kimi-code/sea/<platform>/rts-bin`——时，它会被上传到 `~/.kimi-code/remote-agent/rts-bin` 并直接运行——远程主机无需安装任何东西。否则 CLI 会回退为把 RTS（一个单文件 Node.js 程序）部署到 `~/.kimi-code/remote-agent/rts.js`，以 `ssh <host> node rts.js` 运行，这要求远程主机装有 Node.js。两种形态下，其 stdio（进程的输入输出通道）都成为一条多路复用的 RPC（远程过程调用）管道，承载该工作区的所有文件操作与进程派生。

当已部署包的版本不匹配时，CLI 会自动重新部署，升级无需手动清理。由于传输层就是系统 `ssh`，跳板机、agent 转发、连接复用等连接能力都来自你自己的 OpenSSH 配置，而不是 Kimi Code 特有的配置。

## SSH 配置与认证

规格的 host 部分可以是字面主机名，也可以是 OpenSSH 客户端配置（`~/.ssh/config`）中的 `Host` 别名——该文件中的所有配置都会生效，包括 `HostName`、`IdentityFile`、`ProxyJump` / `ProxyCommand`、ssh-agent 和 `ControlMaster` 连接复用。规格中显式给出的 `user@` 或 `:port` 会覆盖配置中的对应值。主机密钥校验使用常规的 `known_hosts` 文件（OpenSSH 记录可信主机密钥的位置），因此新主机的首次连接必须像下文所述在 CLI 之外完成。

CLI 始终以 `BatchMode=yes` 运行 ssh，禁止任何交互式提示：在 Kimi Code 内无法输入密码，也无法接受未知主机密钥。请事先配置好免密认证（密钥文件或运行中的 ssh-agent），并先在终端中正常执行一次 `ssh <host>` 来预先信任主机密钥。连接失败时，ssh 自身的错误输出会原样包含在错误信息中，通常会指明具体原因。

## 远程主机要求

远程主机需要提供带 bash 的 POSIX 环境。备有预构建 RTS 二进制（见上文）时别无他求；没有时，则需在 `PATH` 上装有 Node.js 20 或更高版本——部署步骤会探测，不满足时报出明确的错误。ripgrep（`rg`）是可选的：没有它时，`Grep` 会回退到内置的 JavaScript 实现。

## 哪些在本地、哪些在远程

所有工具的文件与进程执行都在远程：`Read`、`Write`、`Edit`、`Glob`、`Grep` 操作远程文件系统，`Bash` 命令在远程主机上执行。会话持久化、对话记录和 Plan 模式状态都留在本地，因此会话仍从本机恢复。

有一个刻意的例外：计划文档和持久化 Shell 的快照存放在执行侧的 `~/.kimi-code/remote-sessions/<sessionId>/` 下，这样模型的 `Write` 工具和远程 `Bash` 才能看到它们。该目录会在会话关闭或删除时自动清理（尽力而为）。

## 远程主机上的持久化 Shell

在 `[bash]` 下启用 [`stateful`](../configuration/config-files.md#bash) 后，Shell 在远程主机上运行（每次命令仍是全新进程、执行前从快照恢复），其快照存放在上文所述的执行侧目录下。保留哪些状态与提交语义详见[持久化 Bash](./stateful-bash.md)。

## 连接中断与恢复

如果 SSH 连接断开，正在执行的远程进程会被杀死——RTS 随管道一同退出并终止其进程组——后续的工具调用会立即失败，并给出明确的中断错误。被中断的命令绝不会被静默重试。

CLI 会在后台重新连接，但环境会保持阻塞状态，直到你手动恢复：在 TUI 中运行 `/resume-remote`，或通过 REST API 调用 `POST /api/v1/workspaces/{id}/ssh/resume`（当前状态可从 `GET /api/v1/workspaces/{id}/ssh/state` 读取）。显式的确认步骤可以防止不稳定的网络在你不知情的情况下重启未完成的工作。

## 当前限制

以下集成尚未支持远程，计划在后续阶段提供。

- **文件监听**：不支持远程文件监听，因此 SSH 工作区上的工作区文件监听处于停用状态。
- **Git 集成**：git 状态和 diff 仍在本地运行，不反映远程仓库的情况。
- **单一根目录**：一个 SSH 工作区只包含规格中指定的目录；添加额外的本地目录（例如通过 `/add-dir`）不适用。
- **混合平台**：本机为 Windows、远程为 Linux 时，部分路径可能以混合格式显示。

## 故障排查

连接失败几乎总是源于远程环境或本地 OpenSSH 配置，错误信息中引用的 ssh 错误输出通常会指出原因。

- **`node: command not found` 或版本错误**：本地没有可用的预构建 RTS 二进制，部署回退到了 Node.js 形态——在远程主机的非交互式 `PATH` 上安装 Node.js 20 或更高版本，或按上文构建预构建二进制，即可不再依赖远程 Node.js。
- **主机密钥校验失败**：该主机密钥尚未被信任——在终端中执行一次 `ssh <host>` 并在那里接受密钥。
- **Permission denied**：`BatchMode=yes` 禁止密码提示，请配置密钥认证或运行中的 ssh-agent。
- **跳板机**：在 `~/.ssh/config` 中配置 `ProxyJump` 或 `ProxyCommand`；CLI 会通过系统 OpenSSH 客户端自动采用。
- **部署过期**：RTS 位于远程主机的 `~/.kimi-code/remote-agent/` 下（`rts-bin` 和/或 `rts.js`），版本不匹配时会自动重新部署；手动删除也是安全的，下次连接时会触发重新部署。

## 下一步

- [会话与上下文](./sessions.md) — 会话的保存、恢复与切换
- [持久化 Bash](./stateful-bash.md) — 跨调用保留 Shell 状态
