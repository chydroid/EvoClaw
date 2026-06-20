# EvoClaw 自带技能（Bundled Skills）

本目录用于存放 EvoClaw 项目自带（bundled）的技能。这些技能会随仓库一起发布，并在服务器启动时被自动加载。

## 目录结构

每个技能一个子目录，目录内至少包含：

```
bundled/
  <skill-name>/
    SKILL.md          # 技能定义文件（必需）
    _meta.json        # 技能元数据（可选）
    scripts/          # 技能脚本（可选）
    ...
```

## 与运行时技能的关系

- `bundled/`：项目自带的只读技能，随版本发布，建议不要在此处修改。
- `data/skills/`：运行时用户安装/生成的技能，不会被 Git 跟踪。

服务器启动时会同时扫描这两个目录，因此自带技能和用户安装的技能可以共存。

## 如何添加自带技能

1. 在 `bundled/` 下新建技能目录。
2. 按照技能规范编写 `SKILL.md` 和必要的脚本。
3. 运行 `pnpm build && pnpm test` 验证。
4. 提交到 GitHub。
