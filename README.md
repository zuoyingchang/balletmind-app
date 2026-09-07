# BalletMind · 全栈MVP

真实前端 + 真实后端(Express) + 真实数据库(SQLite) + AI结构化(Anthropic API，Key只存在服务器端，不会暴露给浏览器)。

## 项目结构

```
balletmind-app/
├── server/              ← 后端
│   ├── server.js        ← Express服务器 + SQLite数据库 + AI代理接口
│   ├── package.json
│   └── .env.example     ← 环境变量模板（存放API Key）
└── public/               ← 前端（芭蕾风格UI，参考墨刀设计稿）
    └── index.html
```

## 本地运行步骤

1. **安装 Node.js**（如果电脑还没装）：去 https://nodejs.org 下载安装 LTS 版本

2. **安装后端依赖**：
   ```bash
   cd server
   npm install
   ```

3. **配置 API Key**：
   - 去 https://console.anthropic.com 注册账号，创建一个 API Key
   - 复制 `.env.example` 为 `.env`：`cp .env.example .env`
   - 打开 `.env`，把 `your_api_key_here` 换成你自己的 Key

4. **启动服务器**：
   ```bash
   npm start
   ```
   看到 `BalletMind server running at http://localhost:3001` 就是成功了

5. **打开浏览器**访问 `http://localhost:3001`，就能看到完整的App（前端由后端一起提供，不用单独起前端服务）

## 这个项目"真"在哪里

- **真数据库**：`server/balletmind.db` 是一个真实的SQLite文件，你保存的每条记录都写在这个文件里，用SQLite客户端工具（如 DB Browser for SQLite）可以直接打开看
- **真后端接口**：`/api/generate`（AI结构化）、`/api/records`（增删查）都是真实的HTTP接口，用Postman或浏览器devtools的Network面板能看到真实的请求和返回
- **API Key安全**：Key只存在服务器的`.env`文件里，浏览器代码里完全看不到，符合基本的安全实践

## 部署上线（让别人也能访问）

本地能跑之后，如果想让3-6个测试用户通过一个链接访问，推荐用 **Render.com**（对Node+SQLite这种组合支持最直接，有免费额度）：

1. 把这个项目传到 GitHub（新建一个仓库，把 `balletmind-app` 文件夹传上去）
2. 去 https://render.com 注册账号，选择 "New Web Service"，连接你的GitHub仓库
3. Root Directory 填 `server`，Build Command 填 `npm install`，Start Command 填 `npm start`
4. 在 Render 的 Environment Variables 里添加 `ANTHROPIC_API_KEY`（跟本地 `.env` 里的值一样）
5. 部署完成后会得到一个类似 `https://balletmind.onrender.com` 的免费网址，发给测试用户就能用

**注意**：Render免费版的磁盘不是持久化的，服务重启或重新部署后 SQLite 数据库文件会被重置清空。对3-6人的短期MVP测试足够用；如果后面需要长期保留数据，可以把数据库换成 Render 的付费持久磁盘，或迁移到 Supabase（免费的云端Postgres数据库）。

## 成本

- 本地测试：完全免费
- Render 部署：免费版够用（有一定的休眠机制，长时间没访问会自动休眠，第一次访问要等几秒唤醒，MVP阶段可以接受）
- AI调用：Anthropic API 按用量计费，3-6人测试阶段的调用量产生的费用大概是几毛到几块钱人民币

## 想改UI风格？

前端就是 `public/index.html` 一个文件，颜色变量集中在Tailwind的class里（比如 `#6d3f3f` 是主色调深酒红、`#d8a36e` 是强调色暖金棕），直接搜索替换颜色值就能调整整体视觉。
