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

## 成本

- 本地测试：完全免费
- Render 部署：免费版够用（有一定的休眠机制，长时间没访问会自动休眠，第一次访问要等几秒唤醒，MVP阶段可以接受）
- AI调用：Anthropic API 按用量计费，3-6人测试阶段的调用量产生的费用大概是几毛到几块钱人民币

## 想改UI风格？

前端就是 `public/index.html` 一个文件，颜色变量集中在Tailwind的class里（比如 `#6d3f3f` 是主色调深酒红、`#d8a36e` 是强调色暖金棕），直接搜索替换颜色值就能调整整体视觉。
