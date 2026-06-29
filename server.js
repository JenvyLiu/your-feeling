const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ============ .env 配置支持（手动解析，不引入 dotenv） ============
function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), ".env");
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) return;
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        // 去除引号
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.substring(1, value.length - 1);
        }
        // .env 文件优先级高于系统环境变量（方便用户通过修改文件快速切换配置）
        process.env[key] = value;
      });
      console.log("[ENV] 已加载 .env 配置文件");
    }
  } catch (err) {
    console.warn("[ENV] 加载 .env 文件失败:", err.message);
  }
}

loadEnvFile();

// ============ 基础配置 ============
const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

// 管理员密码：从环境变量读取，未设置则禁用管理员功能
// 存储为 SHA-256 hash，避免明文常驻内存，并使用 timing-safe 比较
let ADMIN_PASSWORD_HASH = null;

function hashPassword(pwd) {
  return crypto.createHash("sha256").update(String(pwd || "")).digest("hex");
}

function verifyAdminPassword(input) {
  if (!ADMIN_PASSWORD_HASH || !input) return false;
  const inputBuf = Buffer.from(hashPassword(input), "hex");
  const expectedBuf = Buffer.from(ADMIN_PASSWORD_HASH, "hex");
  if (inputBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(inputBuf, expectedBuf);
}

const rawAdminPwd = process.env.ADMIN_PASSWORD || null;
if (!rawAdminPwd) {
  console.log("[SECURITY] 未设置 ADMIN_PASSWORD 环境变量，管理员功能已禁用");
  console.log("[SECURITY] 请在 .env 文件或环境变量中设置 ADMIN_PASSWORD 以启用管理功能");
} else {
  ADMIN_PASSWORD_HASH = hashPassword(rawAdminPwd);
  // 清除环境变量中的明文，防止意外泄漏
  delete process.env.ADMIN_PASSWORD;
}

const TIMEOUT_MS = 15000;
const DB_RETRY_MS = 5000;
const MAX_DB_RETRIES = 3;

// 帖内匿名头像派生密钥：未配置则每次启动随机生成（已存库的 author_seed 不受影响，故仍稳定）
const AVATAR_SECRET = process.env.AVATAR_SECRET || crypto.randomBytes(16).toString("hex");

// ============ 通用安全/工具函数 ============

// LIKE 通配符转义（统一处理 \ % _）
function escapeLike(str) {
  return String(str || "").replace(/[\\%_]/g, "\\$&");
}

// 帖内匿名头像 seed：HMAC(secret, postId:fingerprint)，同帖同人稳定、跨帖不可追踪、不可反推 fingerprint
function deriveAuthorSeed(postId, fingerprint) {
  if (!fingerprint) return crypto.randomBytes(6).toString("hex");
  return crypto.createHmac("sha256", AVATAR_SECRET)
    .update(String(postId) + ":" + String(fingerprint))
    .digest("hex")
    .substring(0, 12);
}

// 匿名化 IP（保留前两段用于粗略区分，不记录完整 IP）
function anonymizeIp(ip) {
  if (!ip || ip === "unknown") return "unknown";
  const parts = String(ip).split(".");
  if (parts.length >= 4) return parts[0] + "." + parts[1] + ".*.*";
  // IPv6: 保留前两段
  const v6 = String(ip).split(":");
  if (v6.length >= 3) return v6[0] + ":" + v6[1] + "::*";
  return "anon";
}

// 审计日志（记录管理员关键操作）
function auditLog(action, req, detail) {
  const ip = anonymizeIp(req.ip || req.connection.remoteAddress || "unknown");
  const ua = (req.headers["user-agent"] || "").substring(0, 80);
  const extra = detail ? ` | ${detail}` : "";
  logger.info(`[AUDIT] ${action} | ip=${ip} | ua=${ua}${extra}`);
}

// 缓存失效：清理依赖写操作的缓存键
function invalidateWriteCaches() {
  try {
    simpleCache.delete("api_stats");
    simpleCache.delete("tags_popular");
  } catch (e) {
    // Map 未初始化时忽略
  }
}

// ============ 文件日志系统 ============
const LOG_DIR = path.resolve(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFilePath() {
  const now = new Date();
  const dateStr = now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0");
  return path.join(LOG_DIR, `server-${dateStr}.log`);
}

function writeLog(level, message) {
  const now = new Date();
  const timestamp = now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0") + " " +
    String(now.getHours()).padStart(2, "0") + ":" +
    String(now.getMinutes()).padStart(2, "0") + ":" +
    String(now.getSeconds()).padStart(2, "0");
  const logLine = `[${timestamp}] [${level}] ${message}\n`;
  const logFile = getLogFilePath();

  fs.appendFile(logFile, logLine, (err) => {
    if (err) {
      // 日志写入失败不影响主流程，仅在控制台警告
      console.warn("[LOG] 写入日志文件失败:", err.message);
    }
  });
}

// 日志级别快捷方法
const logger = {
  info: (msg) => { console.log(`[INFO] ${msg}`); writeLog("INFO", msg); },
  warn: (msg) => { console.warn(`[WARN] ${msg}`); writeLog("WARN", msg); },
  error: (msg) => { console.error(`[ERROR] ${msg}`); writeLog("ERROR", msg); }
};

// ============ Rate Limiting（基于内存的简单限流） ============
const rateLimitStore = new Map();
const RATE_LIMIT_MAX_KEYS = 50000; // 防止内存膨胀

/**
 * 限流中间件
 * @param {number} windowMs - 时间窗口（毫秒）
 * @param {number} maxRequests - 最大请求数
 */
function rateLimit(windowMs, maxRequests) {
  return function(req, res, next) {
    // 使用 IP 作为限流 key（不记录到日志）
    const ip = req.ip || req.connection.remoteAddress || "unknown";
    const key = `${ip}:${req.method}:${req.path}`;
    const now = Date.now();

    // 容量上限：超过时清理最旧的 1/4
    if (rateLimitStore.size > RATE_LIMIT_MAX_KEYS) {
      let removed = 0;
      const toRemove = Math.floor(RATE_LIMIT_MAX_KEYS / 4);
      for (const k of rateLimitStore.keys()) {
        if (removed >= toRemove) break;
        rateLimitStore.delete(k);
        removed++;
      }
    }

    if (!rateLimitStore.has(key)) {
      rateLimitStore.set(key, { count: 0, startTime: now });
    }

    const record = rateLimitStore.get(key);

    // 窗口过期则重置
    if (now - record.startTime > windowMs) {
      record.count = 0;
      record.startTime = now;
    }

    record.count++;

    if (record.count > maxRequests) {
      logger.warn(`限流触发: ${anonymizeIp(ip)} 在 ${windowMs / 1000}s 内请求超限 (限制 ${maxRequests})`);
      return res.status(429).json({ error: "请求过于频繁，请稍后再试" });
    }

    next();
  };
}

// 定期清理过期的限流记录（每 5 分钟清理一次）
const rateLimitTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (now - record.startTime > 120000) { // 清理超过 2 分钟的记录
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

// ============ 敏感词过滤 ============
const badWords = ["badword1", "badword2", "badword3"];

function filterBadWords(text) {
  if (!text) return "";
  let result = text;
  badWords.forEach(word => {
    try {
      const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "gi");
      result = result.replace(regex, "*".repeat(word.length));
    } catch (e) {}
  });
  return result;
}

function containsBadWords(text) {
  if (!text) return false;
  return badWords.some(word => {
    try {
      return new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "gi").test(text);
    } catch (e) {
      return false;
    }
  });
}

// ============ 匿名昵称生成器 ============
const nicknameAdjectives = [
  "温柔的", "沉默的", "快乐的", "忧伤的", "勇敢的",
  "安静的", "自由的", "孤独的", "善良的", "聪明的",
  "神秘的", "浪漫的", "天真的", "忧郁的", "活泼的",
  "优雅的", "淡然的", "坚定的", "朦胧的", "清澈的",
  "深邃的", "温暖的", "清凉的", "璀璨的", "轻盈的",
  "悠然的", "恬静的", "灵动的", "朴素的", "绚烂的",
  "飘逸的", "从容的", "执着的", "谦逊的", "豁达的",
  "深沉的", "纯真的", "率真的", "慵懒的", "倔强的",
  "细腻的", "奔放的", "内敛的", "恬淡的", "炽热的",
  "冷峻的", "柔和的", "刚毅的", "随性的", "睿智的"
];

const nicknameNouns = [
  "星星", "海洋", "月亮", "森林", "风",
  "云朵", "花朵", "猫咪", "飞鸟", "溪流",
  "山谷", "雪花", "阳光", "夜空", "微光",
  "晚风", "晨露", "彩虹", "流星", "萤火虫",
  "蝴蝶", "白鸽", "浪花", "落叶", "春风",
  "秋水", "冬雪", "夏花", "孤岛", "灯塔",
  "琴弦", "画笔", "诗篇", "梦境", "远方",
  "旅人", "守望者", "拾光者", "追风人", "听雨者",
  "望月人", "寻梦者", "归人", "过客", "行者",
  "歌者", "舞者", "画师", "诗人", "匠人"
];

function generateNickname() {
  const adj = nicknameAdjectives[Math.floor(Math.random() * nicknameAdjectives.length)];
  const noun = nicknameNouns[Math.floor(Math.random() * nicknameNouns.length)];
  return adj + noun;
}

// ============ 安全响应头中间件 ============
function securityHeaders(req, res, next) {
  // Content-Security-Policy：收紧来源，保留必要的 inline
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "img-src 'self' data: blob:; " +
    "style-src 'self' 'unsafe-inline'; " +
    "font-src 'self' data:; " +
    "script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "object-src 'none'; " +
    "worker-src 'self' blob:"
  );
  // X-Frame-Options: 防止被 iframe 嵌套
  res.setHeader("X-Frame-Options", "DENY");
  // X-Content-Type-Options: 防止 MIME 类型嗅探
  res.setHeader("X-Content-Type-Options", "nosniff");
  // X-XSS-Protection: 启用浏览器 XSS 过滤
  res.setHeader("X-XSS-Protection", "1; mode=block");
  // Referrer-Policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Permissions-Policy
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Strict-Transport-Security（渐进启用，先 1 小时）
  if (req.headers["x-forwarded-proto"] === "https" || req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=3600; includeSubDomains");
  }
  next();
}

