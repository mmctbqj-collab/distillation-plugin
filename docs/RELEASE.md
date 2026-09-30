# 发版与发布（GitHub Release）

本文是**发布者的操作手册**：怎么打包、怎么推、Release 正文写什么，以及一条**必须遵守的安全规则**。

---

## 0. ⚠️ 一条必须遵守的规则（真实事故换来的）

**绝对不要把发布用的 `.tgz` 放在包目录内部。**

`pnpm` 对依赖的处理方式不同：

| 安装方式 | profile 里的 spec | pnpm 是否"拥有"源路径 | 后果 |
|---|---|---|---|
| 目录（推荐开发时） | `link:E:/…/distillation-plugin` | ❌ 只建符号链接 | 安全，删依赖不动源目录 |
| 包目录内的 `.tgz` | `file:E:/…/distillation-plugin/dsh-distillation-1.0.0.tgz` | ✅ 接管该文件 | **移除该依赖会连带删掉整个包目录** |

实测事故：把 `.tgz` 放在包目录内、装进 profile 后再切回目录安装，**整个包目录被清空**
（`verify/` 与 `build/` 因此丢失，后来靠已安装副本 + 逐条比对重建）。

因此：

- 打包产物一律放**仓库之外**（本项目放 `E:\DeepSeekHarness\_release\`，且 `.gitignore` 已忽略 `*.tgz`）；
- 不要在同一 profile 里把依赖在 `file:<tgz>` 与目录之间来回切；要切就先 `remove_bundle` 再装；
- 每次动 profile 之前，先给包目录做一份副本。

---

## 1. 打包

```bash
cd <仓库>
npm pack            # 产出 dsh-distillation-1.0.0.tgz（遵循 package.json 的 files 白名单）
```

产出应包含（129 个文件 / 约 1.9 MB 解包）：

```
package/index.js  core.mjs  client.js  cordis.patch.yml  icon.svg  package.json
package/locale/{zh,en}.json
package/engines/**            # 5 个内置引擎（含 UPSTREAM.json 与 .dsh-engines.json）
package/docs/**               # 中文文档
package/README.md  LICENSE  THIRD_PARTY_LICENSES.md
```

**不应**包含：`verify/`、`build/`、`.gitignore`、`node_modules/`（`files` 白名单之外的一律排除）。

打包后务必自检：

```bash
node verify/bundle-test.mjs            # 306 条断言必须全绿
node build/vendor-engines.mjs --check  # 内置引擎与 vendoring 记录一致
node build/sync-core.mjs --check       # core.mjs 的副本字节一致
```

记录产物指纹，写进 Release 正文：

```bash
sha256sum dsh-distillation-1.0.0.tgz     # Windows: certutil -hashfile <file> SHA256
```

---

## 2. 推到 GitHub

首次（仓库尚未初始化时）：

```bash
cd <仓库>
git init
git config user.name  "mmctbqj-collab"                 # 只写进本仓库，不动全局
git config user.email "mmctbqj-collab@users.noreply.github.com"
git add -A
git commit -m "feat: dsh-distillation 1.0.0 — 蒸馏插件（内置 nuwa/cangjie/darwin 引擎）"
git branch -M main
git remote add origin https://github.com/mmctbqj-collab/distillation-plugin.git
git push -u origin main
```

之后每次发版：

```bash
git add -A && git commit -m "chore: release 1.0.0"
git tag -a v1.0.0 -m "dsh-distillation 1.0.0"
git push origin main --tags
```

创建 Release 并上传附件（本机已装 `gh`）：

```bash
gh release create v1.0.0 "E:/DeepSeekHarness/_release/dsh-distillation-1.0.0.tgz" \
  --title "dsh-distillation 1.0.0" \
  --notes-file docs/RELEASE_NOTES.md
```

没有装 `gh` 就在网页版 **Releases → Draft a new release** 里选 tag、贴正文、拖入 `.tgz`。

> `gh` 首次使用需要 `gh auth login`（浏览器/设备码流程，只有你能完成）。

---

## 3. 安装命令（写进 Release 正文给用户）

```bash
# 从 GitHub 直接安装（纯 ESM、无构建，不需要放行任何构建脚本）
dsh plugin --profile desktop add github:mmctbqj-collab/distillation-plugin

# 或下载 Release 里的 .tgz 后本地安装
dsh plugin --profile desktop add ./dsh-distillation-1.0.0.tgz
```

GUI：**侧边栏「插件」→ 安装组合包**，填同样的 spec。

---

## 4. 发布前检查清单

- [ ] `node verify/bundle-test.mjs` → **306 passed / 0 failed**
- [ ] `node build/vendor-engines.mjs --check` → 三个引擎 `ok`
- [ ] `node build/sync-core.mjs --check` → `drift=0`
- [ ] `package.json` 的 `version` 与本次 tag 一致
- [ ] `docs/CHANGELOG.md` 有对应版本条目
- [ ] README 里的工具数 / 子命令数与代码一致（套件里有防漂移断言）
- [ ] `LICENSE` 与 `THIRD_PARTY_LICENSES.md` 都在包里
- [ ] `.tgz` 不位于包目录内（见 §0）
- [ ] 从 `.tgz` 实装一次验证（**在另一个 profile 或装完立刻切回目录时格外小心**）
- [ ] 记下 `.tgz` 的 SHA-256 并写进 Release 正文

---

## 5. 版本号约定

- 破坏兼容（工具参数、输出契约、技能根优先级变化）→ 主版本
- 新增能力（新工具 / 新子命令 / 新引擎）→ 次版本
- 修缺陷、改文档 → 修订号
