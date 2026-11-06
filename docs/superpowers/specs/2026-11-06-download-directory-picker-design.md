# 设计：下载选目录提示（Directory Picker）

日期：2026-11-06
状态：已确认（方案 A：前端 File System Access API）

## 背景与目标

当前三个下载入口全部交给浏览器默认下载行为，无法选择存储位置：

- 导演包 ZIP：`window.location.href = /api/projects/:id/director-pack`（`public/app.js` exportPack）
- 成片 MP4：`window.location.href = /api/projects/:id/film`（`public/app.js` onAction `download-film`）
- 项目 JSON：Blob + `a.download`（`public/app.js` `btn-export`）

目标：点下载时弹出面板，可选择存储目录；不选择则默认使用上一次的存储位置；目录句柄跨会话持久化。

已确认的需求决策：

1. 适用范围：全部三个下载入口。
2. 交互形式：弹自定义面板，显示上次目录，可「更换目录」或「保存到上次位置」；不操作（面板外点击 / Esc）等同保存到上次位置。
3. 浏览器兼容：仅 Chromium（`showDirectoryPicker`）启用选目录；其它浏览器回退浏览器默认下载，不弹面板。

## 非目标

- 不引入 Electron/Tauri 桌面壳；不改服务端下载接口（`routes.mjs` 的 `Content-Disposition` 保持原样，作为回退路径）。
- 不做「静默保存、完全不提示」模式。
- 不支持非 Chromium 浏览器的目录选择降级 UI（直接回退普通下载）。

## 架构与组件

新增模块 `public/download-picker.js`（与 `link-picker.js` 同风格：原生 DOM、无依赖、独立 CSS 块）。对外单一入口：

```js
deliverDownload({ url?, blob?, filename })  // url 与 blob 二选一；blob 场景必须带 filename
```

模块内部三部分：

1. **能力检测**：`'showDirectoryPicker' in window`。不支持 → 直接执行回退下载（URL 用 `location.href` 或临时 `<a>`；Blob 用 `URL.createObjectURL` + `a.download`），不弹面板。
2. **目录句柄持久化**：IndexedDB，库名 `cc-download`、store `meta`、key `lastDir`，存 `FileSystemDirectoryHandle`（可结构化克隆）。浏览器仅暴露目录名，面板显示「上次位置：&lt;目录名&gt;」，无法显示完整路径。
3. **选位面板**：`.dl-picker` 弹层，交互风格复用 `link-picker`（fixed 定位、点击外部关闭、Esc 关闭）。

`app.js` 三个入口统一改调 `deliverDownload`：

| 入口 | 参数 |
|---|---|
| 导演包 | `{ url: '/api/projects/:id/director-pack' }`，filename 取自响应头 |
| 成片 | `{ url: '/api/projects/:id/film' }`，filename 取自响应头 |
| 项目 JSON | `{ blob, filename: '<项目名>.json' }` |

## 交互与数据流

点下载（Chromium）→ 弹面板：有上次目录时正文显示「上次位置：&lt;目录名&gt;」，无上次目录（首次）时正文显示「尚未选择过保存目录」且主按钮为「选择目录…」。操作项：

- **「保存到上次位置」（有上次目录时的主按钮）**：`handle.requestPermission({ mode: 'readwrite' })`（面板点击/面板外点击均构成用户手势，满足授权的 transient activation 要求）→ 授权通过 → 写入 → toast `已保存到 <目录名>/<文件名>`。
- **「更换目录…」（首次时为主按钮「选择目录…」）**：调 `showDirectoryPicker({ mode: 'readwrite' })` 打开系统原生选择器 → 新句柄写入 IndexedDB → 立即写入文件 → toast 同上。用户在系统选择器中取消 → 面板保持，不取消下载。
- **「使用浏览器默认下载」（文字次按钮，始终可用）**：放弃目录写入，走回退下载。
- **不操作**（点击面板外部 / 按 Esc）→ 等同点击「保存到上次位置」。首次（无上次目录）→ 取消本次下载（面板内已有「使用浏览器默认下载」作为明确的逃逸路径）。

写入数据流：

- URL 下载（MP4/ZIP）：`fetch(url)` → `response.body.pipeTo(writable)`，流式写盘，不整包进内存。
- Blob 下载（JSON）：`getFileHandle(name, { create: true })` → `createWritable()` → `write(blob)` → `close()`。
- 文件名：URL 场景从响应头 `Content-Disposition` 解析（无该头时回退默认下载）；Blob 场景用传入 filename。

## 边界与错误处理

- **同名文件**：写入前 `getFileHandle(name)` 探测，已存在则改名 `name (1).ext`、`name (2).ext`…（与目录内既有文件依次递增，避开冲突）。
- **权限被拒**：toast 报错并回退浏览器默认下载，不丢下载。
- **写入失败 / 句柄失效**（目录被移动、删除）：捕获异常 → toast 提示重新选择目录 → 回退默认下载；句柄失效时清除 IndexedDB 中的 `lastDir`，下次弹面板时视为首次。
- **fetch 非 2xx 或缺 Content-Disposition**：回退默认下载（`location.href`）。
- **非 Chromium**：不弹面板，走回退下载，行为与现状一致。

## 验证方式

项目无测试框架，采用手工验证清单（Chrome + 一个非 Chromium 浏览器）：

1. 启动 `./start.sh`，Chrome 打开页面。
2. 三个入口各下载一次：首次弹面板（主按钮「选择目录…」）→ 选目录 → 文件落盘、toast 正确、IndexedDB 有句柄。
3. 第二次下载：面板显示上次目录名 → 「保存到上次位置」直接落盘。
4. 面板外点击 / Esc → 等同保存到上次位置；面板内「使用浏览器默认下载」→ 走浏览器默认下载。
5. 目标目录放同名文件 → 自动改名 `name (1).ext`。
6. 重启浏览器后再下载 → 面板出现且需一次授权（面板按钮点击内完成）→ 落盘成功。
7. 在系统选择器中点取消 → 面板仍在，可再选。
8. Safari 或 DevTools 中删除 IndexedDB 句柄 → 回退普通下载 / 按首次流程。
9. 非 Chromium（如 Firefox）→ 不弹面板，浏览器默认下载，与改动前一致。
