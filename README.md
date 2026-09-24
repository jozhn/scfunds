# SC Funds

渣打中国可购基金筛选、持仓穿透、区间收益和组合回测看板。

线上访问：[https://john.js.org/scfunds/](https://john.js.org/scfunds/)

![SC Funds 首页截图](docs/homepage.png)

## 本地运行

```bash
npm ci
npm run update-data
npm run dev
```

开发服务器默认读取 `public/data/funds.json`。

数据拆成两个文件，页面加载顺序也据此设计：

- `public/data/funds.json`：基金列表、区间指标、持仓、费率和最近若干天净值，首屏只解析这个文件。
- `public/data/funds-history.json`：逐日历史净值（约 32MB），打开基金详情或组合回测时按需（空闲时预取）加载。

## 常用命令

```bash
npm run update-data  # 重新抓取基金列表、历史收益、持仓、费率和汇率
npm run lint         # oxlint 检查
npm run build        # 构建静态站点
```

## GitHub Pages

仓库发布到：

```text
https://john.js.org/scfunds/
```

`.github/workflows/pages.yml` 使用 GitHub Pages 官方 Actions 部署静态站点：

- 推送 `main`：使用仓库内已有的 `public/data/funds.json` 和 `public/data/funds-history.json` 构建并部署。
- 手动运行 `Build and deploy GitHub Pages`：默认先执行 `npm run update-data`，再构建并部署。

第一次部署前，在 GitHub 仓库 Settings -> Pages 里把 Build and deployment 的 Source 设为 `GitHub Actions`。
