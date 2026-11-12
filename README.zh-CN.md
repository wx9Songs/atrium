# Atrium 中庭

把你所有机器上的编程助手会话，放进同一个页面。

[English](README.md)

Claude Code 和 Codex 的会话都存在运行它们的那台机器上。有了一台笔记本、第二台笔记本、再加几台服务器，对话就散落各处，每个客户端只看得到自己的。Atrium 把它们收到一处，用起来就像普通的聊天应用：

- 所有机器的会话在一个列表里，按日期或按项目分组
- 点开就是完整历史，工具调用折叠成一行行步骤
- 在底部输入就能接着干活：消息在会话所在的那台机器上执行，输出实时返回，权限请求变成按钮
- 全文搜索所有对话
- 在任意一台已接入的机器上新开会话

自己部署、单人使用：你的服务器，你的机器，你的对话记录。

> **状态：早期。** 它支撑着作者自己的日常环境（两台 Mac、两个 Linux 容器、一台小 VPS）。安装脚本是从这套实际运行的部署整理出来的，但还没有在全新的服务器上完整跑过。界面目前只有中文。

## 工作方式

- **历史**来自各台机器推送上来的原始会话记录文件。[agentsview](https://github.com/kenn-io/agentsview) 负责解析和索引，Atrium 读取它的接口。
- **操控**靠每台机器上的一个小程序。你每发一条消息，它就在会话原来的目录里启动 `claude -p --resume <id>` 或 `codex exec resume <id>`，所以这一轮对话会接在同一份原生记录后面。之后在终端或桌面客户端里打开这个会话，内容都在。
- **不对公网开放任何端口。** 服务只监听服务器本机。各台机器通过 SSH 隧道连接，用的密钥只能做两件事：往自己的目录里写文件，以及打开这条隧道。

## 需要什么

- 一台能用 root 登录的 Linux 服务器（带 systemd，1 GB 内存够用）。
- 每台机器上：已安装并登录的 `claude` 和/或 `codex`、`ssh`、rsync 3.x（macOS 自带的版本不兼容，需要 `brew install rsync`）。
- 编译需要 Go 1.22+ 和 Node 18+。

## 安装

完整步骤见 **[docs/install.md](docs/install.md)**。概括起来：

```bash
make server-linux runners          # 编译
# 在服务器上（root）
./scripts/server-install.sh --atrium ./atrium
# 在每台机器上
./scripts/machine-install.sh key                      # 输出一把公钥
# 在服务器上
atrium-machine add laptop 'ssh-ed25519 AAAA…'         # 输出这台机器的令牌
# 回到那台机器
./scripts/machine-install.sh install --server my.server --name laptop --token …
# 登录（一次性链接，登录状态保持 180 天）
ssh root@my.server runuser -u atrium -- atrium login-link --base http://127.0.0.1:13005
```

## 桌面应用（macOS）

`make app` 会生成 `app/dist/Atrium.app`：一个包着页面的原生小窗口，运行结束或需要你确认时发通知，Dock 图标上显示待确认数量，并且可以一键登录。见 [app/README.md](app/README.md)。

## 需要知道的

- **一个会话同一时间只能有一处在写。** 如果它正在终端或桌面客户端里运行，先停掉那边再从 Atrium 发，否则两边的内容会交错写进同一份记录。检测到会话刚在别处更新时，页面会提醒。
- **其他客户端不会实时刷新。** 从 Atrium 发的消息立刻就在记录里，但已经打开的桌面客户端要重启后才显示。
- **别处新开的会话大约一分钟后出现**（推送间隔）。
- **权限**默认沿用那台机器自己的设置。想逐个确认，在输入框里选"需要时问我"。
- **对话记录以明文存在你的服务器上。** 里面可能有你粘贴过或助手打印过的密钥，请相应地保护好服务器。

## 许可

MIT