// ============ 数据库管理 ============
let db = null;
let dbReady = false;
let dbRetries = 0;

function createDatabase() {
  const newDb = new sqlite3.Database("./database.sqlite", sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
      logger.error("数据库连接失败: " + err.message);
      handleDbError();
      return;
    }
    logger.info("数据库连接成功");
    dbRetries = 0;
    initDatabase(newDb);
  });

  newDb.configure("busyTimeout", 5000);
  return newDb;
}

function initDatabase(database) {
  database.serialize(() => {
    database.run("PRAGMA foreign_keys = ON", (err) => {
      if (err) logger.error("启用外键失败: " + err.message);
    });

    // posts 表（新增 mood, expires_at, is_hidden, tags）
    database.run(`
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        image_url TEXT,
        link_url TEXT,
        view_count INTEGER DEFAULT 0,
        like_count INTEGER DEFAULT 0,
        mood TEXT,
        expires_at TEXT,
        is_hidden INTEGER DEFAULT 0,
        tags TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `, (err) => {
      if (err) logger.error("创建posts表失败: " + err.message);
    });

    // 迁移：添加缺失的列（兼容旧数据库）
    database.all("PRAGMA table_info(posts)", (err, columns) => {
      if (err) return;
      const columnNames = columns.map(c => c.name);
      if (!columnNames.includes('mood')) {
        database.run("ALTER TABLE posts ADD COLUMN mood TEXT", (err) => {
          if (err) logger.error("添加 mood 列失败: " + err.message);
          else logger.info("已添加 mood 列");
        });
      }
      if (!columnNames.includes('expires_at')) {
        database.run("ALTER TABLE posts ADD COLUMN expires_at TEXT", (err) => {
          if (err) logger.error("添加 expires_at 列失败: " + err.message);
          else logger.info("已添加 expires_at 列");
        });
      }
      if (!columnNames.includes('is_hidden')) {
        database.run("ALTER TABLE posts ADD COLUMN is_hidden INTEGER DEFAULT 0", (err) => {
          if (err) logger.error("添加 is_hidden 列失败: " + err.message);
          else logger.info("已添加 is_hidden 列");
        });
      }
      if (!columnNames.includes('tags')) {
        database.run("ALTER TABLE posts ADD COLUMN tags TEXT", (err) => {
          if (err) logger.error("添加 tags 列失败: " + err.message);
          else logger.info("已添加 tags 列");
        });
      }
      if (!columnNames.includes('like_count')) {
        database.run("ALTER TABLE posts ADD COLUMN like_count INTEGER DEFAULT 0", (err) => {
          if (err) logger.error("添加 like_count 列失败: " + err.message);
          else logger.info("已添加 posts.like_count 列");
        });
      }
      if (!columnNames.includes('bookmark_count')) {
        database.run("ALTER TABLE posts ADD COLUMN bookmark_count INTEGER DEFAULT 0", (err) => {
          if (err) logger.error("添加 bookmark_count 列失败: " + err.message);
          else logger.info("已添加 posts.bookmark_count 列");
        });
      }
    });

    // comments 表（新增 parent_id, nickname, like_count）
    database.run(`
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        parent_id INTEGER,
        nickname TEXT,
        like_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
      )
    `, (err) => {
      if (err) logger.error("创建comments表失败: " + err.message);
    });

    // 迁移：添加 comments 缺失的列
    database.all("PRAGMA table_info(comments)", (err, columns) => {
      if (err) return;
      const columnNames = columns.map(c => c.name);
      if (!columnNames.includes('parent_id')) {
        database.run("ALTER TABLE comments ADD COLUMN parent_id INTEGER", (err) => {
          if (err) logger.error("添加 parent_id 列失败: " + err.message);
          else logger.info("已添加 comments.parent_id 列");
        });
      }
      if (!columnNames.includes('nickname')) {
        database.run("ALTER TABLE comments ADD COLUMN nickname TEXT", (err) => {
          if (err) logger.error("添加 nickname 列失败: " + err.message);
          else logger.info("已添加 comments.nickname 列");
        });
      }
      if (!columnNames.includes('like_count')) {
        database.run("ALTER TABLE comments ADD COLUMN like_count INTEGER DEFAULT 0", (err) => {
          if (err) logger.error("添加 like_count 列失败: " + err.message);
          else logger.info("已添加 comments.like_count 列");
        });
      }
      if (!columnNames.includes('author_seed')) {
        database.run("ALTER TABLE comments ADD COLUMN author_seed TEXT", (err) => {
          if (err) logger.error("添加 author_seed 列失败: " + err.message);
          else logger.info("已添加 comments.author_seed 列");
        });
      }
    });

    // post_likes 表
    database.run(`
      CREATE TABLE IF NOT EXISTS post_likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(post_id, fingerprint),
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      )
    `, (err) => {
      if (err) logger.error("创建post_likes表失败: " + err.message);
    });

    // comment_likes 表
    database.run(`
      CREATE TABLE IF NOT EXISTS comment_likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(comment_id, fingerprint),
        FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
      )
    `, (err) => {
      if (err) logger.error("创建comment_likes表失败: " + err.message);
    });

    // reports 表（内容举报）
    database.run(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        reason TEXT NOT NULL,
        fingerprint TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        status TEXT DEFAULT 'pending',
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      )
    `, (err) => {
      if (err) logger.error("创建reports表失败: " + err.message);
    });

    // bookmarks 表（收藏/书签）
    database.run(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(post_id, fingerprint),
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      )
    `, (err) => {
      if (err) logger.error("创建bookmarks表失败: " + err.message);
    });

    // 索引
    database.run("CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_posts_mood ON posts(mood)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_posts_expires ON posts(expires_at)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_posts_hidden ON posts(is_hidden)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_posts_tags ON posts(tags)", (err) => {});
    // 复合索引：提升帖子列表主查询（按时间排序 + 过滤隐藏/过期）
    database.run("CREATE INDEX IF NOT EXISTS idx_posts_active_created ON posts(is_hidden, created_at DESC)", (err) => {});
    // 复合索引：热门排序
    database.run("CREATE INDEX IF NOT EXISTS idx_posts_likes_created ON posts(like_count DESC, created_at DESC)", (err) => {});
    // 复合索引：评论查询 + 排序
    database.run("CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments(post_id, created_at ASC)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_comments_post_likes ON comments(post_id, like_count DESC)", (err) => {});
    // 复合索引：点赞/收藏快速存在性检查 + UNIQUE 已有覆盖，补充指纹查询
    database.run("CREATE INDEX IF NOT EXISTS idx_likes_fingerprint ON post_likes(fingerprint, post_id)", (err) => {});
    // 复合索引：举报按状态 + 时间排序（管理员面板）
    database.run("CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports(status, created_at DESC)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_reports_post ON reports(post_id)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_likes_post ON post_likes(post_id)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_comment_likes ON comment_likes(comment_id)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_bookmarks_post ON bookmarks(post_id)", (err) => {});
    database.run("CREATE INDEX IF NOT EXISTS idx_bookmarks_fingerprint ON bookmarks(fingerprint)", (err) => {});

    logger.info("数据库初始化完成");
    dbReady = true;

    // 启动时清理过期帖子
    cleanupExpiredPosts(database);
  });
}

function handleDbError() {
  if (dbRetries >= MAX_DB_RETRIES) {
    logger.error("数据库重试次数用尽，请检查数据库文件");
    return;
  }
  dbRetries++;
  logger.warn(`${DB_RETRY_MS / 1000}秒后重试数据库 (${dbRetries}/${MAX_DB_RETRIES})...`);
  setTimeout(() => {
    logger.info("尝试重新连接数据库...");
    db = createDatabase();
  }, DB_RETRY_MS);
}

// 清理过期帖子（同时删除相关图片，避免孤儿文件）
function cleanupExpiredPosts(database) {
  database.all(
    "SELECT id, image_url FROM posts WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
    [],
    function(err, rows) {
      if (err) {
        logger.error("查询过期帖子失败: " + err.message);
        return;
      }
      if (!rows || rows.length === 0) return;

      // 删除数据库记录（外键级联会清理评论/点赞/收藏/举报）
      const ids = rows.map(r => r.id).filter(Boolean);
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(",");
        database.run(
          `DELETE FROM posts WHERE id IN (${placeholders})`,
          ids,
          function(err2) {
            if (err2) {
              logger.error("清理过期帖子失败: " + err2.message);
            } else {
              logger.info(`已清理 ${this.changes || ids.length} 条过期帖子`);
              invalidateWriteCaches();
            }
          }
        );
      }

      // 异步删除关联图片
      rows.forEach(row => {
        if (row && row.image_url) {
          const fullPath = path.join(__dirname, "public", row.image_url);
          fs.unlink(fullPath, (fsErr) => {
            if (fsErr && fsErr.code !== "ENOENT") {
              logger.error("清理过期帖子图片失败: " + fsErr.message);
            }
          });
        }
      });
    }
  );
}

