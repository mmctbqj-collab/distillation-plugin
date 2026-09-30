# 安装与升级

## 0. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| DeepSeek Harness | **0.2.x**（本版本针对 `0.2.0-rc.1` 实测） | 更低版本没有本插件依赖的 `ctx.webServer` / skill provider 契约 |
| Node.js | **≥ 22** | Desktop 版自带 runtime，无需另装 |
| git | 可选 | 只有 `evolve`（进化）与 `git`（仓库提取）需要 |
| uv | 可选 | 只有 `cangjie`（编译 Capability Bundle）需要，**没有它其余 10 个能力照常可用** |

先跑一次自检，它会逐项告诉你缺什么、以及确切的修复命令：

```bash
node engines/skill-distillation/scripts/cli.mjs doctor
```

或在 DSH 会话里让 Agent 调 `distill_doctor`。

---

## 1. 安装（三选一）

### 方式 A：GUI（最省事）

1. 打开 DSH 桌面版 → 侧边栏 **「插件」**
2. 点 **安装组合包**，填入下面任一 spec
3. 安装完成后侧边栏会出现 **「蒸馏」** 图标

### 方式 B：GitHub 直装（命令行）

```bash
dsh plugin --profile desktop add github:mmctbqj-collab/distillation-plugin
```

> 本插件是**纯 ESM、无构建步骤**，所以 git 安装不会触发 `prepare` 脚本，**不需要放行任何构建脚本**。
> 想锁定提交：`github:mmctbqj-collab/distillation-plugin#<sha>`。

### 方式 C：Release 附件（`.tgz`）

```bash
# 从 GitHub Release 下载后
dsh plugin --profile desktop add ./dsh-distillation-1.0.0.tgz
```

### 方式 D：本地目录（开发/调试）

```bash
dsh plugin --profile desktop add E:/DeepSeekHarness/distillation-plugin
```

GUI 里对应的是 **安装组合包 → 填绝对路径**。

> `dsh plugin add` 在 profile 目录里执行 pnpm。若你的 DSH 没有 `dsh` 可执行文件，用 GUI 的插件页
> 填同样的 spec 即可，效果一致。

---

## 2. 验证安装

```bash
# ① 组合包列表里应出现 dsh-distillation 1.0.0
dsh plugin --profile desktop list

# ② 内置引擎齐全（应列出 5 个）
node <插件目录>/engines/skill-distillation/scripts/cli.mjs engines list

# ③ 环境逐项体检
node <插件目录>/engines/skill-distillation/scripts/cli.mjs doctor
```

在会话里还可以验证：

- 让 Agent 调 `distill_doctor` → 应返回 ok/warn/fail 计数
- 让 Agent 调 `distill_engines` → 应列出 5 个内置引擎与上游 commit
- **刷新页面**后，侧边栏「蒸馏」页顶部应显示 `版本 1.0.0 · 内置引擎 5 · 技能根 5`

---

## 3. 可选依赖：uv（只有 cangjie 需要）

### Windows

```powershell
# 方式一：官方安装脚本（需要放宽 PowerShell 执行策略）
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# 方式二：下载官方二进制解压（不改执行策略，推荐）
#   从 https://github.com/astral-sh/uv/releases 下载 uv-x86_64-pc-windows-msvc.zip
#   解压到 %USERPROFILE%\.local\bin，并把这个目录加入用户 PATH
```

### macOS / Linux

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**装完请重启 DSH**（DSH 进程的 PATH 是启动时捕获的），否则 `doctor` 会如实报告：

```
[warn] uv（仓颉引擎需要）：uv 不在当前 PATH，但已在 C:\Users\you\.local\bin\uv.exe 找到（重启 DSH 后生效）
```

不想重启也可以临时指定路径（插件配置）：

```yaml
- id: distillation
  name: dsh-distillation
  config:
    cangjieUv: 'C:\Users\you\.local\bin\uv.exe'
```

---

## 4. 升级

```bash
# GitHub 直装（重新拉取最新提交）
dsh plugin --profile desktop remove dsh-distillation
dsh plugin --profile desktop add github:mmctbqj-collab/distillation-plugin

# 或换成新的 .tgz
dsh plugin --profile desktop add ./dsh-distillation-1.1.0.tgz
```

> **替换已加载的包需要重启 DSH**：宿主模块世代在进程内被缓存。客户端半边只需刷新页面。

## 5. 卸载

```bash
dsh plugin --profile desktop remove dsh-distillation
```

已生成在你技能根里的 Skill **不会被删除**（它们是独立产物）。要一并清理，删目录即可：

```bash
# 只列出本插件产出过的技能
node <插件目录>/engines/skill-distillation/scripts/cli.mjs list --generated
```

---

## 6. 常见安装问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `installation rejected: ... peerDependencies` | 该包声明了与当前 DSH 运行时冲突的对等依赖范围 | 换用声明兼容该运行时版本的版本；**不要**草率使用版本豁免（可能崩溃/丢数据） |
| 安装后侧边栏没有「蒸馏」 | 客户端 bundle 未刷新 | 刷新页面；仍无则看 设置 → 插件 的插件列表是否有报错 |
| 工具调不到（`distill_*` 不存在） | 宿主半边未加载 | 重启 DSH；确认组合包列表里 `dsh-distillation` 是 enabled |
| 页面显示「宿主半边尚未响应」 | 宿主路由未注册（通常是刚安装/升级后未重启） | 重启 DSH；期间页面会给出免重启的 CLI 命令 |
| `pnpm` 提示待放行的构建脚本 | 你的 pnpm 拦截了依赖构建 | 本插件**零依赖、无构建脚本**，正常不会出现；若出现说明装到的是别的包 |

安装过程中的日志在 `$DSH_HOME/profiles/<profile>/.plugin-manager/logs/`。
