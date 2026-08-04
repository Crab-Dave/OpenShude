# 静态页面内容维护

公开静态页面以本目录中的文件为唯一内容来源。修改内容后提交代码，由 CI 和 Docker 构建过程生成 HTML；后台和数据库不再保存或编辑首页正文。

## 更新已有页面

首页正文位于 `pages/home/content.md`。直接修改 Markdown 并提交即可。

页面图片必须放在对应页面的 `assets` 目录中，并使用相对路径引用：

```markdown
![图片说明](assets/example.png)
```

构建器不下载远程图片，并会在图片缺失或路径越出当前页面目录时终止构建。

## 新增页面

1. 新建 `pages/<slug>/content.md` 和可选的 `pages/<slug>/assets/`。
2. 在 `pages.toml` 中添加一个页面条目。
3. 运行构建命令并通过浏览器检查页面。

```toml
[[pages]]
slug = "guide"
route = "/guide"
title = "使用指南"
description = "合住使用指南"
source = "pages/guide/content.md"
show_in_navigation = true
order = 20
```

`slug` 只能包含小写字母、数字和连字符。路由不能与 `/api`、`/assets`、`/login`、`/roommates`、`/static-pages` 或 `/vendor` 冲突。`show_in_navigation = false` 可以生成不显示在顶栏中的公开页面。

## 本地构建

```powershell
.venv\Scripts\python.exe scripts/build_static_pages.py
```

生成结果位于 `public/generated/`，页面图片复制到 `public/static-pages/`。这两个目录均被 Git 忽略，不应手动编辑或提交。