// 定期清理（每小时执行一次），保存 timer 引用以便优雅关闭
const expiryCleanupTimer = setInterval(() => {
  if (db && dbReady) {
    cleanupExpiredPosts(db);
  }
}, 60 * 60 * 1000);

// 初始化数据库
db = createDatabase();

db.on("close", () => {
  logger.warn("数据库连接已关闭");
  dbReady = false;
  handleDbError();
});

// ============ 文件上传安全加固 ============
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function isValidImageExtension(filename) {
  if (!filename) return false;
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

const uploadHandle = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = "public/uploads/";
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // 安全加固：验证文件扩展名白名单
      if (!isValidImageExtension(file.originalname)) {
        return cb(new Error("不支持的文件类型，仅允许 jpg/jpeg/png/gif/webp 格式"));
      }

      // 重命名为随机文件名（保留安全扩展名）
      const crypto = require("crypto");
      const randomName = crypto.randomBytes(16).toString("hex");
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, randomName + ext);
    }
  }),
  fileFilter: (req, file, cb) => {
    // 验证 MIME 类型白名单
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("不支持的文件类型，仅允许 jpg/jpeg/png/gif/webp 格式"), false);
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ============ 中间件 ============

// 响应压缩中间件（基于内置 zlib，gzip；不引入额外依赖）
// 对文本类响应（HTML/JSON/JS/CSS/XML/SVG 等）按 Accept-Encoding 做缓冲式 gzip 压缩。
// 本站响应体均为中小型，缓冲后一次性压缩安全且足够；图片/视频等已压缩内容自动跳过。
const zlib = require("zlib");
const COMPRESS_MIN_BYTES = 1024; // 小于 1KB 不值得压缩
const COMPRESSIBLE_RE = /^(?:text\/|application\/(?:json|javascript|xml|.*\+json|.*\+xml)|image\/svg\+xml)/i;

function compression(req, res, next) {
  const accept = req.headers["accept-encoding"] || "";
  if (req.method === "HEAD" || !/\bgzip\b/i.test(accept)) {
    return next();
  }

  const chunks = [];
  let length = 0;
  const _write = res.write;
  const _end = res.end;

  function toBuffer(chunk, encoding) {
    if (chunk == null) return null;
    return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || "utf8");
  }

  res.write = function (chunk, encoding, cb) {
    const buf = toBuffer(chunk, typeof encoding === "string" ? encoding : undefined);
    if (buf) { chunks.push(buf); length += buf.length; }
    if (typeof encoding === "function") cb = encoding;
    if (typeof cb === "function") cb();
    return true;
  };

  res.end = function (chunk, encoding, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = null; encoding = undefined; }
    else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
    const buf = toBuffer(chunk, typeof encoding === "string" ? encoding : undefined);
    if (buf) { chunks.push(buf); length += buf.length; }

    // 还原原始方法，避免影响后续/异常情况
    res.write = _write;
    res.end = _end;

    const body = chunks.length ? Buffer.concat(chunks, length) : Buffer.alloc(0);
    const contentType = String(res.getHeader("Content-Type") || "");
    const alreadyEncoded = !!res.getHeader("Content-Encoding");

    // 始终声明按编码协商缓存
    const prevVary = res.getHeader("Vary");
    if (!prevVary) res.setHeader("Vary", "Accept-Encoding");
    else if (!/accept-encoding/i.test(String(prevVary))) res.setHeader("Vary", prevVary + ", Accept-Encoding");

    const shouldCompress =
      !alreadyEncoded &&
      body.length >= COMPRESS_MIN_BYTES &&
      COMPRESSIBLE_RE.test(contentType);

    if (!shouldCompress) {
      // 原样输出
      if (body.length) _write.call(res, body);
      return _end.call(res, cb);
    }

    zlib.gzip(body, (err, compressed) => {
      if (err) {
        // 压缩失败则回退为未压缩
        if (body.length) _write.call(res, body);
        return _end.call(res, cb);
      }
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Length", compressed.length);
      _write.call(res, compressed);
      _end.call(res, cb);
    });
    return res;
  };

  next();
}
app.use(compression);

app.use(cors({
  origin: (origin, cb) => {
    // origin 为 undefined 表示同源请求（浏览器直连），总是允许
    if (!origin) return cb(null, true);

    // 环境变量中显式配置的允许来源
    const allowed = (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    // 开发模式下允许本地服务端口（精确匹配本站 URL）
    const localAllowed = [
      "http://localhost:" + (process.env.PORT || 3000),
      "http://127.0.0.1:" + (process.env.PORT || 3000)
    ];

    if (allowed.includes(origin) || localAllowed.includes(origin)) {
      return cb(null, true);
    }
    // 非白名单来源 — 拒绝携带凭证的跨域请求
    cb(null, false);
  },
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// 安全响应头
app.use(securityHeaders);

// 静态资源服务（带缓存控制）
app.use(express.static("public", {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    // HTML 文件不缓存
    if (ext === ".html" || ext === ".htm") {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    } else {
      // 静态资源缓存 7 天
      res.setHeader("Cache-Control", "public, max-age=604800");
    }
  }
}));

if (!fs.existsSync("public/uploads")) {
  fs.mkdirSync("public/uploads", { recursive: true });
}

// 请求超时中间件
app.use((req, res, next) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      logger.warn(`${req.method} ${req.path} 请求超时`);
      res.status(504).json({ error: "请求超时，请稍后重试" });
    }
  }, TIMEOUT_MS);
  res.on("finish", () => clearTimeout(timeout));
  res.on("close", () => clearTimeout(timeout));
  next();
});

// ============ 管理员验证 ============
function checkAdmin(req, res, next) {
  if (!ADMIN_PASSWORD_HASH) { return res.status(403).json({ error: "管理员功能未启用" }); }
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }
  const password = req.headers["x-admin-password"];
  if (verifyAdminPassword(password)) {
    next();
  } else {
    auditLog("ADMIN_AUTH_FAIL", req, "checkAdmin 中间件");
    res.status(403).json({ error: "未授权" });
  }
}

// ============ API 路由 ============

// 健康检查
app.get("/api/health", (req, res) => {
  res.json({
    status: dbReady ? "healthy" : "degraded"
  });
});

// 帖子总数统计 API
app.get("/api/stats", (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const cacheKey = 'api_stats';
  const cached = simpleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 60000) {
    return res.json(cached.data);
  }

  db.get(`
    SELECT
      COUNT(*) as total_posts,
      SUM(CASE WHEN is_hidden = 0 AND (expires_at IS NULL OR expires_at > datetime('now')) THEN 1 ELSE 0 END) as active_posts,
      SUM(CASE WHEN is_hidden = 1 THEN 1 ELSE 0 END) as hidden_posts,
      (SELECT COUNT(*) FROM comments) as total_comments,
      (SELECT COUNT(*) FROM reports WHERE status = 'pending') as pending_reports
    FROM posts
  `, (err, row) => {
    if (err) {
      logger.error("查询统计信息失败: " + err.message);
      return res.status(500).json({ error: "获取统计信息失败" });
    }
    const data = {
      total_posts: row.total_posts || 0,
      active_posts: row.active_posts || 0,
      hidden_posts: row.hidden_posts || 0,
      total_comments: row.total_comments || 0,
      pending_reports: row.pending_reports || 0
    };
    simpleCache.set(cacheKey, { data, timestamp: Date.now() });
    res.json(data);
  });
});

// 管理员登录（限制 1 分钟 5 次，防止暴力破解）
app.post("/api/admin/login", rateLimit(60000, 5), (req, res) => {
  if (!ADMIN_PASSWORD_HASH) {
    return res.status(403).json({ error: "管理员功能未启用" });
  }
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }
  // 支持从 header 或 body 获取密码
  const password = req.headers["x-admin-password"] || (req.body && req.body.password);
  if (verifyAdminPassword(password)) {
    auditLog("ADMIN_LOGIN_SUCCESS", req, "登录成功");
    res.json({ success: true });
  } else {
    auditLog("ADMIN_LOGIN_FAIL", req, "密码错误");
    res.status(403).json({ error: "密码错误" });
  }
});

// 管理员删除帖子（/api/admin/posts/:id
app.delete("/api/admin/posts/:id", checkAdmin, (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const postId = parseInt(req.params.id);
  if (!postId || postId <= 0) {
    return res.status(400).json({ error: "无效的帖子ID" });
  }

  // 先获取帖子的图片路径，以便后续删除图片
  db.get("SELECT image_url FROM posts WHERE id = ?", [postId], (err, post) => {
    if (err) {
      logger.error("查询帖子失败: " + err.message);
    }

    // 使用外键级联，删除帖子会自动清理相关的 comments / post_likes / bookmarks / reports
    db.run("DELETE FROM posts WHERE id = ?", [postId], function(deleteErr) {
      if (deleteErr) {
        logger.error("删除帖子失败: " + deleteErr.message);
        return res.status(500).json({ error: "删除失败" });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "帖子不存在" });
      }

      // 删除关联的图片（如果有）
      if (post && post.image_url) {
        const fullPath = path.join(__dirname, "public", post.image_url);
        fs.unlink(fullPath, (fsErr) => {
          if (fsErr && fsErr.code !== "ENOENT") {
            logger.error("删除帖子图片失败: " + fsErr.message);
          }
        });
      }

      auditLog("ADMIN_DELETE_POST", req, "post=" + postId);
      invalidateWriteCaches();
      res.json({ success: true });
    });
  });
});

