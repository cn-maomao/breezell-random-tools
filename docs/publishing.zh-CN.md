# 随机工具：GitHub 发布与 Breezell 市场上架

本指南面向 `cn-maomao.random-tools` 的维护者，按[官方发布规范](https://github.com/BreezellCode/BreezellCode/blob/main/plugins/docs/publishing.md)整理。源码仓库是 [cn-maomao/breezell-random-tools](https://github.com/cn-maomao/breezell-random-tools)，当前版本为 **0.4.0**，作者／发布者为 `cn-maomao`，许可证为 MIT。

**GitHub Release 不等于市场上架。** GitHub 保存源码与安装包；Breezell 市场采用独立仓库中的包、清单和索引，必须经 PR 检查、维护者审核并合并。本指南给出待执行步骤，不声称市场 Fork、PR、审核或真实宿主验收已经完成。

## 1. 发布前检查

在插件项目根目录执行：

```sh
npm install
npm run typecheck
npm run validate
npm test
npm run build
```

这些是建议执行的检查命令，不是本指南的通过记录。开发环境需要 Node.js 18.19 或更新版本；安装插件的用户无需单独安装 Node.js。

确认发布信息：

| 项目 | 本版本内容 |
|---|---|
| 插件 ID | `cn-maomao.random-tools` |
| 版本 | `0.4.0` |
| 作者／发布者 | `cn-maomao` |
| 开源标记 | `breezell.source: "open"` |
| 源码仓库 | `https://github.com/cn-maomao/breezell-random-tools`，真实 HTTPS 地址 |
| 许可证 | MIT，随包附带 `LICENSE` |
| 唯一 Breezell 权限 | `agent.tools`，用于本地注册可选的 AI 工具，受用户审批 |
| 安装包 | `cn-maomao.random-tools-0.4.0.vsix` |

不得加入插件不使用的权限，尤其不需要聊天读写或编辑器读取权限。不要将 AI 工具调用误写成所有输入／输出都不离开电脑：参数以及除生成密码／密钥值以外的结果会进入模型会话。普通面板的生成和转换不发起网络请求，不持久化输入或结果。

### 插件详情来自哪些文件

- `package.json` 与本地化清单提供名称、描述、版本、作者、源码、权限和入口等信息。
- `media/icon.png` 提供市场图标。
- 根目录 `README.md` 是英文详情，市场要求提供英文基础说明。
- `i18n/README.zh-CN.md` 是简体中文详情；Devkit 提交时复制该翻译，其他缺失语言回退英语。
- `CHANGELOG.md` 记录版本更新，README 链接到公开源码中的日志。

更新这些文件，然后重新打包，才能让包内信息与市场元数据保持一致。这里的「插件详情」指 Breezell 市场卡片及 README 详情，不是另建一个冒充官方市场的外部网站。

### 真实宿主验收

在 Breezell 打开项目，F5 启动开发窗口，登录后逐项检查；再用实际 VSIX 安装验证：

- 「工具分类」／「工具」双下拉框、中英文、深浅主题、键盘操作和窄窗口。
- 九项工具的正常输入、非法输入、输出上限以及清空、切换、隐藏和关闭行为。
- 「复制 AI 提示词」仅由用户主动复制；自由文本、令牌、前后缀、自由字符集、自由端口排除及结果不进入模板。粘贴由用户主动完成，不自动发送会话。
- `chat`、`agent`、`entanglement` 中的工具可见性、权限批准与拒绝；拒绝工具权限或注册不可用不妨碍普通面板，宿主登录及插件策略仍适用。
- `rt_password`／`rt_key` 生成值仅显示于默认隐藏的插件面板，模型仅得到元数据和面板提示；用户名模式也不返回生成值。
- 其他工具使用非敏感示例，确认输入及结果进入模型会话；JWT 明确 `signatureVerified=false`，端口不声称未占用。
- 主动复制结果与真实系统剪贴板、退出登录、禁用、WSL/SSH 远程窗口。剪贴板历史、同步服务及其他程序可能保留值，不宣称自动清空。
- 宿主封禁策略不能绕过，本地 VSIX 也不能让被封禁的插件安装或运行。

F5、真实剪贴板和远程窗口验收不能由静态清单检查代替；记录实际结果后再决定是否发布。

## 2. 打包与本地安装

在插件项目根目录执行：

```sh
npm run package:open
```

官方 Devkit 会构建并生成 `cn-maomao.random-tools-0.4.0.vsix`，随包提供源码及源码映射，并标记开源。开源市场提交需要真实 HTTPS `repository`，不要用占位地址。

在 Breezell 插件管理中安装此本地 VSIX。若先前安装过 `local-tools.random-tools`，先卸载旧插件：发布者变更形成不同的插件 ID，新包不是旧 ID 的原位升级，同时保留可能造成重复命令或状态栏入口。

确认安装包中的版本、权限、README、图标和实际行为与本次发布一致。不要在打包后继续修改源码或清单却提交旧包；有修改就重新检查并打包。

## 3. 发布 GitHub Release

1. 将准备发布的源码及文档提交到 [公开源码仓库](https://github.com/cn-maomao/breezell-random-tools)。只提交本次发布的文件，勿提交密钥、真实令牌或临时产物。
2. 在 GitHub 的「Releases」中创建对应发布，标签为 `v0.4.0`，指向本次发布源码的提交；从 `CHANGELOG.md` 的 0.4.0 条目整理发布说明。
3. 上传刚验收的 `cn-maomao.random-tools-0.4.0.vsix`，确认附件名、版本和下载内容一致，再发布。
4. 用户随后可在 [v0.4.0 发布页](https://github.com/cn-maomao/breezell-random-tools/releases/tag/v0.4.0)下载并本地安装。发布页／附件在实际创建和上传完成前可能不可用。

GitHub Release 上传不会修改 Breezell 市场，不会自动发 PR，也不等于官方批准。市场审核尚未完成时，发布说明应明确这一点。

## 4. Fork 市场仓库并创建功能分支

先在 GitHub 对 [BreezellCode/BreezellCode](https://github.com/BreezellCode/BreezellCode)执行 Fork。如果使用 `cn-maomao` 账户且采用默认仓库名，Fork URL 将是 `https://github.com/cn-maomao/BreezellCode`。**本指南不假定这个 Fork 已创建。**

Fork 创建后，在准备存放市场克隆仓库的位置运行：

```sh
git clone https://github.com/cn-maomao/BreezellCode.git BreezellCode-market
cd BreezellCode-market
git remote add upstream https://github.com/BreezellCode/BreezellCode.git
git fetch upstream
git checkout -b plugin/cn-maomao.random-tools-0.4.0 upstream/main
```

如果使用已有克隆，先确认 `origin` 是自己的 Fork、`upstream` 是官方仓库，以及工作区没有未处理的其他更改。已有 `upstream` 时不要重复添加。基于最新上游 `main` 创建新功能分支，不重置或覆盖已有工作。

源码仓库 `breezell-random-tools` 与市场仓库 `BreezellCode-market` 是两个不同仓库。后续市场提交操作只在市场克隆仓库进行。

## 5. 用官方 Devkit 准备市场文件

回到随机工具插件项目根目录，在 PowerShell 中按实际克隆路径执行，例如：

```powershell
cd 'D:/code/Breezell Plugins/random-tools'
npm run submit -- --market 'D:/code/Breezell Plugins/BreezellCode-market'
```

示例假设上一节把克隆存放在 `D:/code/Breezell Plugins/BreezellCode-market`；如果位置不同，替换为真实路径。`--market` 必须指向 **BreezellCode 克隆仓库的根目录**，不是 `plugins` 子目录。Devkit 会自行定位其 `plugins/index.json`。

Devkit 自动完成：

- 将包复制到 `plugins/packages/cn-maomao.random-tools/0.4.0/cn-maomao.random-tools-0.4.0.vsix`。
- 更新 `plugins/packages/cn-maomao.random-tools/plugin.json` 中的版本、包 SHA-256、大小、权限、开源标记和详情地址。
- 复制英文 README、简体中文 README 与图标到该插件的市场目录。
- 重新生成 `plugins/index.json`。

不要手写 SHA-256、大小或索引来绕过检查。如果报告缺少包、清单错误或同一版本内容已存在且不同，应解决对应原因；已发布版本不可替换，应提升版本再提交。`submit` 准备本地市场文件，不执行 Git 提交、推送、PR 或维护者审核。

## 6. 审阅、提交并创建市场 PR

在市场克隆仓库运行：

```sh
git status --short
git diff -- plugins/packages/cn-maomao.random-tools plugins/index.json
```

确认差异只涉及预期插件目录与重建索引，检查包版本、权限 `agent.tools`、开源仓库、英文／中文详情和图标。若混入其他插件或不相关改动，先分离，不要一并提交。

审阅完成后，仍在市场克隆仓库执行：

```sh
git add -- plugins/packages/cn-maomao.random-tools plugins/index.json
git commit -m "Plugin: cn-maomao.random-tools 0.4.0"
git push -u origin plugin/cn-maomao.random-tools-0.4.0
```

向 `BreezellCode/BreezellCode` 的 `main` 分支创建 PR。说明九项工具、`agent.tools` 的用途、密码／密钥仅交付面板的边界、其余 AI 工具输入输出进入模型会话的风险，以及实际完成的验收；不要将未执行项目勾选为通过。

市场 CI 会核对包 SHA-256、大小、ID、版本、权限、开源标记及索引一致性。按检查结果与维护者意见修正并更新 PR。**维护者审核合并后，插件才会在 Breezell 市场出现。** 在此之前不得宣称已经上架。

## 7. 后续更新与封禁

后续版本先提升 `package.json` 的版本，更新中英文说明与 `CHANGELOG.md`，重新检查、验收、打包并提交市场 PR。已发布版本的包内容不可变；不要重用 `0.4.0` 替换已发布内容，也不要绕过 Devkit 的不可变检查。

宿主封禁会阻止运行和市场／本地安装。遇到封禁应查看宿主提供的原因，修复问题并按维护者流程提交新版本或申诉，不改 ID、删除清单或关闭策略以逃避限制。

相关链接：[英文说明](https://github.com/cn-maomao/breezell-random-tools#readme)、[中文说明](https://github.com/cn-maomao/breezell-random-tools/blob/main/i18n/README.zh-CN.md)、[问题反馈](https://github.com/cn-maomao/breezell-random-tools/issues)、[官方发布规范](https://github.com/BreezellCode/BreezellCode/blob/main/plugins/docs/publishing.md)。
