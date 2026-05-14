const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('数据库连接错误:', err.message);
  } else {
    console.log('成功连接到SQLite数据库');
    initDatabase();
  }
});

function initDatabase() {
  const fs = require('fs');
  const schema = fs.readFileSync('./schema.sql', 'utf8');
  db.exec(schema, (err) => {
    if (err) {
      console.error('数据库初始化错误:', err.message);
    } else {
      console.log('数据库表初始化完成');
    }
  });
}

const sensitiveWords = ['敏感词1', '敏感词2', '敏感词3', '敏感词4', '敏感词5', 'fuck', 'shit', 'bitch', 'damn', 'asshole'];

function filterContent(content) {
  if (!content) return content;
  let filtered = content;
  sensitiveWords.forEach(word => {
    const regex = new RegExp(word, 'gi');
    filtered = filtered.replace(regex, '*'.repeat(word.length));
  });
  return filtered;
}

function containsSensitiveContent(content) {
  if (!content) return false;
  return sensitiveWords.some(word => {
    const regex = new RegExp(word, 'i');
    return regex.test(content);
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, './uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const fileTypes = /jpeg|jpg|png|gif/;
    const extname = fileTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = fileTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('只允许上传图片文件'));
    }
  }
});

app.get('/api/posts', (req, res) => {
  db.all(`
    SELECT p.*, COUNT(c.id) as comment_count 
    FROM posts p 
    LEFT JOIN comments c ON p.id = c.post_id 
    GROUP BY p.id 
    ORDER BY p.created_at DESC
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json(rows);
    }
  });
});

app.post('/api/posts', upload.single('image'), (req, res) => {
  const { content, link_url } = req.body;
  const image_url = req.file ? `/uploads/${req.file.filename}` : null;

  if (containsSensitiveContent(content)) {
    return res.status(400).json({ error: '内容包含敏感信息' });
  }

  const filteredContent = filterContent(content);

  db.run(
    'INSERT INTO posts (content, image_url, link_url) VALUES (?, ?, ?)',
    [filteredContent, image_url, link_url],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        db.get('SELECT * FROM posts WHERE id = ?', [this.lastID], (err, post) => {
          if (err) {
            res.status(500).json({ error: err.message });
          } else {
            res.status(201).json(post);
          }
        });
      }
    }
  );
});

app.get('/api/posts/:id/comments', (req, res) => {
  const postId = req.params.id;
  db.all('SELECT * FROM comments WHERE post_id = ? ORDER BY created_at DESC', [postId], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json(rows);
    }
  });
});

app.post('/api/posts/:id/comments', (req, res) => {
  const postId = req.params.id;
  const { content } = req.body;

  if (containsSensitiveContent(content)) {
    return res.status(400).json({ error: '内容包含敏感信息' });
  }

  const filteredContent = filterContent(content);

  db.run(
    'INSERT INTO comments (post_id, content) VALUES (?, ?)',
    [postId, filteredContent],
    function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        db.get('SELECT * FROM comments WHERE id = ?', [this.lastID], (err, comment) => {
          if (err) {
            res.status(500).json({ error: err.message });
          } else {
            res.status(201).json(comment);
          }
        });
      }
    }
  );
});

app.delete('/api/posts/:id', (req, res) => {
  const postId = req.params.id;
  db.run('DELETE FROM posts WHERE id = ?', [postId], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
    } else if (this.changes === 0) {
      res.status(404).json({ error: '帖子不存在' });
    } else {
      res.json({ message: '删除成功' });
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