// 管理员切换帖子隐藏状态（使用 checkAdmin 中间件统一鉴权）
app.put("/api/admin/posts/:id/toggle-hide", checkAdmin, (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const postId = parseInt(req.params.id);
  if (!postId || postId <= 0) {
    return res.status(400).json({ error: "无效的帖子ID" });
  }

  db.get("SELECT is_hidden FROM posts WHERE id = ?", [postId], (err, row) => {
    if (err) {
      logger.error("查询帖子失败: " + err.message);
      return res.status(500).json({ error: "操作失败" });
    }
    if (!row) {
      return res.status(404).json({ error: "帖子不存在" });
    }
    const newHidden = row.is_hidden ? 0 : 1;
    db.run("UPDATE posts SET is_hidden = ? WHERE id = ?", [newHidden, postId], (err) => {
      if (err) {
        logger.error("更新帖子隐藏状态失败: " + err.message);
        return res.status(500).json({ error: "操作失败" });
      }
      auditLog("ADMIN_TOGGLE_HIDE", req, `post=${postId} hidden=${newHidden}`);
      invalidateWriteCaches();
      res.json({ success: true, is_hidden: newHidden });
    });
  });
});

// ============ 匿名昵称生成 API ============
app.get("/api/nickname", (req, res) => {
  res.json({ nickname: generateNickname() });
});

// ============ 获取所有帖子（支持分页、排序、搜索、情绪过滤、标签过滤、收藏状态） ============
app.get("/api/posts", (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const search = req.query.search || "";
  const mood = req.query.mood || "";
  const tag = req.query.tag || "";
  const fingerprint = (req.query.fingerprint || "").substring(0, 100);

  // 分页参数
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  // 排序参数：latest（最新）/ hot（热门）/ comments（最多评论）
  let sort = req.query.sort || "latest";
  if (!["latest", "hot", "comments"].includes(sort)) {
    sort = "latest";
  }

  let whereSql = `WHERE p.is_hidden = 0
    AND (p.expires_at IS NULL OR p.expires_at > datetime('now'))`;
  const params = [];

  if (search.trim()) {
    whereSql += " AND p.content LIKE ? ESCAPE '\\'";
    params.push("%" + search.trim().replace(/[\\%_]/g, '\\$&') + "%");
  }

  if (mood) {
    whereSql += " AND p.mood = ?";
    params.push(mood);
  }

  if (tag.trim()) {
    whereSql += " AND (p.tags IS NOT NULL AND p.tags LIKE ? ESCAPE '\\')";
    params.push("%" + tag.trim().replace(/[\\%_]/g, '\\$&') + "%");
  }

  // 排序子句
  let orderBySql = "";
  if (sort === "hot") {
    orderBySql = "ORDER BY p.like_count DESC, p.created_at DESC";
  } else if (sort === "comments") {
    orderBySql = "ORDER BY comment_count DESC, p.created_at DESC";
  } else {
    orderBySql = "ORDER BY p.created_at DESC";
  }

  // 先查询总数
  const countSql = `SELECT COUNT(*) as total FROM posts p ${whereSql}`;

  db.get(countSql, params, (err, countRow) => {
    if (err) {
      logger.error("查询帖子总数失败: " + err.message);
      return res.status(500).json({ error: "获取帖子失败" });
    }

    const total = countRow ? countRow.total : 0;
    const totalPages = Math.ceil(total / limit);

    // 查询分页数据
    const dataSql = `SELECT p.*, COUNT(c.id) as comment_count
               FROM posts p
               LEFT JOIN comments c ON p.id = c.post_id
               ${whereSql}
               GROUP BY p.id
               ${orderBySql}
               LIMIT ? OFFSET ?`;

    db.all(dataSql, [...params, limit, offset], (err, rows) => {
      if (err) {
        logger.error("查询帖子失败: " + err.message);
        return res.status(500).json({ error: "获取帖子失败" });
      }

      // 如果提供了 fingerprint，批量查询收藏状态
      if (fingerprint && rows && rows.length > 0) {
        const postIds = rows.map(r => r.id);
        const placeholders = postIds.map(() => "?").join(",");
        const bookmarkSql = `SELECT post_id FROM bookmarks WHERE fingerprint = ? AND post_id IN (${placeholders})`;
        db.all(bookmarkSql, [fingerprint, ...postIds], (bErr, bookmarkRows) => {
          if (bErr) {
            logger.error("查询收藏状态失败: " + bErr.message);
            // 出错时仍然返回帖子，只是不包含收藏状态
            return res.json({
              data: rows || [],
              pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1
              }
            });
          }
          const bookmarkedIds = new Set((bookmarkRows || []).map(b => b.post_id));
          const enrichedRows = rows.map(r => ({
            ...r,
            is_bookmarked: bookmarkedIds.has(r.id)
          }));
          res.json({
            data: enrichedRows,
            pagination: {
              page,
              limit,
              total,
              totalPages,
              hasNext: page < totalPages,
              hasPrev: page > 1
            }
          });
        });
      } else {
        // 无 fingerprint，is_bookmarked 默认 false
        const enrichedRows = (rows || []).map(r => ({ ...r, is_bookmarked: false }));
        res.json({
          data: enrichedRows,
          pagination: {
            page,
            limit,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1
          }
        });
      }
    });
  });
});

// 随机推荐（每日一句）
// 注意：必须注册在 /api/posts/:id 之前，否则 "random" 会被 :id 路由当作 ID 解析而返回 400
app.get("/api/posts/random", (req, res) => {
  if (!dbReady) return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  db.get(`
    SELECT COUNT(*) as cnt FROM posts
    WHERE is_hidden = 0 AND (expires_at IS NULL OR expires_at > datetime('now'))
    AND like_count > 0
  `, (err, countRow) => {
    if (err) return res.status(500).json({ error: "获取推荐失败" });
    const cnt = countRow ? countRow.cnt : 0;
    if (cnt === 0) return res.json(null);
    const offset = Math.floor(Math.random() * cnt);
    db.get(`
      SELECT p.*, COUNT(c.id) as comment_count
      FROM posts p LEFT JOIN comments c ON p.id = c.post_id
      WHERE p.is_hidden = 0 AND (p.expires_at IS NULL OR p.expires_at > datetime('now'))
      AND p.like_count > 0
      GROUP BY p.id
      LIMIT 1 OFFSET ?
    `, [offset], (err2, row) => {
      if (err2) return res.status(500).json({ error: "获取推荐失败" });
      res.json(row || null);
    });
  });
});

// 获取单个帖子
app.get("/api/posts/:id", (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const postId = parseInt(req.params.id);
  if (isNaN(postId) || postId <= 0) {
    return res.status(400).json({ error: "无效的帖子ID" });
  }

  db.serialize(() => {
    db.run("UPDATE posts SET view_count = view_count + 1 WHERE id = ? AND is_hidden = 0", [postId], (err) => {
      if (err) logger.error("更新浏览量失败: " + err.message);
    });

    db.get(
      "SELECT * FROM posts WHERE id = ? AND is_hidden = 0 AND (expires_at IS NULL OR expires_at > datetime('now'))",
      [postId],
      (err, row) => {
        if (err) {
          logger.error("查询帖子失败: " + err.message);
          return res.status(500).json({ error: "获取帖子失败" });
        }
        if (!row) {
          return res.status(404).json({ error: "帖子不存在或已过期" });
        }
        res.json(row);
      }
    );
  });
});

// ============ URL / 协议安全校验工具 ============
// 安全的 URL 协议白名单 — 禁止 javascript:/data:/vbscript: 等可执行协议
const SAFE_URL_PROTOCOLS = ["http:", "https:"];

/**
 * 校验 URL 是否属于安全协议，仅允许 http/https 和 / 开头的站内相对路径
 * @param {string} url 用户输入的 URL
 * @returns {string|null} 安全的 URL 或 null（校验不通过）
 */
function sanitizeUrl(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // 站内相对路径 /uploads/xxx 安全
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed.substring(0, 500);
  }

  // 使用 WHATWG URL 解析器确保协议白名单检查的准确性
  try {
    const u = new URL(trimmed, "http://localhost");
    if (!SAFE_URL_PROTOCOLS.includes(u.protocol)) return null;
    return trimmed.substring(0, 500);
  } catch (e) {
    return null;
  }
}

/**
 * image_url 专属校验 — 仅允许 http/https 和 /uploads/ 开头的站内路径
 */
function sanitizeImageUrl(url) {
  const safe = sanitizeUrl(url);
  if (!safe) return null;
  if (safe.startsWith("/uploads/") || safe.startsWith("http://") || safe.startsWith("https://")) {
    return safe;
  }
  return null;
}

/**
 * fingerprint 字段统一校验 — 限制为字母数字、短横线、下划线；最长 100 字符
 * 为空时返回 "anonymous" 避免空字符串被用于"无限点赞绕过唯一约束"
 */
