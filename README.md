# 局域网消息与文件

Electron + TypeScript 桌面应用，用于同一局域网内按 IP 直连发送消息和文件。应用不依赖中央服务器、云端账号或运行时互联网服务。当前默认监听所有网络接口的 TCP `45873` 端口。

## 开发和构建

```powershell
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm run package:win
npm run package:mac:arm64
```

`npm run package:mac:arm64` 在 macOS 上构建 Apple Silicon arm64 ZIP，输出到 `release-macos-arm64`。`npm run package:mac` 在 macOS 上生成 arm64 ZIP 和 DMG。electron-builder 本项目的 macOS 构建必须在 macOS 主机上执行，不能在 Windows 上构建；本项目提供手动 GitHub Actions 工作流 `.github/workflows/package-macos-arm64.yml`，在 Apple Silicon `macos-15` runner 上构建、检查 arm64 架构并启动测试打包应用。SQLite 使用 Electron 所带 Node.js 的 `node:sqlite`，应用不含需要额外编译的原生 Node 扩展。

### macOS 安装与首次打开

在 Apple Silicon Mac 上解压 `LAN Chat-*-arm64-mac.zip`，将 `LAN Chat.app` 拖入“应用程序”文件夹后打开。无 Apple Developer ID 签名/公证的构建首次打开可能被 Gatekeeper 拦截；请先通过可信渠道确认发布来源和校验和，再在 Finder 中对该应用按住 Control 点击，选“打开”，并在系统确认对话框中再次选“打开”。不要关闭 Gatekeeper 或降低全局安全设置。未签名构建不能保证在所有组织的 MDM/Gatekeeper 策略下打开；组织强制签名时需由管理员用 Developer ID 签名并公证后分发。

首次启动时，macOS 可能询问是否允许应用查找并连接本地网络设备；要进行局域网连接需允许此项权限。接收文件时由 macOS 保存对话框让用户选择路径。当前构建不签名/不公证；需在真实 Apple Silicon Mac 上完成启动、局域网权限、保存文件和 Gatekeeper 验收后再作为正式公司分发版本。

## 局域网使用

1. 在双方电脑启动应用，左上角显示精简的本机地址；点击地址可展开全部 IP 和身份指纹。
2. 点击通讯录右上角 `＋` 添加对方 IPv4 和备注名称，端口填对方的监听端口（默认 `45873`）。添加、编辑表单只在操作时弹出，不占用列表空间。
3. 由一方发起连接并核对 TLS SHA-256 指纹，点击“信任并发送连接申请”。另一方在应用中点击“查看并处理”，核对来源与指纹后点击“接受”；不要双方同时反复发起。
4. 连接建立后可双向聊天。将本地文件或图片直接拖进聊天区域发送，可一次拖入多个文件，不支持文件夹或网页图片链接。
5. 已连接设备的文件无需再次确认接收：普通文件直接弹出“保存位置”，可改名；取消只跳过该文件。已有同名文件不会覆盖，会自动编号。图片自动在聊天中显示，点击预览大图，右键“图片另存为…”保存原图；另存为不会覆盖已有文件。
6. 收发新消息会自动滚动到底部；点击“加载更早的记录”查看历史。消息和文件结果保存在 SQLite 中，重启后仍可查看。

图片展示支持 PNG、JPEG、GIF 和 WebP，并验证真实内容而非只信任扩展名。单张不超过 20 MiB、2400 万像素，单边不超过 12000 像素；显示的是最长边 1600 像素的规范化 PNG 预览，动图只展示静态帧，另存为保留原始文件。图片缓存上限为 512 MiB（含原图、预览及传输预留）；超出大小或缓存预算的图片按普通文件询问保存位置，损坏或不受支持的伪装图片会明确报错，不会执行或自动打开。缓存满时不会自动删除历史图片。

取消传输或连接断开后，未完成的文件不会留下正常文件名的半成品。正在等待保存位置的对话框可直接取消。双方请更新至相同版本，以支持混合批次中逐个取消保存。高级用法：启动时可加 `--lan-port=45874` 指定其他监听端口。

首次信任采用 TOFU。备注名和 IP 均不是身份凭据；在公司可信渠道（例如当面或电话）核对指纹，尤其是指纹发生变化时。拒绝未经核验的身份变更。

如果显示对方拒绝，请先确认对方是否在申请提示中点了“拒绝”。旧版本对重复申请和已有连接也可能显示为拒绝；如状态不一致，双方断开或重启应用，更新至相同版本，再由一方发起申请。收到明确拒绝响应表明请求已到达对端应用，不能据此断定网络或防火墙阻塞。

Windows 防火墙需允许应用在可信公司网络通信。macOS 可能会请求本地网络权限。VLAN、访客网络隔离或公司策略阻止的设备间通信无法由本应用绕过。两台电脑需处于允许互访的网络中。

应用数据保存在系统用户数据目录：SQLite 聊天记录和通讯录，以及用于 TLS 身份的私钥/证书。不要删除身份文件，否则会触发对端身份变更警告。聊天记录未做应用级静态加密。删除联系人不会删除历史记录或已接收文件。

Apple Silicon macOS arm64 ZIP 和 DMG 需要在 macOS 环境构建并验证。未签名构建可能出现 Gatekeeper 提示；不要通过关闭系统安全保护绕过提示。

## 测试

```powershell
npm test
$env:LARGE_TRANSFER_TEST="1"; npm test -- --testNamePattern="larger than 1 GiB"
```

第二个命令会在系统临时目录生成并传输约 1.07 GiB 文件，并断言传输期间 RSS 峰值增幅小于 256 MiB。跨机性能、公司网络防火墙和 macOS 实机行为仍需在目标环境验收。

Windows 打包后，可运行以下测试，以独立数据目录及空闲端口验证真实 Electron 的连接、自动滚动、拖放、图片预览和图片保存。测试通过仅对自己启动的测试进程注入对话框响应，不改变发布程序的正常交互；系统原生保存对话框的人工操作仍需实机验收：

```powershell
$env:PACKAGED_APP=(Resolve-Path 'release-ux\win-unpacked\LAN Chat.exe').Path
npx vitest run tests\packaged-connection.test.ts
```
