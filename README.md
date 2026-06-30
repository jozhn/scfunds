# SC Funds

渣打中国可购基金筛选、持仓穿透、区间收益和组合回测看板。

## 本地运行

```bash
npm ci
npm run update-data
npm run dev
```

开发服务器默认读取 `public/data/funds.json`。

## 常用命令

```bash
npm run update-data  # 重新抓取基金列表、历史收益、持仓、费率和汇率
npm run lint         # oxlint 检查
npm run build        # 构建静态站点
```

## GitHub Pages

仓库发布到：

```text
https://jozhn.github.io/scfunds/
```

`.github/workflows/pages.yml` 使用 GitHub Pages 官方 Actions 部署静态站点：

- 推送 `main`：使用仓库内已有的 `public/data/funds.json` 构建并部署。
- 手动运行 `Build and deploy GitHub Pages`：默认先执行 `npm run update-data`，再构建并部署。

第一次部署前，在 GitHub 仓库 Settings -> Pages 里把 Build and deployment 的 Source 设为 `GitHub Actions`。