function sanitizeFingerprint(fp) {
  if (!fp || typeof fp !== "string") return "anonymous";
  const cleaned = fp.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!cleaned) return "anonymous";
  return cleaned.substring(0, 100);
}

// 发布帖子（带限流：每分钟最多 10 篇）
app.post("/api/posts", rateLimit(60000, 10), uploadHandle.single("image"), (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const content = req.body.content;
  const link_url = req.body.link_url || null;
  const mood = req.body.mood || null;
  const expires_in = req.body.expires_in || null; // 单位：小时，null表示永不过期
  const tags = req.body.tags || null; // 逗号分隔的标签

  if (!content || !content.trim()) {
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, () => {});
    }
    return res.status(400).json({ error: "内容不能为空" });
  }

  // 内容长度限制：最多 5000 字符（约 1500 个字），防止数据库膨胀攻击
  const MAX_CONTENT_LENGTH = 5000;
  if (String(content).length > MAX_CONTENT_LENGTH) {
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "内容过长，最多 " + MAX_CONTENT_LENGTH + " 字符" });
  }

  // link_url 协议白名单校验 — 防止 javascript:/data: XSS
  let safe_link_url = null;
  if (link_url && String(link_url).trim()) {
    safe_link_url = sanitizeUrl(link_url);
    if (!safe_link_url) {
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "链接地址不支持 (仅允许 http:// 或 https://)" });
    }
  }

  // mood 白名单枚举校验
  const VALID_MOODS = ["happy", "sad", "angry", "anxious", "calm", "love", "tired", "excited"];
  let safe_mood = null;
  if (mood && VALID_MOODS.includes(mood)) {
    safe_mood = mood;
  }

  if (containsBadWords(content)) {
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, () => {});
    }
    return res.status(400).json({ error: "内容包含不当词汇" });
  }

  const filteredContent = filterBadWords(content);

  // 清理标签：去空格、去重、限制数量
  let cleanTags = null;
  if (tags && typeof tags === "string") {
    const tagArr = tags.split(/[,，]/)
      .map(t => t.trim())
      .filter(t => t.length > 0 && t.length <= 20);
    const uniqueTags = [...new Set(tagArr)].slice(0, 5);
    if (uniqueTags.length > 0) {
      cleanTags = uniqueTags.join(",");
    }
  }

  // 计算过期时间（使用 UTC，确保与 SQLite datetime('now') 时区一致）
  let expires_at = null;
  if (expires_in && parseInt(expires_in) > 0) {
    const hours = parseInt(expires_in);
    const expiryMs = Date.now() + hours * 60 * 60 * 1000;
    const expiryDate = new Date(expiryMs);
    expires_at = expiryDate.getUTCFullYear() + '-' +
      String(expiryDate.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(expiryDate.getUTCDate()).padStart(2, '0') + ' ' +
      String(expiryDate.getUTCHours()).padStart(2, '0') + ':' +
      String(expiryDate.getUTCMinutes()).padStart(2, '0') + ':' +
      String(expiryDate.getUTCSeconds()).padStart(2, '0');
  }

  const image_url = req.file ? "/uploads/" + req.file.filename : null;

  db.run(
    "INSERT INTO posts (content, image_url, link_url, mood, expires_at, tags) VALUES (?, ?, ?, ?, ?, ?)",
    [filteredContent, image_url, safe_link_url, safe_mood, expires_at, cleanTags],
    function(err) {
      if (err) {
        logger.error("发布帖子失败: " + err.message);
        if (image_url) {
          const filePath = path.join(__dirname, "public", image_url);
          fs.unlink(filePath, () => {});
        }
        return res.status(500).json({ error: "发布失败，请重试" });
      }
      invalidateWriteCaches();
      res.json({
        id: this.lastID,
        content: filteredContent,
        image_url,
        link_url,
        mood,
        expires_at,
        tags: cleanTags
      });
    }
  );
});

// 举报帖子（带限流：每分钟最多 10 次）
app.post("/api/posts/:id/report", rateLimit(60000, 10), (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const postId = parseInt(req.params.id);
  const { reason, fingerprint } = req.body;

  if (isNaN(postId) || postId <= 0) {
    return res.status(400).json({ error: "无效的帖子ID" });
  }

  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: "请选择举报原因" });
  }

  // 检查帖子是否存在
  db.get("SELECT id FROM posts WHERE id = ?", [postId], (err, post) => {
    if (err) {
      return res.status(500).json({ error: "操作失败" });
    }
    if (!post) {
      return res.status(404).json({ error: "帖子不存在" });
    }

    db.run(
      "INSERT INTO reports (post_id, reason, fingerprint) VALUES (?, ?, ?)",
      [postId, reason.trim().substring(0, 200), fingerprint || "anonymous"],
      function(err) {
        if (err) {
          logger.error("提交举报失败: " + err.message);
          return res.status(500).json({ error: "举报失败，请重试" });
        }

        // 如果举报数>=3，自动隐藏帖子
        db.get("SELECT COUNT(*) as count FROM reports WHERE post_id = ?", [postId], (err, row) => {
          if (row && row.count >= 3) {
            db.run("UPDATE posts SET is_hidden = 1 WHERE id = ?", [postId]);
            logger.info(`帖子 ${postId} 因举报过多已被自动隐藏`);
          }
        });

        res.json({ success: true, message: "举报成功，感谢反馈" });
        invalidateWriteCaches();
      }
    );
  });
});

// 获取举报原因列表
app.get("/api/reports/reasons", (req, res) => {
  res.json([
    { value: "spam", label: "垃圾信息/广告" },
    { value: "harassment", label: "骚扰/人身攻击" },
    { value: "inappropriate", label: "不当内容" },
    { value: "misinformation", label: "虚假信息" },
    { value: "other", label: "其他" }
  ]);
});

// 点赞（带限流：每分钟最多 30 次）
app.post("/api/posts/:id/like", rateLimit(60000, 30), (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const postId = parseInt(req.params.id);
  const fingerprint = (req.body.fingerprint || "anonymous").substring(0, 100);

  if (isNaN(postId) || postId <= 0) {
    return res.status(400).json({ error: "无效的帖子ID" });
  }

  // 先查询是否已点赞
  db.get("SELECT id FROM post_likes WHERE post_id = ? AND fingerprint = ?", [postId, fingerprint], (err, row) => {
    if (err) {
      logger.error("查询点赞状态失败: " + err.message);
      return res.status(500).json({ error: "操作失败，请重试" });
    }

    if (row) {
      // 已点赞 → 取消点赞
      db.run("DELETE FROM post_likes WHERE id = ?", [row.id], (err) => {
        if (err) {
          logger.error("取消点赞失败: " + err.message);
          return res.status(500).json({ error: "操作失败，请重试" });
        }
        db.run("UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id = ?", [postId], (err) => {
          if (err) logger.error("更新点赞数失败: " + err.message);
          // 返回最新的 like_count（从 posts 表读保证准确）
          db.get("SELECT like_count FROM posts WHERE id = ?", [postId], (err2, post) => {
            invalidateWriteCaches();
            res.json({ liked: false, like_count: post ? post.like_count : 0 });
          });
        });
      });
    } else {
      // 未点赞 → 添加点赞
      db.run("INSERT INTO post_likes (post_id, fingerprint) VALUES (?, ?)", [postId, fingerprint], function(err) {
        if (err) {
          // 处理 UNIQUE 约束冲突（并发情况）
          if (err.message && err.message.includes("UNIQUE")) {
            db.get("SELECT like_count FROM posts WHERE id = ?", [postId], (err2, post) => {
              res.json({ liked: true, like_count: post ? post.like_count : 0 });
            });
            return;
          }
          logger.error("添加点赞失败: " + err.message);
          return res.status(500).json({ error: "操作失败，请重试" });
        }
        db.run("UPDATE posts SET like_count = like_count + 1 WHERE id = ?", [postId], (err) => {
          if (err) logger.error("更新点赞数失败: " + err.message);
          // 返回最新的 like_count（从 posts 表读保证准确）
          db.get("SELECT like_count FROM posts WHERE id = ?", [postId], (err2, post) => {
            invalidateWriteCaches();
            res.json({ liked: true, like_count: post ? post.like_count : 0 });
          });
        });
      });
    }
  });
});

app.get("/api/posts/:id/like", (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const postId = parseInt(req.params.id);
  const fingerprint = (req.query.fingerprint || "anonymous").substring(0, 100);

  if (isNaN(postId) || postId <= 0) {
    return res.status(400).json({ error: "无效的帖子ID" });
  }

  db.get(
    "SELECT id FROM post_likes WHERE post_id = ? AND fingerprint = ?",
    [postId, fingerprint],
    (err, row) => {
      if (err) {
        logger.error("查询点赞状态失败: " + err.message);
        return res.status(500).json({ error: "查询失败" });
      }
      res.json({ liked: !!row });
    }
  );
});

// ============ 评论相关（增强版：嵌套回复、昵称、点赞、排序） ============

