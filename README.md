# Your Feeling - 匿名分享广场

一个完全匿名的多人共享分享网站，无需注册登录，任何人都可以发布文字、图片和链接。

## 功能特点

- 🎭 **完全匿名**: 无需注册登录，直接分享
- 📝 **发布内容**: 支持文字、图片、链接分享
- 💬 **匿名评论**: 每条分享都可以匿名评论
- 🔞 **内容过滤**: 自动过滤敏感违规内容
- 📱 **响应式设计**: 支持移动端和桌面端

## 技术栈

- **前端**: HTML + Tailwind CSS + Font Awesome
- **后端**: Node.js + Express
- **数据库**: SQLite
- **文件上传**: Multer

## 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

访问 http://localhost:3000

### 生产模式

```bash
npm start
```

## 项目结构

```
your feeling/
├── server.js          # 主服务器文件
├── package.json       # 项目配置
├── schema.sql         # 数据库初始化脚本
├── .gitignore         # Git忽略文件
├── database.db        # SQLite数据库文件（运行后自动生成）
├── uploads/           # 图片上传目录
└── public/
    └── index.html     # 前端页面
```

## API 接口

### 获取所有帖子

```
GET /api/posts
```

### 创建帖子

```
POST /api/posts
Content-Type: multipart/form-data

参数:
- content (必填): 帖子内容
- image (可选): 图片文件
- link_url (可选): 链接地址
```

### 获取评论

```
GET /api/posts/:id/comments
```

### 创建评论

```
POST /api/posts/:id/comments
Content-Type: application/json

{
  "content": "评论内容"
}
```

### 删除帖子

```
DELETE /api/posts/:id
```

## 部署到 Render

1. 登录 [Render](https://render.com)
2. 创建新的 Web Service
3. 连接你的 GitHub 仓库
4. 配置：
   - Build Command: `npm install`
   - Start Command: `npm start`
5. 添加环境变量（可选）：
   - `PORT`: 3000

## 部署到 Vercel

1. 登录 [Vercel](https://vercel.com)
2. 导入你的 GitHub 仓库
3. 在配置中设置：
   - Build Command: `npm install`
   - Output Directory: `public`
4. 部署完成

## 自定义敏感词

在 `server.js` 中修改 `sensitiveWords` 数组来添加或删除敏感词：

```javascript
const sensitiveWords = ['敏感词1', '敏感词2', 'fuck', 'shit'];
```

## 许可证

MIT