// 获取帖子评论（支持嵌套结构、排序）
app.get("/api/posts/:id/comments", (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const postId = parseInt(req.params.id);
  if (isNaN(postId) || postId <= 0) {
    return res.status(400).json({ error: "无效的帖子ID" });
  }

  // 排序参数：latest（最新）/ hot（热门，按点赞数排序）
  let sort = req.query.sort || "latest";
  if (!["latest", "hot"].includes(sort)) {
    sort = "latest";
  }

  const orderBy = sort === "hot"
    ? "ORDER BY like_count DESC, created_at DESC"
    : "ORDER BY created_at ASC";

  db.all(
    `SELECT * FROM comments WHERE post_id = ? ${orderBy}`,
    [postId],
    (err, rows) => {
      if (err) {
        logger.error("查询评论失败: " + err.message);
        return res.status(500).json({ error: "获取评论失败" });
      }

      // 构建嵌套结构
      const comments = rows || [];
      const commentMap = {};
      const rootComments = [];

      // 先将所有评论放入 map
      comments.forEach(c => {
        commentMap[c.id] = { ...c, replies: [] };
      });

      // 构建树形结构
      comments.forEach(c => {
        const comment = commentMap[c.id];
        if (c.parent_id && commentMap[c.parent_id]) {
          commentMap[c.parent_id].replies.push(comment);
        } else {
          rootComments.push(comment);
        }
      });

      res.json(rootComments);
    }
  );
});

// 发表评论（带限流：每分钟最多 20 条，支持 parent_id 和 nickname）
app.post("/api/posts/:id/comments", rateLimit(60000, 20), (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const postId = parseInt(req.params.id);
  const content = req.body.content;
  const parentId = req.body.parent_id ? parseInt(req.body.parent_id) : null;
  const nickname = req.body.nickname ? req.body.nickname.trim().substring(0, 50) : null;
  // 帖内匿名头像 seed（基于 postId + 评论者 fingerprint 派生）
  const authorSeed = deriveAuthorSeed(postId, req.body.fingerprint);

  if (isNaN(postId) || postId <= 0) {
    return res.status(400).json({ error: "无效的帖子ID" });
  }

  if (!content || !content.trim()) {
    return res.status(400).json({ error: "评论内容不能为空" });
  }

  if (content.length > 500) {
    return res.status(400).json({ error: "评论过长（最多500字）" });
  }

  if (containsBadWords(content)) {
    return res.status(400).json({ error: "评论包含不当词汇" });
  }

  const filteredContent = filterBadWords(content);

  // 如果有 parent_id，验证父评论存在且属于同一帖子
  if (parentId) {
    db.get("SELECT id, post_id FROM comments WHERE id = ?", [parentId], (err, parentComment) => {
      if (err) {
        logger.error("查询父评论失败: " + err.message);
        return res.status(500).json({ error: "操作失败" });
      }
      if (!parentComment) {
        return res.status(404).json({ error: "回复的评论不存在" });
      }
      if (parentComment.post_id !== postId) {
        return res.status(400).json({ error: "回复的评论不属于该帖子" });
      }

      insertComment(postId, filteredContent, parentId, nickname, authorSeed, res);
    });
  } else {
    insertComment(postId, filteredContent, null, nickname, authorSeed, res);
  }
});

// 插入评论的通用方法
function insertComment(postId, content, parentId, nickname, authorSeed, res) {
  db.get("SELECT id FROM posts WHERE id = ? AND is_hidden = 0", [postId], (err, post) => {
    if (err) {
      logger.error("检查帖子失败: " + err.message);
      return res.status(500).json({ error: "操作失败" });
    }
    if (!post) {
      return res.status(404).json({ error: "帖子不存在或已被隐藏" });
    }

    db.run(
      "INSERT INTO comments (post_id, content, parent_id, nickname, author_seed) VALUES (?, ?, ?, ?, ?)",
      [postId, content, parentId, nickname, authorSeed],
      function(err) {
        if (err) {
          logger.error("发表评论失败: " + err.message);
          return res.status(500).json({ error: "发表失败，请重试" });
        }
        invalidateWriteCaches();
        res.json({
          id: this.lastID,
          content: content,
          parent_id: parentId,
          nickname: nickname,
          author_seed: authorSeed
        });
      }
    );
  });
}

// 评论点赞/取消点赞（带限流：每分钟最多 30 次）
app.post("/api/comments/:id/like", rateLimit(60000, 30), (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const commentId = parseInt(req.params.id);
  const fingerprint = (req.body.fingerprint || "anonymous").substring(0, 100);

  if (isNaN(commentId) || commentId <= 0) {
    return res.status(400).json({ error: "无效的评论ID" });
  }

  // 检查评论是否存在
  db.get("SELECT id FROM comments WHERE id = ?", [commentId], (err, comment) => {
    if (err) {
      logger.error("查询评论失败: " + err.message);
      return res.status(500).json({ error: "操作失败，请重试" });
    }
    if (!comment) {
      return res.status(404).json({ error: "评论不存在" });
    }

    // 检查是否已点赞
    db.get("SELECT id FROM comment_likes WHERE comment_id = ? AND fingerprint = ?", [commentId, fingerprint], (err, row) => {
      if (err) {
        logger.error("查询评论点赞状态失败: " + err.message);
        return res.status(500).json({ error: "操作失败，请重试" });
      }

      if (row) {
        // 已点赞 -> 取消点赞
        db.run("DELETE FROM comment_likes WHERE id = ?", [row.id], (err) => {
          if (err) {
            logger.error("取消评论点赞失败: " + err.message);
            return res.status(500).json({ error: "操作失败，请重试" });
          }
          db.run("UPDATE comments SET like_count = MAX(0, like_count - 1) WHERE id = ?", [commentId], (err) => {
            if (err) logger.error("更新评论点赞数失败: " + err.message);
          });
          // 从 comments 表读取真实的 like_count，保证返回值准确
          db.get("SELECT like_count FROM comments WHERE id = ?", [commentId], (err2, c) => {
            res.json({ liked: false, like_count: c ? c.like_count : 0 });
          });
        });
      } else {
        // 未点赞 -> 添加点赞
        db.run("INSERT INTO comment_likes (comment_id, fingerprint) VALUES (?, ?)", [commentId, fingerprint], function(err) {
          if (err) {
            if (err.message && err.message.includes("UNIQUE")) {
              db.get("SELECT like_count FROM comments WHERE id = ?", [commentId], (err2, c) => {
                res.json({ liked: true, like_count: c ? c.like_count : 1 });
              });
              return;
            }
            logger.error("添加评论点赞失败: " + err.message);
            return res.status(500).json({ error: "操作失败，请重试" });
          }
          db.run("UPDATE comments SET like_count = like_count + 1 WHERE id = ?", [commentId], (err) => {
            if (err) logger.error("更新评论点赞数失败: " + err.message);
          });
          db.get("SELECT like_count FROM comments WHERE id = ?", [commentId], (err2, c) => {
            res.json({ liked: true, like_count: c ? c.like_count : 1 });
          });
        });
      }
    });
  });
});

// ============ 收藏/书签功能 ============

// 收藏/取消收藏帖子（带限流：每分钟最多 30 次）
app.post("/api/posts/:id/bookmark", rateLimit(60000, 30), (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const postId = parseInt(req.params.id);
  const fingerprint = (req.body.fingerprint || "anonymous").substring(0, 100);

  if (isNaN(postId) || postId <= 0) {
    return res.status(400).json({ error: "无效的帖子ID" });
  }

  // 检查帖子是否存在
  db.get("SELECT id FROM posts WHERE id = ?", [postId], (err, post) => {
    if (err) {
      logger.error("查询帖子失败: " + err.message);
      return res.status(500).json({ error: "操作失败" });
    }
    if (!post) {
      return res.status(404).json({ error: "帖子不存在" });
    }

    // 检查是否已收藏
    db.get(
      "SELECT id FROM bookmarks WHERE post_id = ? AND fingerprint = ?",
      [postId, fingerprint],
      (err, row) => {
        if (err) {
          logger.error("查询收藏状态失败: " + err.message);
          return res.status(500).json({ error: "操作失败，请重试" });
        }

        if (row) {
          // 已收藏 -> 取消收藏
          db.run("DELETE FROM bookmarks WHERE id = ?", [row.id], function(err) {
            if (err) {
              logger.error("取消收藏失败: " + err.message);
              return res.status(500).json({ error: "操作失败，请重试" });
            }
            db.run("UPDATE posts SET bookmark_count = MAX(0, bookmark_count - 1) WHERE id = ?", [postId], (err) => {
              if (err) logger.error("更新收藏数失败: " + err.message);
              db.get("SELECT bookmark_count FROM posts WHERE id = ?", [postId], (err2, post) => {
                invalidateWriteCaches();
                res.json({ bookmarked: false, bookmark_count: post ? post.bookmark_count : 0 });
              });
            });
          });
        } else {
          // 未收藏 -> 添加收藏
          db.run(
            "INSERT INTO bookmarks (post_id, fingerprint) VALUES (?, ?)",
            [postId, fingerprint],
            function(err) {
              if (err) {
                if (err.message && err.message.includes("UNIQUE")) {
                  db.get("SELECT bookmark_count FROM posts WHERE id = ?", [postId], (err2, post) => {
                    invalidateWriteCaches();
                    res.json({ bookmarked: true, bookmark_count: post ? post.bookmark_count : 0 });
                });
                return;
              }
              logger.error("添加收藏失败: " + err.message);
              return res.status(500).json({ error: "操作失败，请重试" });
            }
              db.run("UPDATE posts SET bookmark_count = bookmark_count + 1 WHERE id = ?", [postId], (err) => {
                if (err) logger.error("更新收藏数失败: " + err.message);
                db.get("SELECT bookmark_count FROM posts WHERE id = ?", [postId], (err2, post) => {
                  invalidateWriteCaches();
                  res.json({ bookmarked: true, bookmark_count: post ? post.bookmark_count : 0 });
                });
              });
            }
          );
        }
      }
    );
  });
});

// 检查帖子是否已收藏
app.get("/api/posts/:id/bookmark", (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const postId = parseInt(req.params.id);
  const fingerprint = (req.query.fingerprint || "anonymous").substring(0, 100);

  if (isNaN(postId) || postId <= 0) {
    return res.status(400).json({ error: "无效的帖子ID" });
  }

  db.get(
    "SELECT id FROM bookmarks WHERE post_id = ? AND fingerprint = ?",
    [postId, fingerprint],
    (err, row) => {
      if (err) {
        logger.error("查询收藏状态失败: " + err.message);
        return res.status(500).json({ error: "查询失败" });
      }
      res.json({ bookmarked: !!row });
    }
  );
});

// 获取用户收藏列表
app.get("/api/bookmarks", (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const fingerprint = (req.query.fingerprint || "").substring(0, 100);
  if (!fingerprint) {
    return res.status(400).json({ error: "缺少 fingerprint 参数" });
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  // 查询总数
  db.get(
    "SELECT COUNT(*) as total FROM bookmarks b JOIN posts p ON b.post_id = p.id WHERE b.fingerprint = ?",
    [fingerprint],
    (err, countRow) => {
      if (err) {
        logger.error("查询收藏总数失败: " + err.message);
        return res.status(500).json({ error: "获取收藏列表失败" });
      }

      const total = countRow ? countRow.total : 0;
      const totalPages = Math.ceil(total / limit);

      // 查询收藏列表
      db.all(`
        SELECT p.*, b.created_at as bookmarked_at,
          (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comment_count
        FROM bookmarks b
        JOIN posts p ON b.post_id = p.id
        WHERE b.fingerprint = ?
        ORDER BY b.created_at DESC
        LIMIT ? OFFSET ?
      `, [fingerprint, limit, offset], (err, rows) => {
        if (err) {
          logger.error("查询收藏列表失败: " + err.message);
          return res.status(500).json({ error: "获取收藏列表失败" });
        }

        res.json({
          data: (rows || []).map(r => ({ ...r, is_bookmarked: true })),
          pagination: {
            page,
            limit,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1
          }
        });
      });
    }
  );
});

// ============ 简单内存缓存（键 -> { data, timestamp, refreshing }） ============
const CACHE_MAX_SIZE = 500;
const simpleCache = new Map();
const cacheRefreshInProgress = new Set();

function getCached(key, ttlMs, fn) {
  const hit = simpleCache.get(key);
  if (hit && Date.now() - hit.timestamp < ttlMs) return hit.data;
  const result = fn();
  _setCacheSafe(key, result);
  return result;
}

function _setCacheSafe(key, data) {
  // LRU 风格：达到上限时删除最旧的 20%
  if (simpleCache.size >= CACHE_MAX_SIZE) {
    const toRemove = Math.floor(CACHE_MAX_SIZE * 0.2);
    const keysIter = simpleCache.keys();
    for (let i = 0; i < toRemove; i++) {
      const k = keysIter.next().value;
      if (!k) break;
      simpleCache.delete(k);
    }
  }
  simpleCache.set(key, { data, timestamp: Date.now() });
}

function clearCache() { simpleCache.clear(); }

// 定期清理缓存（每10分钟），保存 timer 引用
const cacheCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of simpleCache.entries()) {
    if (now - v.timestamp > 600000) simpleCache.delete(k);
  }
}, 600000);

// ============ Promise 化的数据库辅助函数 ============
function dbGet(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params || [], (err, row) => err ? reject(err) : resolve(row));
  });
}
function dbAll(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params || [], (err, rows) => err ? reject(err) : resolve(rows));
  });
}

// ============ 热门标签 API ============
app.get("/api/tags/popular", (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const cacheKey = 'tags_popular';
  const cached = simpleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 60000) {
    return res.json(cached.data);
  }

  // 查询所有非空 tags，拆分后统计频率
  db.all(`
    SELECT tags FROM posts
    WHERE tags IS NOT NULL AND tags != ''
    AND is_hidden = 0
    AND (expires_at IS NULL OR expires_at > datetime('now'))
  `, (err, rows) => {
    if (err) {
      logger.error("查询标签失败: " + err.message);
      return res.status(500).json({ error: "获取标签失败" });
    }

    const tagCount = {};
    (rows || []).forEach(row => {
      const tags = row.tags.split(/[,，]/);
      tags.forEach(tag => {
        const t = tag.trim();
        if (t) {
          tagCount[t] = (tagCount[t] || 0) + 1;
        }
      });
    });

    // 按频率排序，取 TOP 20
    const sortedTags = Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));

    simpleCache.set(cacheKey, { data: sortedTags, timestamp: Date.now() });
    res.json(sortedTags);
  });
});

// ============ 社区情绪天气（聚合，匿名零风险） ============
app.get("/api/mood-weather", (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const cacheKey = 'mood_weather';
  const cached = simpleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 60000) {
    return res.json(cached.data);
  }

  const MIN_SAMPLE = 5; // 样本过少时回退到近 7 日，避免冷启动图表空
  // 时间窗为固定字面量（非用户输入），无注入风险
  const aggregate = (sinceExpr, cb) => {
    db.all(`
      SELECT mood, COUNT(*) AS count
      FROM posts
      WHERE is_hidden = 0
        AND (expires_at IS NULL OR expires_at > datetime('now'))
        AND mood IS NOT NULL AND mood != ''
        AND created_at >= ${sinceExpr}
      GROUP BY mood
      ORDER BY count DESC
    `, (err, rows) => cb(err, rows || []));
  };

  const finish = (range, rows) => {
    const total = rows.reduce((s, r) => s + r.count, 0);
    const data = { range, total, moods: rows };
    simpleCache.set(cacheKey, { data, timestamp: Date.now() });
    res.json(data);
  };

  aggregate("datetime('now','-1 day')", (err, dayRows) => {
    if (err) {
      logger.error("查询情绪天气失败: " + err.message);
      return res.status(500).json({ error: "获取情绪天气失败" });
    }
    const dayTotal = dayRows.reduce((s, r) => s + r.count, 0);
    if (dayTotal >= MIN_SAMPLE) {
      return finish('24h', dayRows);
    }
    aggregate("datetime('now','-7 days')", (err2, weekRows) => {
      if (err2) {
        logger.error("查询情绪天气(7日)失败: " + err2.message);
        return res.status(500).json({ error: "获取情绪天气失败" });
      }
      finish('7d', weekRows);
    });
  });
});

// ============ 管理员数据看板 API ============
app.get("/api/admin/dashboard", checkAdmin, async (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  try {
    const [postStats, commentStats, userStats, activeStats, moodStats, trendStats] = await Promise.all([
      // 总帖子数、今日新增帖子
      dbGet(db, `
        SELECT
          COUNT(*) as total_posts,
          SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) as today_posts
        FROM posts
      `),
      // 总评论数、今日新增评论
      dbGet(db, `
        SELECT
          COUNT(*) as total_comments,
          SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) as today_comments
        FROM comments
      `),
      // 总用户指纹数（来自 post_likes + bookmarks + comment_likes + reports）
      dbGet(db, `
        SELECT COUNT(DISTINCT fingerprint) as total_fingerprints FROM (
          SELECT fingerprint FROM post_likes
          UNION
          SELECT fingerprint FROM bookmarks
          UNION
          SELECT fingerprint FROM comment_likes
          UNION
          SELECT fingerprint FROM reports
        )
      `),
      // 活跃帖子（7天内有评论的）
      dbGet(db, `
        SELECT COUNT(DISTINCT post_id) as active_posts
        FROM comments
        WHERE created_at >= datetime('now', '-7 days')
      `),
      // 情绪分布统计
      dbAll(db, `
        SELECT mood, COUNT(*) as count
        FROM posts
        WHERE mood IS NOT NULL AND mood != ''
        GROUP BY mood
        ORDER BY count DESC
      `),
      // 每日帖子趋势（最近7天）
      dbAll(db, `
        SELECT date(created_at) as date, COUNT(*) as count
        FROM posts
        WHERE created_at >= datetime('now', '-7 days')
        GROUP BY date(created_at)
        ORDER BY date ASC
      `)
    ]);

    res.json({
      total_posts: (postStats && postStats.total_posts) || 0,
      today_posts: (postStats && postStats.today_posts) || 0,
      total_comments: (commentStats && commentStats.total_comments) || 0,
      today_comments: (commentStats && commentStats.today_comments) || 0,
      total_users: (userStats && userStats.total_fingerprints) || 0,
      active_posts_7d: (activeStats && activeStats.active_posts) || 0,
      mood_distribution: moodStats || [],
      daily_trend: trendStats || []
    });
  } catch (e) {
    logger.error("获取数据看板失败: " + e.message);
    res.status(500).json({ error: "获取数据看板失败" });
  }
});

// 管理员帖子列表（支持分页、筛选隐藏/过期帖子）
app.get("/api/admin/posts", checkAdmin, (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  // 筛选参数
  const filter = req.query.filter || "all"; // all / hidden / expired / active
  const search = (req.query.search || "").trim();
  let whereSql = "WHERE 1=1";
  const params = [];

  if (filter === "hidden") {
    whereSql += " AND p.is_hidden = 1";
  } else if (filter === "expired") {
    whereSql += " AND p.expires_at IS NOT NULL AND p.expires_at < datetime('now')";
  } else if (filter === "active") {
    whereSql += " AND p.is_hidden = 0 AND (p.expires_at IS NULL OR p.expires_at > datetime('now'))";
  }

  if (search) {
    whereSql += " AND p.content LIKE ?";
    params.push("%" + search.replace(/[%_]/g, "\\$&") + "%");
  }

  // 查询总数
  const countSql = `SELECT COUNT(*) as total FROM posts p ${whereSql}`;
  db.get(countSql, params, (err, countRow) => {
    if (err) {
      logger.error("管理员查询帖子总数失败: " + err.message);
      return res.status(500).json({ error: "获取帖子列表失败" });
    }

    const total = countRow ? countRow.total : 0;
    const totalPages = Math.ceil(total / limit);

    // 查询帖子列表
    const dataSql = `
      SELECT p.*, COUNT(c.id) as comment_count,
        (SELECT COUNT(*) FROM reports r WHERE r.post_id = p.id AND r.status = 'pending') as pending_reports
      FROM posts p
      LEFT JOIN comments c ON p.id = c.post_id
      ${whereSql}
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `;

    db.all(dataSql, [...params, limit, offset], (err, rows) => {
      if (err) {
        logger.error("管理员查询帖子列表失败: " + err.message);
        return res.status(500).json({ error: "获取帖子列表失败" });
      }

      res.json({
        data: rows || [],
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1
        }
      });
    });
  });
});

// ============ SEO 相关 API ============

// 动态生成 sitemap.xml
app.get("/sitemap.xml", (req, res) => {
  if (!dbReady) {
    return res.status(503).send("服务暂不可用");
  }

  db.all(`
    SELECT id, created_at FROM posts
    WHERE is_hidden = 0
    AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY created_at DESC
    LIMIT 1000
  `, (err, rows) => {
    if (err) {
      logger.error("生成 sitemap 失败: " + err.message);
      return res.status(500).send("生成站点地图失败");
    }

    const posts = rows || [];
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    xml += `  <url>\n    <loc>${SITE_URL}</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n`;

    posts.forEach(post => {
      const lastmod = post.created_at ? post.created_at.split(" ")[0] : new Date().toISOString().split("T")[0];
      xml += `  <url>\n    <loc>${SITE_URL}/#post-${post.id}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
    });

    xml += '</urlset>';

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(xml);
  });
});

// robots.txt
app.get("/robots.txt", (req, res) => {
  const content = `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(content);
});

// 结构化数据 API（JSON-LD）
app.get("/api/structured-data", (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  db.get("SELECT COUNT(*) as total FROM posts WHERE is_hidden = 0 AND (expires_at IS NULL OR expires_at > datetime('now'))", (err, row) => {
    const postCount = row ? row.total : 0;

    const structuredData = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "匿名分享",
      "description": "一个匿名分享心情和想法的平台",
      "url": SITE_URL,
      "potentialAction": {
        "@type": "SearchAction",
        "target": {
          "@type": "EntryPoint",
          "urlTemplate": `${SITE_URL}?search={search_term_string}`
        },
        "query-input": "required name=search_term_string"
      },
      "about": {
        "@type": "Thing",
        "name": "匿名分享社区",
        "description": `已有 ${postCount} 条匿名分享`
      }
    };

    res.json(structuredData);
  });
});

// ============ 删除帖子（管理员） ============
app.delete("/api/posts/:id", checkAdmin, (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const postId = parseInt(req.params.id);
  if (isNaN(postId) || postId <= 0) {
    return res.status(400).json({ error: "无效的帖子ID" });
  }

  db.get("SELECT image_url FROM posts WHERE id = ?", [postId], (err, row) => {
    if (err) {
      logger.error("查询帖子图片失败: " + err.message);
    }
    var imagePath = row ? row.image_url : null;

    // 直接删除主帖（外键级联自动清理相关点赞/评论/收藏/举报）
    db.run("DELETE FROM posts WHERE id = ?", [postId], function(deleteErr) {
      if (deleteErr) {
        logger.error("删除帖子失败: " + deleteErr.message);
        return res.status(500).json({ error: "删除失败，请重试" });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: "帖子不存在" });
      }

      if (imagePath) {
        const fullPath = path.join(__dirname, "public", imagePath);
        fs.unlink(fullPath, (fsErr) => {
          if (fsErr && fsErr.code !== "ENOENT") {
            logger.error("删除图片失败: " + fsErr.message);
          }
        });
      }

      auditLog("ADMIN_DELETE_POST", req, "post=" + postId);
      invalidateWriteCaches();
      res.json({ success: true });
    });
  });
});

// 删除评论（管理员）
app.delete("/api/comments/:id", checkAdmin, (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const commentId = parseInt(req.params.id);
  if (isNaN(commentId) || commentId <= 0) {
    return res.status(400).json({ error: "无效的评论ID" });
  }

  db.run("DELETE FROM comments WHERE id = ?", [commentId], function(err) {
    if (err) {
      logger.error("删除评论失败: " + err.message);
      return res.status(500).json({ error: "删除失败，请重试" });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: "评论不存在" });
    }

    auditLog("ADMIN_DELETE_COMMENT", req, "comment=" + commentId);
    invalidateWriteCaches();
    res.json({ success: true });
  });
});

// 获取举报列表（管理员）
app.get("/api/admin/reports", checkAdmin, (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  db.all(`
    SELECT r.*, p.content as post_content
    FROM reports r
    JOIN posts p ON r.post_id = p.id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC
  `, (err, rows) => {
    if (err) {
      logger.error("查询举报列表失败: " + err.message);
      return res.status(500).json({ error: "获取举报列表失败" });
    }
    res.json(rows || []);
  });
});

// 处理举报（管理员）
app.put("/api/admin/reports/:id", checkAdmin, (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: "服务暂不可用，请稍后重试" });
  }

  const reportId = parseInt(req.params.id);
  const { action } = req.body; // 'hide' 隐藏帖子，'dismiss' 忽略

  if (isNaN(reportId) || reportId <= 0) {
    return res.status(400).json({ error: "无效的举报ID" });
  }

  db.get("SELECT post_id FROM reports WHERE id = ?", [reportId], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: "举报不存在" });
    }

    if (action === 'hide') {
      db.run("UPDATE posts SET is_hidden = 1 WHERE id = ?", [row.post_id]);
    }

    db.run("UPDATE reports SET status = ? WHERE id = ?", [action === 'hide' ? 'resolved' : 'dismissed', reportId], (err) => {
      if (err) {
        return res.status(500).json({ error: "处理失败" });
      }
      auditLog("ADMIN_HANDLE_REPORT", req, "report=" + reportId + " action=" + action);
      invalidateWriteCaches();
      res.json({ success: true });
    });
  });
});

// 404 处理
app.use((req, res) => {
  res.status(404).json({ error: "接口不存在" });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  logger.error(err.message);
  res.status(500).json({ error: "服务器内部错误" });
});

// ============ 启动服务器 ============
const server = app.listen(PORT, "0.0.0.0", () => {
  logger.info(`服务已启动，监听端口 ${PORT}`);
  logger.info(`访问地址: http://localhost:${PORT}`);
  logger.info(`健康检查: http://localhost:${PORT}/api/health`);
  logger.info(`统计信息: http://localhost:${PORT}/api/stats`);
  logger.info(`站点地图: http://localhost:${PORT}/sitemap.xml`);
  logger.info(`robots.txt: http://localhost:${PORT}/robots.txt`);
  console.log("========================================");
  console.log(`[SERVER] 服务已启动`);
  console.log(`[SERVER] 访问地址: http://localhost:${PORT}`);
  console.log(`[SERVER] 健康检查: http://localhost:${PORT}/api/health`);
  console.log(`[SERVER] 统计信息: http://localhost:${PORT}/api/stats`);
  console.log(`[SERVER] 站点地图: http://localhost:${PORT}/sitemap.xml`);
  console.log(`[SERVER] robots.txt: http://localhost:${PORT}/robots.txt`);
  console.log("========================================");
});

// ============ 优雅关闭 ============
function gracefulShutdown(signal) {
  logger.info(`收到 ${signal} 信号，开始优雅关闭...`);
  console.log(`\n[SHUTDOWN] 收到 ${signal} 信号，开始优雅关闭...`);
  server.close(() => {
    logger.info("HTTP 服务器已关闭");
    console.log("[SHUTDOWN] HTTP 服务器已关闭");
    if (db) {
      db.close((err) => {
        if (err) {
          logger.error("关闭数据库失败: " + err.message);
          console.error("[SHUTDOWN] 关闭数据库失败:", err.message);
        } else {
          logger.info("数据库连接已关闭");
          console.log("[SHUTDOWN] 数据库连接已关闭");
        }
        logger.info("优雅关闭完成");
        console.log("[SHUTDOWN] 优雅关闭完成");
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });

  setTimeout(() => {
    logger.error("优雅关闭超时，强制退出");
    console.error("[SHUTDOWN] 优雅关闭超时，强制退出");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.error("未捕获的异常: " + err.message + "\n" + err.stack);
  console.error("[FATAL] 未捕获的异常:", err.message);
  console.error(err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("未处理的 Promise 拒绝: " + reason);
  console.error("[FATAL] 未处理的 Promise 拒绝:", reason);
});
