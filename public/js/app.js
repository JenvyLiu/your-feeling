
    // ============ 全局变量 ============
    var API_BASE = window.location.origin;
    var userFingerprint = localStorage.getItem('user_fingerprint') || (function() {
      var fp = 'fp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
      localStorage.setItem('user_fingerprint', fp);
      return fp;
    })();
    var adminPassword = ''; // 密码仅保存在内存中，重启浏览器即失效，避免 XSS 窃取风险
    var isAdminMode = false; // 管理员状态同样不持久化
    var likedPosts = new Set();
    var likedComments = new Set();
    var bookmarkedPosts = new Set();
    var commentLoading = {};
    var commentSubmitting = {};
    var commentNickname = localStorage.getItem('comment_nickname') || '';
    var replyingTo = null;
    var reportPostId = null;
    var currentPage = 1;
    var isLoading = false;
    var hasMore = true;
    var currentSearch = '';
    var currentSort = 'latest';
    var currentMood = '';
    var currentTag = '';
    var isBookmarksView = false;

    // ============ 工具函数 ============
    // 统一事件委托:捕获帖子卡片、评论、标签、管理员列表中动态按钮的点击,
    // 替代 onclick="func(' + data + ')" 字符串拼接,避免注入风险。
    function setupEventDelegation() {
      document.addEventListener('click', function(e) {
        var target = e.target.closest('[data-action]');
        if (!target) return;
        var action = target.getAttribute('data-action');
        var id = target.getAttribute('data-id');
        var pid = target.getAttribute('data-post-id');
        var cid = target.getAttribute('data-comment-id');
        var tag = target.getAttribute('data-tag');
        var page = target.getAttribute('data-page');

        switch (action) {
          case 'lightbox':
            if (target.tagName === 'IMG') openLightbox(target.getAttribute('src') || target.getAttribute('data-src'));
            else openLightbox(target.getAttribute('data-src'));
            break;
          case 'filter-tag':
            if (tag) filterByTag(tag);
            break;
          case 'toggle-like':
            if (id) toggleLike(id);
            break;
          case 'toggle-comments':
            if (id) toggleComments(id);
            break;
          case 'toggle-bookmark':
            if (id) toggleBookmark(id);
            break;
          case 'open-report':
            if (id) openReportModal(id);
            break;
          case 'delete-post':
            if (id) deletePost(id);
            break;
          case 'react':
            if (id) toggleReaction(id, target.getAttribute('data-type'));
            break;
          case 'goto-post':
            if (id) gotoPost(id);
            break;
          case 'reveal-cw':
            if (id) revealCw(id);
            break;
          case 'mood-channel':
            selectMoodChannel(target.getAttribute('data-mood') || '');
            break;
          case 'share-card':
            if (id) sharePostCard(id);
            break;
          case 'random-nickname':
            if (id) generateRandomNickname(id);
            break;
          case 'submit-comment':
            if (id) submitComment(e, id);
            break;
          case 'cancel-reply':
            if (id) cancelReply(id);
            break;
          case 'toggle-comment-like':
            if (id) toggleCommentLike(id);
            break;
          case 'start-reply':
            if (pid && cid) startReply(pid, cid, target.getAttribute('data-nickname') || '匿名用户');
            break;
          case 'delete-comment':
            if (cid && pid) deleteComment(cid, pid);
            break;
          case 'admin-expand':
            if (id) adminToggleExpand(id);
            break;
          case 'admin-toggle-hide':
            if (id) adminToggleHide(id);
            break;
          case 'admin-delete-post':
            if (id) adminDeletePost(id);
            break;
          case 'admin-go-page':
            if (page) adminGoPage(page);
            break;
          case 'comments-expand':
            if (id) toggleCommentsExpand(id);
            break;
        }
      });
      // 复选框 change 事件同样走事件委托
      document.addEventListener('change', function(e) {
        var target = e.target;
        if (!target || !target.getAttribute) return;
        var action = target.getAttribute('data-action');
        if (action === 'admin-toggle-select') {
          var id = target.getAttribute('data-id');
          if (id) adminToggleSelect(id);
        }
      });
    }

    // 解析 SQLite/数据库时间字符串（UTC 存储）
    function parseDBDate(dateStr) {
      if (!dateStr) return new Date(NaN);
      // ISO 格式带 Z / T 分隔符：让 Date 自行解析
      if (dateStr.indexOf('T') >= 0 || dateStr.indexOf('Z') >= 0) {
        return new Date(dateStr);
      }
      // 旧格式 "YYYY-MM-DD HH:MM:SS"：按 UTC 处理（SQLite 实际存的是 UTC）
      var m = dateStr.match(/(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2}):(\d{2})/);
      if (m) {
        return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
      }
      return new Date(dateStr);
    }

    function formatTime(dateStr) {
      if (!dateStr) return '';
      var date = parseDBDate(dateStr);
      var now = new Date();
      var diff = now - date;
      var seconds = Math.floor(diff / 1000);
      var minutes = Math.floor(seconds / 60);
      var hours = Math.floor(minutes / 60);
      var days = Math.floor(hours / 24);

      if (seconds < 60) return '刚刚';
      if (minutes < 60) return minutes + '分钟前';
      if (hours < 24) return hours + '小时前';
      if (days < 7) return days + '天前';
      var y = date.getFullYear();
      var m = String(date.getMonth() + 1).padStart(2, '0');
      var d = String(date.getDate()).padStart(2, '0');
      var h = String(date.getHours()).padStart(2, '0');
      var min = String(date.getMinutes()).padStart(2, '0');
      return y + '-' + m + '-' + d + ' ' + h + ':' + min;
    }

    function showToast(message, type) {
      type = type || 'info';
      var container = document.getElementById('toast');
      var toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(function() {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 3000);
    }

    async function stableFetch(url, options) {
      options = options || {};
      try {
        // 使用 AbortController 实现 15 秒超时，防止网络异常时永久等待
        var controller = new AbortController();
        var timeoutId = setTimeout(function() { controller.abort(); }, 15000);
        if (options.body instanceof FormData) {
          delete options.headers;
        }
        var response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
        clearTimeout(timeoutId);
        var data = await response.json();
        if (!response.ok) {
          // 错误信息统一走 textContent 渲染路径，防止 XSS
          throw new Error(data.error || '请求失败');
        }
        return data;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw new Error('请求超时，请检查网络后重试');
        }
        throw err;
      }
    }

    // ============ 主题切换 ============
    function toggleTheme() {
      var html = document.documentElement;
      var icon = document.getElementById('theme-icon');
      if (html.getAttribute('data-theme') === 'light') {
        html.removeAttribute('data-theme');
        icon.className = 'fa fa-moon-o';
        localStorage.setItem('theme', 'dark');
      } else {
        html.setAttribute('data-theme', 'light');
        icon.className = 'fa fa-sun-o';
        localStorage.setItem('theme', 'light');
      }
    }
    (function() {
      var savedTheme = localStorage.getItem('theme');
      if (savedTheme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        var icon = document.getElementById('theme-icon');
        if (icon) icon.className = 'fa fa-sun-o';
      }
    })();

    // ============ 搜索/排序/筛选 ============
    var searchTimer = null;
    function handleSearch() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function() {
        currentSearch = document.getElementById('search-input').value.trim();
        resetAndLoadPosts();
      }, 400);
    }
    function handleSortChange() {
      currentSort = document.getElementById('sort-select').value;
      resetAndLoadPosts();
    }
    function handleMoodFilter() {
      currentMood = document.getElementById('mood-filter').value;
      resetAndLoadPosts();
    }

    // ============ 心情映射 ============
    var moodMap = {
      happy: { label: '开心', icon: 'fa-smile-o', color: '#f59e0b' },
      sad: { label: '难过', icon: 'fa-frown-o', color: '#3b82f6' },
      angry: { label: '生气', icon: 'fa-angry', color: '#ef4444' },
      anxious: { label: '焦虑', icon: 'fa-meh-o', color: '#8b5cf6' },
      calm: { label: '平静', icon: 'fa-smile-o', color: '#22c55e' },
      love: { label: '恋爱', icon: 'fa-heart', color: '#ec4899' },
      tired: { label: '疲惫', icon: 'fa-tired', color: '#6b7280' },
      excited: { label: '兴奋', icon: 'fa-bolt', color: '#f97316' }
    };

    // ============ 情绪共鸣反应 ============
    var reactionMeta = [
      { type: 'hug', emoji: '🤗', label: '抱抱' },
      { type: 'resonate', emoji: '💗', label: '共鸣' },
      { type: 'cheer', emoji: '💪', label: '加油' },
      { type: 'understand', emoji: '🫶', label: '懂你' }
    ];
    function reactionsRowHtml(postId) {
      var h = '<div class="post-reactions" id="reactions-' + postId + '">';
      for (var i = 0; i < reactionMeta.length; i++) {
        var m = reactionMeta[i];
        h += '<button type="button" class="reaction-btn" data-action="react" data-id="' + postId + '" data-type="' + m.type + '" id="reaction-' + m.type + '-' + postId + '" aria-label="' + m.label + '">';
        h += '<span class="reaction-emoji">' + m.emoji + '</span>';
        h += '<span class="reaction-count" id="reaction-count-' + m.type + '-' + postId + '">0</span>';
        h += '</button>';
      }
      h += '</div>';
      return h;
    }
    function applyReactionState(postId, data) {
      if (!data || !data.counts) return;
      var mine = data.mine || [];
      reactionMeta.forEach(function(m) {
        var btn = document.getElementById('reaction-' + m.type + '-' + postId);
        var cnt = document.getElementById('reaction-count-' + m.type + '-' + postId);
        if (cnt) cnt.textContent = data.counts[m.type] || 0;
        if (btn) {
          if (mine.indexOf(m.type) !== -1) btn.classList.add('reacted');
          else btn.classList.remove('reacted');
        }
      });
    }
    async function loadReactions(postId) {
      try {
        var data = await stableFetch(API_BASE + '/api/posts/' + postId + '/reactions?fingerprint=' + encodeURIComponent(userFingerprint));
        applyReactionState(postId, data);
      } catch (err) {}
    }
    async function toggleReaction(postId, type) {
      try {
        var data = await stableFetch(API_BASE + '/api/posts/' + postId + '/reactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint: userFingerprint, type: type })
        });
        applyReactionState(postId, data);
        if (data && data.mine && data.mine.indexOf(type) !== -1) {
          bumpCounter('yf_reaction_count');
          if (checkinStats) renderBadges(checkinStats);
        }
      } catch (err) {
        showToast(err.message || '操作失败', 'error');
      }
    }

    // ============ 漂流瓶 ============
    var driftLastId = null;
    function openDrift() {
      var modal = document.getElementById('drift-modal');
      modal.classList.add('active');
      document.body.classList.add('modal-open');
      drawDrift();
    }
    function closeDrift() {
      document.getElementById('drift-modal').classList.remove('active');
      document.body.classList.remove('modal-open');
    }
    async function drawDrift() {
      var body = document.getElementById('drift-body');
      body.innerHTML = '<p class="drift-loading"><i class="fa fa-spinner fa-spin"></i> 正在打捞...</p>';
      try {
        var url = API_BASE + '/api/posts/drift' + (driftLastId ? ('?exclude=' + driftLastId) : '');
        var post = await stableFetch(url);
        if (!post || !post.content) {
          body.innerHTML = '<p class="drift-empty">海面很安静，还没有漂流瓶。来发布第一条吧～</p>';
          return;
        }
        driftLastId = post.id;
        body.innerHTML = '';
        var card = document.createElement('div');
        card.className = 'drift-card';
        if (post.mood && moodMap[post.mood]) {
          var moodEl = document.createElement('div');
          moodEl.className = 'drift-mood';
          moodEl.style.color = moodMap[post.mood].color;
          moodEl.innerHTML = '<i class="fa ' + moodMap[post.mood].icon + '"></i> ' + moodMap[post.mood].label;
          card.appendChild(moodEl);
        }
        var content = document.createElement('div');
        content.className = 'drift-text';
        content.textContent = post.content;
        card.appendChild(content);
        var meta = document.createElement('div');
        meta.className = 'drift-meta';
        meta.textContent = '❤ ' + (post.like_count || 0) + '    💬 ' + (post.comment_count || 0);
        card.appendChild(meta);
        body.appendChild(card);
      } catch (err) {
        body.innerHTML = '<p class="drift-empty">打捞失败，再试一次吧</p>';
      }
    }

    // ============ 帖子渲染 ============
    function renderPost(post) {
      var isLiked = likedPosts.has(post.id);
      var isBookmarked = bookmarkedPosts.has(post.id);
      var moodInfo = post.mood ? moodMap[post.mood] : null;

      var html = '<div class="post-card" id="post-' + post.id + '">';
      // 使用 textContent 渲染帖子主体内容,防止 XSS
      if (post.is_sensitive) {
        // 敏感内容默认折叠（保持 .post-content 为直接子元素，不破坏 setPostContents）
        html += '<div class="post-content cw-blurred"></div>';
        html += '<button class="cw-reveal" data-action="reveal-cw" data-id="' + post.id + '"><i class="fa fa-eye-slash" aria-hidden="true"></i> 敏感内容 · 点击查看</button>';
      } else {
        html += '<div class="post-content"></div>';
      }

      // 图片
      if (post.image_url) {
        html += '<img class="post-image" src="' + escapeHtml(post.image_url) + '" alt="帖子图片" data-action="lightbox" data-src="' + escapeHtml(post.image_url) + '" loading="lazy">';
      }

      // 链接
      if (post.link_url) {
        var displayUrl = post.link_url;
        if (displayUrl.length > 50) displayUrl = displayUrl.substring(0, 50) + '...';
        html += '<a class="post-link" href="' + escapeHtml(post.link_url) + '" target="_blank" rel="noopener noreferrer"><i class="fa fa-external-link"></i> ' + escapeHtml(displayUrl) + '</a>';
      }

      // 标签 — 使用 data-action + data-tag 委托事件,避免 onclick 字符串拼接
      if (post.tags) {
        try {
          var tags = typeof post.tags === 'string' ? JSON.parse(post.tags) : post.tags;
          if (Array.isArray(tags) && tags.length > 0) {
            html += '<div style="margin-top: 8px;" data-post-id="' + post.id + '">';
            for (var t = 0; t < tags.length; t++) {
              html += '<span class="tag" data-action="filter-tag" data-tag="' + escapeHtml(tags[t]) + '">#' + escapeHtml(tags[t]) + '</span>';
            }
            html += '</div>';
          }
        } catch(e) {}
      }

      // 元信息
      html += '<div class="post-meta">';
      html += '<span class="post-meta-item"><i class="fa fa-clock-o"></i> ' + formatTime(post.created_at) + '</span>';
      if (moodInfo) {
        html += '<span class="mood-badge"><i class="fa ' + moodInfo.icon + '"></i> ' + moodInfo.label + '</span>';
      }
      if (post.expires_in) {
        html += '<span class="expiry-badge"><i class="fa fa-hourglass-half"></i> 限时</span>';
      }
      html += '</div>';

      // 操作按钮:全部改为 data-action/data-id 事件委托
      html += '<div class="post-actions">';
      html += '<button type="button" class="action-btn ' + (isLiked ? 'liked' : '') + '" aria-label="' + (isLiked ? '取消点赞' : '点赞') + '" data-action="toggle-like" data-id="' + post.id + '">';
      html += '<i class="fa fa-thumbs' + (isLiked ? '' : '-o') + '-up"></i>';
      html += '<span id="like-count-' + post.id + '">' + (post.like_count || 0) + '</span></button>';
      html += '<button type="button" class="action-btn" aria-label="查看评论" data-action="toggle-comments" data-id="' + post.id + '"><i class="fa fa-comment-o"></i> ' + (post.comment_count || 0) + '</button>';
      html += '<button type="button" class="action-btn ' + (isBookmarked ? 'bookmarked' : '') + '" aria-label="' + (isBookmarked ? '取消收藏' : '收藏') + '" data-action="toggle-bookmark" data-id="' + post.id + '">';
      html += '<i class="fa fa-bookmark"></i>';
      html += '<span id="bookmark-count-' + post.id + '">' + (post.bookmark_count || 0) + '</span></button>';
      html += '<button type="button" class="action-btn" aria-label="举报帖子" data-action="open-report" data-id="' + post.id + '"><i class="fa fa-flag-o"></i></button>';
      html += '<button type="button" class="action-btn" aria-label="生成分享图" title="生成分享图" data-action="share-card" data-id="' + post.id + '"><i class="fa fa-share-alt"></i></button>';
      if (isAdminMode) {
        html += '<button class="action-btn" aria-label="删除帖子" data-action="delete-post" data-id="' + post.id + '" style="color: var(--danger);"><i class="fa fa-trash"></i></button>';
      }
      html += '</div>';

      // 情绪共鸣反应行
      html += reactionsRowHtml(post.id);

      // 评论区:评论输入内的按钮也改用事件委托
      html += '<div id="comments-' + post.id + '" class="comments-section" style="display: none;">';
      html += '<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">';
      // 评论排序下拉:通过 data-action change 事件;此处用 onchange 指向已有函数(值为静态,不涉及注入)
      html += '<select id="comment-sort-' + post.id + '" class="nav-select" style="font-size: 0.8rem; padding: 4px 10px;" onchange="changeCommentSort(\'' + post.id + '\')">';
      html += '<option value="latest">最新评论</option>';
      html += '<option value="oldest">最早评论</option>';
      html += '</select>';
      html += '<div id="comments-expand-' + post.id + '" style="display: none;"></div>';
      html += '</div>';
      html += '<div id="comments-list-' + post.id + '"></div>';

      // 相似心声推荐
      html += '<div id="similar-' + post.id + '" class="similar-section"></div>';

      // 回复信息
      html += '<div id="comment-reply-info-' + post.id + '" class="comment-reply-info" style="display: none; font-size: 0.8rem; color: var(--accent-purple); margin-bottom: 4px;"></div>';

      // 评论输入
      html += '<div class="comment-input-wrapper">';
      html += '<input type="text" id="comment-nickname-' + post.id + '" class="form-input" style="width: 100px; font-size: 0.8rem; padding: 6px 10px;" placeholder="昵称" aria-label="评论昵称" value="' + escapeHtml(commentNickname) + '">';
      html += '<button type="button" class="btn-secondary" aria-label="随机昵称" title="随机昵称" style="font-size: 0.75rem; padding: 4px 8px; white-space: nowrap;" data-action="random-nickname" data-id="' + post.id + '"><i class="fa fa-random"></i></button>';
      html += '<textarea id="comment-input-' + post.id + '" class="comment-input" placeholder="写下你的评论..." aria-label="评论内容" rows="1"></textarea>';
      html += '<button id="comment-submit-btn-' + post.id + '" class="comment-submit-btn" aria-label="发送评论" data-action="submit-comment" data-id="' + post.id + '"><i class="fa fa-paper-plane"></i></button>';
      html += '</div>';
      html += '<div id="cancel-reply-btn-' + post.id + '" style="display: none; margin-top: 4px;">';
      html += '<button type="button" class="btn-secondary" style="font-size: 0.75rem; padding: 4px 8px;" data-action="cancel-reply" data-id="' + post.id + '"><i class="fa fa-times"></i> 取消回复</button>';
      html += '</div>';
      html += '</div>';

      html += '</div>';
      return html;
    }

    // 极简安全 Markdown：先整体 HTML 转义，再在转义后的文本上套用有限标记，杜绝 XSS
    function renderMarkdown(text) {
      var s = escapeHtml(String(text || ''));
      s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
      // 链接 [文字](http(s)://...)，href 取自已转义文本，引号已成 &quot; 无法逃逸属性
      s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      s = s.replace(/\n/g, '<br>');
      return s;
    }

    // 把帖子正文写入 .post-content：用 escape-first 的安全 Markdown，仍彻底阻断 XSS
    function setPostContents(posts) {
      if (!posts || !posts.length) return;
      for (var i = 0; i < posts.length; i++) {
        var post = posts[i];
        var contentEl = document.querySelector('#post-' + post.id + ' > .post-content');
        if (contentEl) contentEl.innerHTML = renderMarkdown(post.content || '');
      }
    }


    // ============ 帖子加载 ============
    function renderSkeletons(count) {
      var html = '';
      for (var i = 0; i < count; i++) {
        html += '<div class="skeleton-card">';
        html += '<div class="skeleton skeleton-line w-3-4"></div>';
        html += '<div class="skeleton skeleton-line w-full"></div>';
        html += '<div class="skeleton skeleton-line w-1-2"></div>';
        html += '<div class="skeleton skeleton-line w-1-4"></div>';
        html += '</div>';
      }
      return html;
    }

    async function loadPosts() {
      if (isLoading || !hasMore) return;
      isLoading = true;

      var indicator = document.getElementById('load-more-indicator');
      indicator.style.display = '';

      try {
        var url = API_BASE + '/api/posts?page=' + currentPage + '&limit=20&sort=' + currentSort + '&fingerprint=' + userFingerprint;
        if (currentSearch) url += '&search=' + encodeURIComponent(currentSearch);
        if (currentMood) url += '&mood=' + encodeURIComponent(currentMood);
        if (currentTag) url += '&tag=' + encodeURIComponent(currentTag);

        var result = await stableFetch(url);
        var posts = result.data || [];
        var pagination = result.pagination || {};

        var container = document.getElementById('posts-container');
        if (currentPage === 1) {
          container.innerHTML = '';
        }

        // 性能优化：一次性拼接所有 HTML 后写入 DOM，避免每次迭代触发浏览器重解析
        var postsHtml = '';
        for (var i = 0; i < posts.length; i++) {
          postsHtml += renderPost(posts[i]);
          if (posts[i].is_bookmarked) bookmarkedPosts.add(posts[i].id);
          checkLikeStatus(posts[i].id);
          loadReactions(posts[i].id);
        }
        if (postsHtml) {
          container.insertAdjacentHTML('beforeend', postsHtml);
          // 正文内容通过 textContent 注入,避免 XSS
          setPostContents(posts);
        }

        hasMore = pagination.hasNext || false;
        if (posts.length > 0) currentPage++;

        // 空状态
        var emptyState = document.getElementById('empty-state');
        var noResults = document.getElementById('no-results');
        if (currentPage <= 2 && posts.length === 0) {
          if (currentSearch || currentMood || currentTag) {
            noResults.style.display = '';
            emptyState.style.display = 'none';
          } else {
            emptyState.style.display = '';
            noResults.style.display = 'none';
          }
        } else {
          emptyState.style.display = 'none';
          noResults.style.display = 'none';
        }
      } catch (err) {
        showToast(err.message || '加载失败', 'error');
      } finally {
        isLoading = false;
        indicator.style.display = 'none';
      }
    }

    function resetAndLoadPosts() {
      currentPage = 1;
      hasMore = true;
      isLoading = false;
      document.getElementById('posts-container').innerHTML = renderSkeletons(3);
      loadPosts();
    }

    // ============ 无限滚动 ============
    function setupInfiniteScroll() {
      window.addEventListener('scroll', function() {
        // 回到顶部按钮
        var scrollBtn = document.getElementById('scroll-top-btn');
        if (window.scrollY > 400) {
          scrollBtn.classList.add('visible');
        } else {
          scrollBtn.classList.remove('visible');
        }
        // 加载更多
        if (isBookmarksView) return;
        if (window.scrollY + window.innerHeight >= document.body.offsetHeight - 300) {
          loadPosts();
        }
      });
    }

    function scrollToTop() {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ============ 点赞 ============
    async function checkLikeStatus(postId) {
      try {
        var data = await stableFetch(API_BASE + '/api/posts/' + postId + '/like?fingerprint=' + userFingerprint);
        if (data.liked) {
          likedPosts.add(postId);
          updateLikeUI(postId);
        }
      } catch (err) {}
    }

    function updateLikeUI(postId) {
      var btn = document.querySelector('#post-' + postId + ' .action-btn');
      if (!btn) return;
      if (likedPosts.has(postId)) {
        btn.classList.add('liked');
        var icon = btn.querySelector('i');
        if (icon) icon.className = 'fa fa-thumbs-up';
      } else {
        btn.classList.remove('liked');
        var icon = btn.querySelector('i');
        if (icon) icon.className = 'fa fa-thumbs-o-up';
      }
    }

    var likePending = {};
    async function toggleLike(postId) {
      if (likePending[postId]) return;
      likePending[postId] = true;

      try {
        var wasLiked = likedPosts.has(postId);
        if (wasLiked) likedPosts.delete(postId); else likedPosts.add(postId);
        updateLikeUI(postId);

        var countEl = document.getElementById('like-count-' + postId);
        if (countEl) {
          var current = parseInt(countEl.textContent) || 0;
          countEl.textContent = wasLiked ? Math.max(0, current - 1) : current + 1;
        }

        var data = await stableFetch(API_BASE + '/api/posts/' + postId + '/like', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint: userFingerprint })
        });

        if (data.liked) likedPosts.add(postId); else likedPosts.delete(postId);
        updateLikeUI(postId);
        if (countEl) countEl.textContent = data.like_count || 0;
      } catch (err) {
        if (wasLiked) likedPosts.add(postId); else likedPosts.delete(postId);
        updateLikeUI(postId);
        showToast(err.message || '操作失败', 'error');
      } finally {
        delete likePending[postId];
      }
    }

    // ============ 收藏 ============
    var bookmarkPending = {};
    async function toggleBookmark(postId) {
      if (bookmarkPending[postId]) return;
      bookmarkPending[postId] = true;

      try {
        var wasBookmarked = bookmarkedPosts.has(postId);
        if (wasBookmarked) bookmarkedPosts.delete(postId); else bookmarkedPosts.add(postId);

        var data = await stableFetch(API_BASE + '/api/posts/' + postId + '/bookmark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint: userFingerprint })
        });

        if (data.bookmarked) bookmarkedPosts.add(postId); else bookmarkedPosts.delete(postId);
        
        // 更新收藏数量显示
        var countEl = document.getElementById('bookmark-count-' + postId);
        if (countEl) countEl.textContent = data.bookmark_count || 0;
        
        // 更新按钮样式
        var btn = document.querySelector('#post-' + postId + ' .action-btn:nth-child(3)');
        if (btn) {
          if (data.bookmarked) btn.classList.add('bookmarked');
          else btn.classList.remove('bookmarked');
        }
        
        showToast(data.bookmarked ? '已收藏' : '已取消收藏', 'success');
      } catch (err) {
        if (wasBookmarked) bookmarkedPosts.add(postId); else bookmarkedPosts.delete(postId);
        showToast(err.message || '操作失败', 'error');
      } finally {
        delete bookmarkPending[postId];
      }
    }

    async function toggleBookmarksView() {
      var container = document.getElementById('bookmarks-container');
      var postsContainer = document.getElementById('posts-container');
      var btn = document.getElementById('bookmarks-btn');

      if (isBookmarksView) {
        isBookmarksView = false;
        container.style.display = 'none';
        postsContainer.style.display = '';
        btn.classList.remove('active');
        resetAndLoadPosts();
        return;
      }

      isBookmarksView = true;
      btn.classList.add('active');
      postsContainer.style.display = 'none';
      document.getElementById('empty-state').style.display = 'none';
      document.getElementById('no-results').style.display = 'none';
      container.style.display = '';
      container.innerHTML = '<div class="text-center py-8"><i class="fa fa-spinner fa-spin" style="font-size: 1.5rem; color: var(--text-muted);"></i></div>';

      try {
        var result = await stableFetch(API_BASE + '/api/bookmarks?fingerprint=' + userFingerprint);
        var posts = result.data || result || [];
        if (!Array.isArray(posts)) posts = [];

        if (posts.length === 0) {
          container.innerHTML = '<div class="empty-state"><i class="fa fa-bookmark"></i><p>还没有收藏的内容</p></div>';
          return;
        }

        var html = '';
        for (var i = 0; i < posts.length; i++) {
          html += renderPost(posts[i]);
          if (posts[i].is_bookmarked) bookmarkedPosts.add(posts[i].id);
          checkLikeStatus(posts[i].id);
          loadReactions(posts[i].id);
        }
        container.innerHTML = html;
        // 正文内容通过 textContent 注入,避免 XSS
        setPostContents(posts);
      } catch (err) {
        container.innerHTML = '<div class="empty-state"><i class="fa fa-exclamation-circle"></i><p>加载收藏失败</p></div>';
      }
    }

    // ============ 标签筛选 ============
    function filterByTag(tag) {
      currentTag = tag;
      currentSearch = '';
      document.getElementById('search-input').value = '';
      if (isBookmarksView) toggleBookmarksView();
      resetAndLoadPosts();
    }

    // ============ 每日一句 ============
    async function loadFeaturedPost() {
      try {
        var post = await stableFetch(API_BASE + '/api/posts/random');
        if (!post || !post.content) return;
        var section = document.getElementById('featured-section');
        var content = document.getElementById('featured-content');
        content.textContent = post.content;
        section.style.display = '';
      } catch (err) {}
    }

    // ============ 热门标签 ============
    function getSubbedTags() { try { return JSON.parse(localStorage.getItem('yf_subbed_tags') || '[]'); } catch (e) { return []; } }
    function setSubbedTags(arr) { localStorage.setItem('yf_subbed_tags', JSON.stringify(arr.slice(0, 30))); }
    function toggleSubTag(tag) {
      var subs = getSubbedTags();
      var i = subs.indexOf(tag);
      if (i >= 0) subs.splice(i, 1); else subs.push(tag);
      setSubbedTags(subs);
      loadPopularTags();
      showToast(i >= 0 ? '已取消订阅 #' + tag : '已订阅 #' + tag + '，回访可在此快速进入', 'success');
    }
    async function loadPopularTags() {
      try {
        var tags = await stableFetch(API_BASE + '/api/tags/popular');
        if (!tags || !Array.isArray(tags) || tags.length === 0) return;
        var subs = getSubbedTags();
        var section = document.getElementById('popular-tags-section');
        var list = document.getElementById('popular-tags-list');
        list.innerHTML = '';
        tags.forEach(function(t) {
          var label = (t && (t.name || t.tag)) || t; // 兼容 {name,count} / {tag} / 字符串
          if (typeof label !== 'string') return;
          var wrap = document.createElement('span');
          wrap.className = 'tag-wrap';
          var tag = document.createElement('span');
          tag.className = 'tag';
          tag.setAttribute('data-action', 'filter-tag');
          tag.setAttribute('data-tag', label);
          tag.textContent = '#' + label;
          var star = document.createElement('button');
          star.type = 'button';
          star.className = 'tag-sub' + (subs.indexOf(label) >= 0 ? ' subbed' : '');
          star.textContent = subs.indexOf(label) >= 0 ? '★' : '☆';
          star.title = '订阅 / 取消订阅该话题';
          star.setAttribute('aria-label', '订阅话题 ' + label);
          star.onclick = function(e) { e.stopPropagation(); toggleSubTag(label); };
          wrap.appendChild(tag);
          wrap.appendChild(star);
          list.appendChild(wrap);
        });
        section.style.display = '';
      } catch (err) {}
    }

    // ============ 社区情绪天气 ============
    var weatherMoodMap = {
      happy:    { emoji: '😊', label: '开心', color: '#f59e0b' },
      sad:      { emoji: '😢', label: '难过', color: '#3b82f6' },
      angry:    { emoji: '😠', label: '生气', color: '#ef4444' },
      anxious:  { emoji: '😰', label: '焦虑', color: '#8b5cf6' },
      calm:     { emoji: '😌', label: '平静', color: '#22c55e' },
      love:     { emoji: '💖', label: '恋爱', color: '#ec4899' },
      tired:    { emoji: '😫', label: '疲惫', color: '#6b7280' },
      excited:  { emoji: '🤩', label: '兴奋', color: '#f97316' },
      confused: { emoji: '🤔', label: '困惑', color: '#14b8a6' },
      grateful: { emoji: '🙏', label: '感恩', color: '#f472b6' }
    };
    var weatherPhrase = {
      happy: '今天，快乐在这里流动', sad: '有些难过，说出来会好一点', angry: '带着情绪，也没关系',
      anxious: '很多人和你一样在焦虑', calm: '此刻，大家都很平静', love: '空气里有点甜',
      tired: '累了就在这里歇一歇', excited: '有人正满怀期待', confused: '迷茫的不止你一个', grateful: '感恩的心在传递'
    };
    function weatherMoodInfo(m) {
      return weatherMoodMap[m] || { emoji: '💭', label: '其他', color: '#94a3b8' };
    }

    async function loadMoodWeather() {
      try {
        var data = await stableFetch(API_BASE + '/api/mood-weather');
        if (!data || !data.total || !Array.isArray(data.moods) || !data.moods.length) return;
        var total = data.total;
        var top = data.moods[0];
        var topInfo = weatherMoodInfo(top.mood);

        document.getElementById('mw-range').textContent =
          (data.range === '24h' ? '近 24 小时' : '近 7 日') + ' · ' + total + ' 条心声';

        var hero = document.getElementById('mw-hero');
        hero.innerHTML = '';
        var he = document.createElement('span'); he.className = 'mw-hero-emoji'; he.textContent = topInfo.emoji;
        var ht = document.createElement('div'); ht.className = 'mw-hero-text';
        var hl = document.createElement('span'); hl.className = 'mw-hero-label';
        hl.textContent = '此刻社区，' + topInfo.label + '最多';
        var hs = document.createElement('span'); hs.className = 'mw-hero-sub';
        hs.textContent = weatherPhrase[top.mood] || '每一种情绪都被看见';
        ht.appendChild(hl); ht.appendChild(hs);
        hero.appendChild(he); hero.appendChild(ht);

        var bar = document.getElementById('mw-bar'); bar.innerHTML = '';
        var legend = document.getElementById('mw-legend'); legend.innerHTML = '';
        data.moods.forEach(function(m) {
          var info = weatherMoodInfo(m.mood);
          var pct = Math.round(m.count / total * 100);
          var seg = document.createElement('div');
          seg.className = 'mw-seg';
          seg.style.width = (m.count / total * 100) + '%';
          seg.style.background = info.color;
          seg.title = info.label + ' ' + pct + '%';
          bar.appendChild(seg);

          var chip = document.createElement('span'); chip.className = 'mw-chip';
          var dot = document.createElement('span'); dot.className = 'mw-dot'; dot.style.background = info.color;
          var p = document.createElement('span'); p.className = 'mw-chip-pct'; p.textContent = pct + '%';
          chip.appendChild(dot);
          chip.appendChild(document.createTextNode(info.emoji + ' ' + info.label + ' '));
          chip.appendChild(p);
          legend.appendChild(chip);
        });

        document.getElementById('mood-weather-section').style.display = '';
      } catch (err) {}
    }

    // ============ 情绪打卡 + 成就徽章 ============
    function bumpCounter(key) {
      var n = parseInt(localStorage.getItem(key) || '0', 10) + 1;
      localStorage.setItem(key, n);
      return n;
    }
    function computeBadges(stats) {
      var posts = parseInt(localStorage.getItem('yf_post_count') || '0', 10);
      var reactions = parseInt(localStorage.getItem('yf_reaction_count') || '0', 10);
      var streak = stats ? (stats.streak || 0) : 0;
      var total = stats ? (stats.total || 0) : 0;
      return [
        { ok: total >= 1, emoji: '🌱', label: '打卡新人' },
        { ok: streak >= 3, emoji: '✨', label: '坚持3天' },
        { ok: streak >= 7, emoji: '🔥', label: '坚持一周' },
        { ok: streak >= 30, emoji: '🏆', label: '月之约' },
        { ok: posts >= 1, emoji: '🖊️', label: '首次发声' },
        { ok: posts >= 5, emoji: '📣', label: '表达者' },
        { ok: reactions >= 10, emoji: '🫶', label: '共情者' }
      ].filter(function(b) { return b.ok; });
    }
    function renderBadges(stats) {
      var box = document.getElementById('checkin-badges');
      if (!box) return;
      var earned = computeBadges(stats);
      box.innerHTML = '';
      if (!earned.length) {
        box.innerHTML = '<span class="badge-empty">打卡、发声、共情，点亮你的第一个徽章 ✨</span>';
        return;
      }
      earned.forEach(function(b) {
        var chip = document.createElement('span');
        chip.className = 'badge-chip';
        chip.textContent = b.emoji + ' ' + b.label;
        box.appendChild(chip);
      });
    }
    var checkinStats = null;
    function renderCheckin(stats) {
      checkinStats = stats;
      var numEl = document.getElementById('checkin-streak-num');
      if (numEl) numEl.textContent = stats.streak || 0;
      var btn = document.getElementById('checkin-btn');
      if (btn) {
        if (stats.checkedToday) { btn.textContent = '今日已打卡 ✓'; btn.disabled = true; btn.classList.add('checked'); }
        else { btn.textContent = '今日打卡'; btn.disabled = false; btn.classList.remove('checked'); }
      }
      var card = document.getElementById('checkin-card');
      if (card) card.style.display = '';
      renderBadges(stats);
      renderIdentity();
    }
    async function loadCheckin() {
      try {
        var stats = await stableFetch(API_BASE + '/api/checkin?fingerprint=' + encodeURIComponent(userFingerprint));
        renderCheckin(stats);
      } catch (err) {}
    }
    async function doCheckin() {
      try {
        var stats = await stableFetch(API_BASE + '/api/checkin', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint: userFingerprint })
        });
        renderCheckin(stats);
        showToast('打卡成功，连续 ' + (stats.streak || 1) + ' 天 🔥', 'success');
      } catch (err) { showToast(err.message || '打卡失败', 'error'); }
    }

    // ============ 匿名身份名片 ============
    var idAdjectives = ['温柔的', '沉默的', '勇敢的', '自由的', '孤独的', '神秘的', '清澈的', '温暖的', '璀璨的', '深邃的', '轻盈的', '淡然的', '坚定的', '朦胧的', '安静的', '浪漫的'];
    var idNouns = ['星空', '海风', '月光', '晚霞', '微光', '雨夜', '山谷', '银河', '萤火', '深海', '晨雾', '北极星', '蒲公英', '灯塔', '潮汐', '云端'];
    function myIdentity() {
      var h = hashSeed(userFingerprint);
      return {
        name: idAdjectives[h % idAdjectives.length] + idNouns[Math.floor(h / 7) % idNouns.length],
        emoji: avatarAnimals[Math.floor(h / 3) % avatarAnimals.length],
        color: avatarColors[Math.floor(h / 13) % avatarColors.length]
      };
    }
    function renderIdentity() {
      var box = document.getElementById('checkin-identity');
      if (!box) return;
      var id = myIdentity();
      box.innerHTML = '';
      var av = document.createElement('span'); av.className = 'id-avatar'; av.style.background = id.color; av.textContent = id.emoji;
      var mid = document.createElement('span'); mid.className = 'id-mid';
      var nm = document.createElement('span'); nm.className = 'id-name'; nm.textContent = id.name;
      var lb = document.createElement('span'); lb.className = 'id-label'; lb.textContent = '你的匿名身份';
      mid.appendChild(nm); mid.appendChild(lb);
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'id-change'; btn.textContent = '换新身份';
      btn.onclick = changeIdentity;
      box.appendChild(av); box.appendChild(mid); box.appendChild(btn);
    }
    function changeIdentity() {
      if (!confirm('换新身份后你将以全新匿名身份出现，并失去当前身份的打卡、徽章与通知。确定吗？')) return;
      var newFp = 'fp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
      localStorage.setItem('user_fingerprint', newFp);
      localStorage.removeItem('yf_post_count');
      localStorage.removeItem('yf_reaction_count');
      location.reload();
    }

    // ============ 节日主题 ============
    function currentFestival() {
      var d = new Date();
      var key = (d.getMonth() + 1) + '-' + d.getDate();
      var map = {
        '1-1': { emoji: '🎆', text: '新年快乐，愿新的一年被温柔以待' },
        '2-14': { emoji: '💝', text: '情人节，愿你被爱，也好好爱自己' },
        '5-20': { emoji: '💌', text: '今天，愿你勇敢说出心动' },
        '6-1': { emoji: '🎈', text: '儿童节快乐，永远保有一点童心' },
        '10-1': { emoji: '🎉', text: '国庆快乐' },
        '12-24': { emoji: '🎄', text: '平安夜，愿你被温柔包围' },
        '12-25': { emoji: '🎄', text: '圣诞快乐' },
        '12-31': { emoji: '🎆', text: '跨年夜，谢谢今年的每一种情绪' }
      };
      return map[key] || null;
    }
    function applyFestival() {
      var f = currentFestival();
      var bar = document.getElementById('festival-banner');
      if (!f || !bar) return;
      bar.textContent = f.emoji + ' ' + f.text + ' ' + f.emoji;
      bar.style.display = '';
      document.body.setAttribute('data-festival', '1');
    }

    // ============ 首访软性年龄提示 ============
    function acceptAgeGate() {
      localStorage.setItem('yf_age_ok', '1');
      var g = document.getElementById('age-gate');
      if (g) g.style.display = 'none';
      document.body.classList.remove('modal-open');
    }
    function maybeShowAgeGate() {
      if (localStorage.getItem('yf_age_ok')) return;
      var g = document.getElementById('age-gate');
      if (!g) return;
      g.style.display = 'flex';
      document.body.classList.add('modal-open');
    }

    // ============ 我的情绪报告 + 分享卡片 ============
    function openMyReport() {
      stableFetch(API_BASE + '/api/my-report?fingerprint=' + encodeURIComponent(userFingerprint))
        .then(function(r) { drawReportCard(r || {}); })
        .catch(function() { drawReportCard({}); });
      document.getElementById('report-modal-card').classList.add('active');
      document.body.classList.add('modal-open');
    }
    function closeMyReport() {
      document.getElementById('report-modal-card').classList.remove('active');
      document.body.classList.remove('modal-open');
    }
    function drawReportCard(r) {
      var canvas = document.getElementById('report-canvas');
      if (!canvas) return;
      var ctx = canvas.getContext('2d');
      var W = canvas.width, H = canvas.height;
      var g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#0f0c29'); g.addColorStop(0.5, '#16213e'); g.addColorStop(1, '#0f3460');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fb923c'; ctx.font = 'bold 46px sans-serif';
      ctx.fillText('我的情绪报告', W / 2, 92);
      ctx.fillStyle = '#94a3b8'; ctx.font = '24px sans-serif';
      ctx.fillText('Your Feeling · 匿名心声', W / 2, 132);
      var id = myIdentity();
      ctx.font = '64px sans-serif'; ctx.fillText(id.emoji, W / 2, 232);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 32px sans-serif'; ctx.fillText(id.name, W / 2, 290);
      function stat(label, val, y) {
        ctx.fillStyle = '#fdba74'; ctx.font = 'bold 66px sans-serif'; ctx.fillText(String(val), W / 2, y);
        ctx.fillStyle = '#cbd5e1'; ctx.font = '24px sans-serif'; ctx.fillText(label, W / 2, y + 38);
      }
      stat('连续打卡 (天)', r.streak || 0, 400);
      stat('累计打卡 (天)', r.checkins || 0, 524);
      stat('发布心声 (条)', r.posts || 0, 648);
      if (r.moods && r.moods.length) {
        var mi = weatherMoodInfo(r.moods[0].mood);
        ctx.fillStyle = '#e2e8f0'; ctx.font = '26px sans-serif';
        ctx.fillText('最常打卡心情：' + mi.emoji + ' ' + mi.label, W / 2, 728);
      }
      ctx.fillStyle = '#64748b'; ctx.font = '22px sans-serif';
      ctx.fillText('每一种情绪，都被看见 🌿', W / 2, 775);
    }
    function downloadReportCard() {
      var canvas = document.getElementById('report-canvas');
      if (!canvas) return;
      try {
        var a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = 'my-feeling-report.png';
        document.body.appendChild(a); a.click(); a.remove();
        showToast('已保存，去分享吧 🌿', 'success');
      } catch (e) { showToast('保存失败', 'error'); }
    }

    // 帖子分享卡片：把一条心声生成竖版图片
    function sharePostCard(postId) {
      var el = document.querySelector('#post-' + postId + ' > .post-content');
      var text = el ? (el.textContent || '') : '';
      if (!text) { showToast('内容为空', 'error'); return; }
      var canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 800;
      var ctx = canvas.getContext('2d');
      var g = ctx.createLinearGradient(0, 0, 640, 800);
      g.addColorStop(0, '#1a1a2e'); g.addColorStop(1, '#0f3460');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 640, 800);
      ctx.fillStyle = '#fb923c'; ctx.font = 'bold 30px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('❤ Your Feeling', 48, 70);
      // 正文自动换行
      ctx.fillStyle = '#f1f5f9'; ctx.font = '30px sans-serif';
      var maxW = 544, x = 48, y = 150, lineH = 46, lines = 0, line = '';
      var chars = text.replace(/\s+/g, ' ').slice(0, 360).split('');
      for (var i = 0; i < chars.length && lines < 13; i++) {
        var test = line + chars[i];
        if (ctx.measureText(test).width > maxW) {
          ctx.fillText(line, x, y); y += lineH; lines++; line = chars[i];
        } else line = test;
      }
      if (line && lines < 13) ctx.fillText(line, x, y);
      ctx.fillStyle = '#64748b'; ctx.font = '22px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('匿名分享你的心声 · yourfeeling', 320, 760);
      try {
        var a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = 'feeling-' + postId + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        showToast('已生成分享图 🌿', 'success');
      } catch (e) { showToast('生成失败', 'error'); }
    }

    // ============ 本周回顾 ============
    async function loadDigest() {
      try {
        var data = await stableFetch(API_BASE + '/api/digest');
        if (!data || !data.top || !data.top.length) return;
        var sub = document.getElementById('digest-sub');
        if (sub) sub.textContent = '· 近7天 ' + (data.weekCount || 0) + ' 条心声';
        var list = document.getElementById('digest-list');
        list.innerHTML = '';
        data.top.forEach(function(p, idx) {
          var item = document.createElement('div');
          item.className = 'digest-item';
          item.setAttribute('data-action', 'goto-post');
          item.setAttribute('data-id', p.id);
          var rank = document.createElement('span');
          rank.className = 'digest-rank';
          rank.textContent = ['🥇', '🥈', '🥉'][idx] || String(idx + 1);
          var txt = document.createElement('span');
          txt.className = 'digest-text';
          txt.textContent = String(p.content || '').replace(/\s+/g, ' ').slice(0, 36);
          var likes = document.createElement('span');
          likes.className = 'digest-likes';
          likes.textContent = '❤ ' + (p.like_count || 0);
          item.appendChild(rank); item.appendChild(txt); item.appendChild(likes);
          list.appendChild(item);
        });
        document.getElementById('digest-section').style.display = '';
      } catch (err) {}
    }

    // ============ 在线人数（陪伴感） ============
    async function loadPresence() {
      try {
        var data = await stableFetch(API_BASE + '/api/presence', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint: userFingerprint })
        });
        var el = document.getElementById('online-indicator');
        if (el && data && typeof data.online === 'number') {
          el.textContent = '🟢 ' + data.online + ' 人在线';
          el.style.display = '';
        }
      } catch (err) {}
    }

    // ============ 情绪流频道 ============
    var moodChannels = [
      { v: '', label: '全部', emoji: '🌈' },
      { v: 'happy', label: '开心', emoji: '😊' },
      { v: 'sad', label: '难过', emoji: '😢' },
      { v: 'anxious', label: '焦虑', emoji: '😰' },
      { v: 'calm', label: '平静', emoji: '😌' },
      { v: 'love', label: '恋爱', emoji: '💖' },
      { v: 'angry', label: '生气', emoji: '😠' },
      { v: 'tired', label: '疲惫', emoji: '😫' },
      { v: 'excited', label: '兴奋', emoji: '🤩' }
    ];
    function renderMoodChannels() {
      var bar = document.getElementById('mood-channels');
      if (!bar) return;
      bar.innerHTML = '';
      moodChannels.forEach(function(c) {
        var chip = document.createElement('button');
        chip.className = 'mood-channel' + (currentMood === c.v ? ' active' : '');
        chip.textContent = c.emoji + ' ' + c.label;
        chip.setAttribute('data-action', 'mood-channel');
        chip.setAttribute('data-mood', c.v);
        bar.appendChild(chip);
      });
    }
    function selectMoodChannel(mood) {
      currentMood = mood;
      var sel = document.getElementById('mood-filter');
      if (sel) sel.value = mood;
      renderMoodChannels();
      resetAndLoadPosts();
    }

    // ============ 互动通知 ============
    var notifItems = [];
    var notifTypeText = { comment: '评论了你的心声', like: '点赞了你的心声', reaction: '回应了你的心声' };
    async function loadNotifications() {
      try {
        var data = await stableFetch(API_BASE + '/api/notifications?fingerprint=' + encodeURIComponent(userFingerprint));
        notifItems = data.items || [];
        var badge = document.getElementById('notif-badge');
        if (badge) {
          if (data.unread > 0) { badge.textContent = data.unread > 99 ? '99+' : String(data.unread); badge.style.display = ''; }
          else badge.style.display = 'none';
        }
      } catch (err) {}
    }
    function renderNotifications() {
      var list = document.getElementById('notif-list');
      if (!list) return;
      list.innerHTML = '';
      if (!notifItems.length) { list.innerHTML = '<p class="notif-empty">还没有互动通知，发条心声等回应吧 🌱</p>'; return; }
      notifItems.forEach(function(n) {
        var av = seedToAvatar(n.actor_seed);
        var row = document.createElement('div');
        row.className = 'notif-item' + (n.is_read ? '' : ' unread');
        var avatar = document.createElement('span');
        avatar.className = 'notif-avatar';
        avatar.style.background = av.color;
        avatar.textContent = av.emoji;
        var body = document.createElement('div');
        body.className = 'notif-body';
        var line = document.createElement('div');
        line.className = 'notif-line';
        line.textContent = '有人' + (notifTypeText[n.type] || '与你互动');
        body.appendChild(line);
        if (n.snippet) {
          var snip = document.createElement('div');
          snip.className = 'notif-snippet';
          snip.textContent = n.snippet;
          body.appendChild(snip);
        }
        var time = document.createElement('div');
        time.className = 'notif-time';
        time.textContent = formatTime(n.created_at);
        body.appendChild(time);
        row.appendChild(avatar);
        row.appendChild(body);
        if (n.post_id) {
          row.style.cursor = 'pointer';
          row.onclick = function() { closeNotifications(); gotoPost(n.post_id); };
        }
        list.appendChild(row);
      });
    }
    function openNotifications() {
      renderNotifications();
      document.getElementById('notif-modal').classList.add('active');
      document.body.classList.add('modal-open');
      stableFetch(API_BASE + '/api/notifications/read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: userFingerprint })
      }).then(function() {
        var b = document.getElementById('notif-badge'); if (b) b.style.display = 'none';
      }).catch(function() {});
    }
    function closeNotifications() {
      document.getElementById('notif-modal').classList.remove('active');
      document.body.classList.remove('modal-open');
    }

    // ============ 管理面板 ============
    var adminCurrentPage = 1;
    var adminPageSize = 10;
    var adminSelectedIds = new Set();
    var adminSearchTimer = null;
    var adminAllPostsCache = []; // 当前页帖子缓存

    var moodEmojiMap = {
      'happy': '😊 开心', 'sad': '😢 难过', 'angry': '😠 生气',
      'anxious': '😰 焦虑', 'calm': '😌 平静', 'confused': '🤔 困惑',
      'grateful': '💖 感恩', 'tired': '😫 疲惫', 'excited': '🤩 兴奋'
    };

    function openAdminModal() {
      document.getElementById('admin-modal').classList.add('active');
      document.body.classList.add('modal-open');
      if (isAdminMode) {
        loadAdminDashboard();
      }
    }

    function closeAdminModal() {
      document.getElementById('admin-modal').classList.remove('active');
      document.body.classList.remove('modal-open');
    }

    async function adminLogin() {
      var pwd = document.getElementById('admin-password-input').value.trim();
      if (!pwd) {
        showToast('请输入密码', 'error');
        return;
      }
      try {
        await stableFetch(API_BASE + '/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        });
        adminPassword = pwd;
        isAdminMode = true;
        // 密码不写入 localStorage，仅存于内存 —— 防止 XSS 窃取
        showToast('登录成功', 'success');
        loadAdminDashboard();
      } catch (err) {
        showToast(err.message || '登录失败', 'error');
      }
    }

    function adminLogout() {
      isAdminMode = false;
      adminPassword = '';
      adminSelectedIds.clear();
      document.getElementById('admin-login').style.display = '';
      document.getElementById('admin-dashboard').style.display = 'none';
      resetAndLoadPosts();
    }

    async function loadAdminDashboard() {
      document.getElementById('admin-login').style.display = 'none';
      document.getElementById('admin-dashboard').style.display = '';
      adminCurrentPage = 1;
      adminSelectedIds.clear();

      try {
        var data = await stableFetch(API_BASE + '/api/admin/dashboard', {
          headers: { 'x-admin-password': adminPassword }
        });
        var statsEl = document.getElementById('admin-stats');
        statsEl.innerHTML =
          '<div class="admin-stat"><div class="stat-value">' + (data.total_posts || 0) + '</div><div class="stat-label">帖子总数</div><div class="stat-sub">今日 +' + (data.today_posts || 0) + '</div></div>' +
          '<div class="admin-stat"><div class="stat-value">' + (data.total_comments || 0) + '</div><div class="stat-label">评论总数</div><div class="stat-sub">今日 +' + (data.today_comments || 0) + '</div></div>' +
          '<div class="admin-stat"><div class="stat-value">' + (data.active_posts || 0) + '</div><div class="stat-label">活跃帖子</div></div>' +
          '<div class="admin-stat"><div class="stat-value">' + (data.hidden_posts || 0) + '</div><div class="stat-label">已隐藏</div></div>';
      } catch (err) {
        // 统计加载失败不阻塞
      }

      loadAdminPostsList();
    }

    function adminDebounceSearch() {
      clearTimeout(adminSearchTimer);
      adminSearchTimer = setTimeout(function() {
        adminCurrentPage = 1;
        loadAdminPostsList();
      }, 400);
    }

    async function loadAdminPostsList() {
      var listEl = document.getElementById('admin-posts-list');
      var paginationEl = document.getElementById('admin-pagination');
      if (!listEl) return;

      listEl.innerHTML = '<p class="text-center text-muted" style="padding: 40px 0;"><i class="fa fa-spinner fa-spin"></i> 加载中...</p>';
      if (paginationEl) paginationEl.style.display = 'none';

      var filter = document.getElementById('admin-filter-select').value;
      var search = (document.getElementById('admin-search-input').value || '').trim();

      try {
        var url = API_BASE + '/api/admin/posts?page=' + adminCurrentPage + '&limit=' + adminPageSize + '&filter=' + filter;
        if (search) url += '&search=' + encodeURIComponent(search);

        var result = await stableFetch(url, {
          headers: { 'x-admin-password': adminPassword }
        });

        // 兼容两种后端返回格式
        var posts, pagination;
        if (result && result.data) {
          posts = result.data;
          pagination = result.pagination;
        } else {
          posts = Array.isArray(result) ? result : [];
          pagination = null;
        }

        adminAllPostsCache = posts;

        if (!posts || posts.length === 0) {
          listEl.innerHTML = '<p class="text-center text-muted" style="padding: 40px 0;"><i class="fa fa-inbox" style="font-size: 1.5rem; display: block; margin-bottom: 8px;"></i>暂无帖子</p>';
          return;
        }

        var html = '';
        for (var i = 0; i < posts.length; i++) {
          var p = posts[i];
          var isSelected = adminSelectedIds.has(p.id);
          var isHidden = p.is_hidden === 1;
          var isExpired = p.expires_at && new Date(p.expires_at) < new Date();
          var moodLabel = moodEmojiMap[p.mood] || '';
          var timeStr = p.created_at ? formatAdminTime(p.created_at) : '';

          html += '<div class="admin-post-card' + (isSelected ? ' selected' : '') + (isHidden ? ' hidden-post' : '') + '" id="admin-card-' + p.id + '">';
          // 复选框
          html += '<div class="admin-post-check"><input type="checkbox"' + (isSelected ? ' checked' : '') + ' data-action="admin-toggle-select" data-id="' + p.id + '"></div>';
          // 内容区
          html += '<div class="admin-post-info">';
          html += '<div class="admin-post-header">';
          html += '<span class="admin-post-id">#' + p.id + '</span>';
          if (moodLabel) html += '<span class="admin-post-mood">' + moodLabel + '</span>';
          if (isHidden) html += '<span class="admin-post-badge hidden-badge">已隐藏</span>';
          if (isExpired && !isHidden) html += '<span class="admin-post-badge expired-badge">已过期</span>';
          html += '<span class="admin-post-time">' + timeStr + '</span>';
          html += '</div>';
          // 正文以 textContent 方式注入,避免 XSS
          html += '<div class="admin-post-content" id="admin-content-' + p.id + '" data-action="admin-expand" data-id="' + p.id + '"></div>';
          html += '<div class="admin-post-meta">';
          html += '<span><i class="fa fa-heart"></i> ' + (p.like_count || 0) + '</span>';
          html += '<span><i class="fa fa-comment"></i> ' + (p.comment_count || 0) + '</span>';
          html += '<span><i class="fa fa-eye"></i> ' + (p.view_count || 0) + '</span>';
          if (p.bookmark_count) html += '<span><i class="fa fa-bookmark"></i> ' + p.bookmark_count + '</span>';
          if (p.pending_reports > 0) html += '<span style="color:#f87171;"><i class="fa fa-flag"></i> ' + p.pending_reports + '</span>';
          html += '</div>';
          html += '</div>';
          // 操作按钮
          html += '<div class="admin-post-actions">';
          if (isHidden) {
            html += '<button class="admin-action-btn" data-action="admin-toggle-hide" data-id="' + p.id + '"><i class="fa fa-eye"></i> 显示</button>';
          } else {
            html += '<button class="admin-action-btn" data-action="admin-toggle-hide" data-id="' + p.id + '"><i class="fa fa-eye-slash"></i> 隐藏</button>';
          }
          html += '<button class="admin-action-btn danger" data-action="admin-delete-post" data-id="' + p.id + '"><i class="fa fa-trash"></i> 删除</button>';
          html += '</div>';
          html += '</div>';
        }
        listEl.innerHTML = html;
        // 正文以 textContent 注入,避免 HTML 拼接注入
        for (var k = 0; k < posts.length; k++) {
          var contentEl = document.getElementById('admin-content-' + posts[k].id);
          if (contentEl) contentEl.textContent = posts[k].content || '';
        }

        // 分页
        if (pagination && pagination.totalPages > 1) {
          renderAdminPagination(pagination);
        } else {
          if (paginationEl) paginationEl.style.display = 'none';
        }

        // 更新批量操作按钮可见性
        updateAdminBatchUI();
      } catch (err) {
        // 使用 textContent 代替 innerHTML，防止后端错误信息中的特殊字符被解析为 HTML
        var errP = document.createElement('p');
        errP.className = 'text-danger text-center';
        errP.style.padding = '40px 0';
        errP.textContent = '加载失败: ' + (err.message || '');
        listEl.innerHTML = '';
        listEl.appendChild(errP);
      }
    }

    function renderAdminPagination(pg) {
      var el = document.getElementById('admin-pagination');
      if (!el) return;
      el.style.display = 'flex';

      var html = '';
      html += '<button class="admin-page-btn"' + (!pg.hasPrev ? ' disabled' : '') + ' data-action="admin-go-page" data-page="' + (pg.page - 1) + '"><i class="fa fa-chevron-left"></i></button>';

      var start = Math.max(1, pg.page - 2);
      var end = Math.min(pg.totalPages, pg.page + 2);
      if (start > 1) {
        html += '<button class="admin-page-btn" data-action="admin-go-page" data-page="1">1</button>';
        if (start > 2) html += '<span class="admin-page-info">...</span>';
      }
      for (var i = start; i <= end; i++) {
        html += '<button class="admin-page-btn' + (i === pg.page ? ' active' : '') + '" data-action="admin-go-page" data-page="' + i + '">' + i + '</button>';
      }
      if (end < pg.totalPages) {
        if (end < pg.totalPages - 1) html += '<span class="admin-page-info">...</span>';
        html += '<button class="admin-page-btn" data-action="admin-go-page" data-page="' + pg.totalPages + '">' + pg.totalPages + '</button>';
      }

      html += '<button class="admin-page-btn"' + (!pg.hasNext ? ' disabled' : '') + ' data-action="admin-go-page" data-page="' + (pg.page + 1) + '"><i class="fa fa-chevron-right"></i></button>';
      html += '<span class="admin-page-info">共 ' + pg.total + ' 条</span>';
      el.innerHTML = html;
    }

    function adminGoPage(page) {
      adminCurrentPage = page;
      loadAdminPostsList();
      // 滚动到列表顶部
      var listEl = document.getElementById('admin-posts-list');
      if (listEl) listEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function adminToggleExpand(postId) {
      var el = document.getElementById('admin-content-' + postId);
      if (el) el.classList.toggle('expanded');
    }

    function escapeHtml(text) {
      if (!text) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'); // 新增：单引号转义，防止 onclick='...' 中的注入
    }

    function formatAdminTime(dateStr) {
      try {
        var d = parseDBDate(dateStr);
        var now = new Date();
        var diff = now - d;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
        if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
        if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      } catch (e) {
        return dateStr;
      }
    }

    // ---- 选择 & 批量操作 ----
    function adminToggleSelect(postId) {
      if (adminSelectedIds.has(postId)) {
        adminSelectedIds.delete(postId);
      } else {
        adminSelectedIds.add(postId);
      }
      updateAdminBatchUI();
      // 更新卡片样式
      var card = document.getElementById('admin-card-' + postId);
      if (card) card.classList.toggle('selected', adminSelectedIds.has(postId));
      // 更新全选
      var selectAllCb = document.getElementById('admin-select-all');
      if (selectAllCb) selectAllCb.checked = adminAllPostsCache.length > 0 && adminAllPostsCache.every(function(p) { return adminSelectedIds.has(p.id); });
    }

    function adminToggleSelectAll() {
      var checked = document.getElementById('admin-select-all').checked;
      for (var i = 0; i < adminAllPostsCache.length; i++) {
        var p = adminAllPostsCache[i];
        if (checked) {
          adminSelectedIds.add(p.id);
        } else {
          adminSelectedIds.delete(p.id);
        }
        var card = document.getElementById('admin-card-' + p.id);
        if (card) card.classList.toggle('selected', checked);
        // 更新复选框
        var cbs = card ? card.querySelectorAll('input[type="checkbox"]') : [];
        for (var j = 0; j < cbs.length; j++) cbs[j].checked = checked;
      }
      updateAdminBatchUI();
    }

    function updateAdminBatchUI() {
      var count = adminSelectedIds.size;
      var hasPosts = adminAllPostsCache.length > 0;
      document.getElementById('admin-select-all-wrap').style.display = hasPosts ? '' : 'none';
      document.getElementById('admin-batch-delete-btn').style.display = count > 0 ? '' : 'none';
      document.getElementById('admin-batch-hide-btn').style.display = count > 0 ? '' : 'none';
    }

    async function adminBatchDelete() {
      var ids = Array.from(adminSelectedIds);
      if (ids.length === 0) return;
      if (!confirm('确定要删除选中的 ' + ids.length + ' 条帖子吗？此操作不可撤销。')) return;
      try {
        for (var i = 0; i < ids.length; i++) {
          await stableFetch(API_BASE + '/api/admin/posts/' + ids[i], {
            method: 'DELETE',
            headers: { 'x-admin-password': adminPassword }
          });
        }
        showToast('已删除 ' + ids.length + ' 条帖子', 'success');
        adminSelectedIds.clear();
        loadAdminDashboard();
        resetAndLoadPosts();
      } catch (err) {
        showToast('批量删除失败: ' + (err.message || ''), 'error');
      }
    }

    async function adminBatchToggleHide() {
      var ids = Array.from(adminSelectedIds);
      if (ids.length === 0) return;
      try {
        for (var i = 0; i < ids.length; i++) {
          await stableFetch(API_BASE + '/api/admin/posts/' + ids[i] + '/toggle-hide', {
            method: 'PUT',
            headers: { 'x-admin-password': adminPassword, 'Content-Type': 'application/json' }
          });
        }
        showToast('已切换 ' + ids.length + ' 条帖子的显示状态', 'success');
        adminSelectedIds.clear();
        loadAdminPostsList();
        resetAndLoadPosts();
      } catch (err) {
        showToast('操作失败: ' + (err.message || ''), 'error');
      }
    }

    // ---- 单条操作 ----
    async function adminDeletePost(postId) {
      if (!confirm('确定要删除这条帖子吗？')) return;
      try {
        await stableFetch(API_BASE + '/api/admin/posts/' + postId, {
          method: 'DELETE',
          headers: { 'x-admin-password': adminPassword }
        });
        showToast('帖子已删除', 'success');
        adminSelectedIds.delete(postId);
        loadAdminPostsList();
        loadAdminDashboard();
        resetAndLoadPosts();
      } catch (err) {
        showToast('删除失败: ' + (err.message || ''), 'error');
      }
    }

    async function adminToggleHide(postId) {
      try {
        await stableFetch(API_BASE + '/api/admin/posts/' + postId + '/toggle-hide', {
          method: 'PUT',
          headers: { 'x-admin-password': adminPassword, 'Content-Type': 'application/json' }
        });
        showToast('状态已更新', 'success');
        loadAdminPostsList();
        resetAndLoadPosts();
      } catch (err) {
        showToast('操作失败: ' + (err.message || ''), 'error');
      }
    }

    // ============ 评论相关 ============
    async function loadComments(postId) {
      if (commentLoading[postId]) return;
      commentLoading[postId] = true;

      var list = document.getElementById('comments-list-' + postId);
      var sort = document.getElementById('comment-sort-' + postId);
      var sortValue = sort ? sort.value : 'latest';

      if (list) list.innerHTML = '<p class="text-sm text-muted text-center py-4"><i class="fa fa-spinner fa-spin"></i> 加载中...</p>';

      try {
        var comments = await stableFetch(API_BASE + '/api/posts/' + postId + '/comments?sort=' + sortValue);
        if (!list) return;
        if (!comments || comments.length === 0) {
          list.innerHTML = '<p class="text-sm text-muted text-center py-4">暂无评论</p>';
          return;
        }

        var expandBtn = document.getElementById('comments-expand-' + postId);
        var displayComments = comments;
        var showExpand = comments.length > 5;

        if (showExpand) {
          expandBtn.style.display = '';
          list.setAttribute('data-expanded', 'false');
          list.setAttribute('data-all-comments', JSON.stringify(comments));
          displayComments = comments.slice(0, 5);
        } else {
          if (expandBtn) expandBtn.style.display = 'none';
        }

        renderCommentsList(postId, displayComments, comments);
      } catch (err) {
        if (list) list.innerHTML = '<p class="text-sm text-danger text-center py-4">加载失败</p>';
      } finally {
        delete commentLoading[postId];
      }
    }

    function renderCommentsList(postId, commentsToRender, allComments) {
      var list = document.getElementById('comments-list-' + postId);
      if (!list) return;

      var commentMap = {};
      var rootComments = [];

      for (var i = 0; i < allComments.length; i++) {
        var c = allComments[i];
        c.replies = [];
        commentMap[c.id] = c;
      }

      for (var i = 0; i < allComments.length; i++) {
        var c = allComments[i];
        if (c.parent_id && commentMap[c.parent_id]) {
          commentMap[c.parent_id].replies.push(c);
        } else {
          rootComments.push(c);
        }
      }

      var html = '';
      for (var i = 0; i < commentsToRender.length; i++) {
        html += renderCommentItem(commentsToRender[i], postId, 0);
      }
      list.innerHTML = html;
      // 用户可见文本(昵称、内容)通过 textContent 注入,避免 XSS
      setCommentContents(allComments, postId);

      for (var i = 0; i < commentsToRender.length; i++) {
        checkCommentLikeStatus(commentsToRender[i].id);
      }
    }

    // 帖内匿名动物头像：由后端 author_seed 确定性映射，同帖同人一致、跨帖不可追踪
    var avatarAnimals = ['🐱','🐶','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🦉','🦄','🐙','🐢','🐳','🐬','🦋','🐝','🐞','🦔','🦅','🦌','🐺','🐹','🦝'];
    var avatarColors = ['#f59e0b','#3b82f6','#ef4444','#8b5cf6','#22c55e','#ec4899','#f97316','#14b8a6','#a78bfa','#fb923c','#34d399','#60a5fa'];
    function hashSeed(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return Math.abs(h); }
    function seedToAvatar(seed) {
      if (!seed) return { emoji: '👤', color: '#64748b' };
      var s = String(seed);
      var a = parseInt(s.substring(0, 6), 16); if (isNaN(a)) a = hashSeed(s);
      var b = parseInt(s.substring(6, 12), 16); if (isNaN(b)) b = (a >> 2) + 7;
      return { emoji: avatarAnimals[a % avatarAnimals.length], color: avatarColors[b % avatarColors.length] };
    }

    function renderCommentItem(comment, postId, depth) {
      var indentClass = '';
      if (depth === 1) indentClass = 'comment-reply';
      if (depth === 2) indentClass = 'comment-reply-2';
      if (depth > 2) indentClass = 'comment-reply-2';

      var isLiked = likedComments.has(comment.id);

      var html = '<div class="comment-item ' + indentClass + ' flex items-start gap-3 py-2" id="comment-' + comment.id + '">';
      var av = seedToAvatar(comment.author_seed);
      html += '<div class="avatar avatar-sm" style="background:' + av.color + ';font-size:13px" title="该帖内的匿名身份">' + av.emoji + '</div>';
      html += '<div class="flex-1 rounded-xl p-3" style="background: var(--comment-item-bg);">';
      html += '<div class="flex items-center gap-2 mb-1">';
      html += '<span class="text-sm font-medium comment-nickname" style="color: var(--text-gray-300);"></span>';
      html += '<span class="text-xs text-muted">' + formatTime(comment.created_at) + '</span>';
      html += '</div>';
      if (comment.parent_id && comment.parent_nickname) {
        html += '<div class="text-xs mb-1 comment-parent-nickname" style="color: var(--text-muted);"></div>';
      }
      html += '<p class="text-sm comment-content" style="color: var(--text-gray-200);line-height:1.6"></p>';
      html += '<div class="flex items-center gap-3 mt-2">';
      html += '<button id="comment-like-btn-' + comment.id + '" data-action="toggle-comment-like" data-id="' + comment.id + '" class="text-xs flex items-center gap-1 transition-colors" style="color: ' + (isLiked ? '#f472b6' : 'var(--text-muted)') + ';">';
      html += '<i class="fa fa-thumbs' + (isLiked ? '' : '-o') + '-up"></i><span id="comment-like-count-' + comment.id + '">' + (comment.like_count || 0) + '</span></button>';
      if (depth < 2) {
        html += '<button data-action="start-reply" data-post-id="' + postId + '" data-comment-id="' + comment.id + '" data-nickname="' + escapeHtml(comment.nickname || '匿名用户') + '" class="text-xs" style="color: var(--text-muted);">回复</button>';
      }
      if (isAdminMode) {
        html += '<button data-action="delete-comment" aria-label="删除评论" data-comment-id="' + comment.id + '" data-post-id="' + postId + '" class="text-xs text-danger hover:text-red-300"><i class="fa fa-trash"></i></button>';
      }
      html += '</div></div></div>';

      if (comment.replies && comment.replies.length > 0) {
        for (var i = 0; i < comment.replies.length; i++) {
          html += renderCommentItem(comment.replies[i], postId, depth + 1);
        }
      }

      return html;
    }

    // 用 textContent 把评论数据写入刚刚渲染的 DOM,避免 HTML 拼接注入
    function setCommentContents(comments, postId) {
      if (!comments || !comments.length) return;
      function apply(c) {
        var el = document.getElementById('comment-' + c.id);
        if (!el) return;
        var nickEl = el.querySelector('.comment-nickname');
        if (nickEl) nickEl.textContent = c.nickname || '匿名用户';
        var parentNickEl = el.querySelector('.comment-parent-nickname');
        if (parentNickEl) parentNickEl.textContent = '回复 @' + (c.parent_nickname || '');
        var contentEl = el.querySelector('.comment-content');
        if (contentEl) contentEl.textContent = c.content || '';
        if (c.replies && c.replies.length > 0) {
          for (var k = 0; k < c.replies.length; k++) apply(c.replies[k]);
        }
      }
      for (var i = 0; i < comments.length; i++) apply(comments[i]);
    }

    function toggleCommentsExpand(postId) {
      var list = document.getElementById('comments-list-' + postId);
      var expandBtn = document.getElementById('comments-expand-' + postId);
      var isExpanded = list.getAttribute('data-expanded') === 'true';
      var allComments = JSON.parse(list.getAttribute('data-all-comments') || '[]');

      if (isExpanded) {
        list.setAttribute('data-expanded', 'false');
        renderCommentsList(postId, allComments.slice(0, 5), allComments);
        if (expandBtn) expandBtn.innerHTML = '<span class="comments-expand-btn" data-action="comments-expand" data-id="' + postId + '"><i class="fa fa-chevron-down mr-1"></i>展开更多评论</span>';
      } else {
        list.setAttribute('data-expanded', 'true');
        renderCommentsList(postId, allComments, allComments);
        if (expandBtn) expandBtn.innerHTML = '<span class="comments-expand-btn" data-action="comments-expand" data-id="' + postId + '"><i class="fa fa-chevron-up mr-1"></i>收起评论</span>';
      }
    }

    function changeCommentSort(postId) {
      loadComments(postId);
    }

    function toggleComments(postId) {
      var div = document.getElementById('comments-' + postId);
      if (!div) return;
      if (div.style.display === 'none') {
        div.style.display = '';
        loadComments(postId);
        loadSimilar(postId);
      } else {
        div.style.display = 'none';
      }
    }

    // 相似心声推荐：展开评论时加载，只读预览，点击滚动到对应帖子（若在当前列表）
    var similarLoaded = {};
    async function loadSimilar(postId) {
      if (similarLoaded[postId]) return;
      similarLoaded[postId] = true;
      var box = document.getElementById('similar-' + postId);
      if (!box) return;
      try {
        var list = await stableFetch(API_BASE + '/api/posts/' + postId + '/similar');
        if (!list || !list.length) return;
        box.innerHTML = '';
        var title = document.createElement('div');
        title.className = 'similar-title';
        title.innerHTML = '<i class="fa fa-heart" aria-hidden="true"></i> 你可能也有共鸣';
        box.appendChild(title);
        list.forEach(function(p) {
          var item = document.createElement('div');
          item.className = 'similar-item';
          var em = (p.mood && moodMap[p.mood]) ? (moodMap[p.mood].label + ' · ') : '';
          var snippet = String(p.content || '').replace(/\s+/g, ' ').slice(0, 40);
          item.textContent = em + snippet + (String(p.content || '').length > 40 ? '…' : '');
          item.setAttribute('data-action', 'goto-post');
          item.setAttribute('data-id', p.id);
          box.appendChild(item);
        });
      } catch (err) { similarLoaded[postId] = false; }
    }
    function revealCw(id) {
      var el = document.querySelector('#post-' + id + ' > .post-content');
      if (el) el.classList.remove('cw-blurred');
      var btn = document.querySelector('#post-' + id + ' .cw-reveal');
      if (btn) btn.style.display = 'none';
    }
    function gotoPost(id) {
      var el = document.getElementById('post-' + id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('post-flash');
        setTimeout(function() { el.classList.remove('post-flash'); }, 1500);
      } else {
        showToast('这条心声不在当前列表里', 'info');
      }
    }

    async function generateRandomNickname(postId) {
      try {
        var data = await stableFetch(API_BASE + '/api/nickname');
        var input = document.getElementById('comment-nickname-' + postId);
        if (input && data.nickname) {
          input.value = data.nickname;
          commentNickname = data.nickname;
          localStorage.setItem('comment_nickname', data.nickname);
        }
      } catch (err) {
        showToast('获取随机昵称失败', 'error');
      }
    }

    function startReply(postId, commentId, nickname) {
      replyingTo = { postId: postId, commentId: commentId };
      var replyInfo = document.getElementById('comment-reply-info-' + postId);
      var cancelBtn = document.getElementById('cancel-reply-btn-' + postId);
      var input = document.getElementById('comment-input-' + postId);

      if (replyInfo) {
        replyInfo.innerHTML = '回复 @' + escapeHtml(nickname);
        replyInfo.style.display = '';
      }
      if (cancelBtn) cancelBtn.style.display = '';
      if (input) {
        input.placeholder = '回复 @' + escapeHtml(nickname) + '...';
        input.focus();
      }
    }

    function cancelReply(postId) {
      replyingTo = null;
      var replyInfo = document.getElementById('comment-reply-info-' + postId);
      var cancelBtn = document.getElementById('cancel-reply-btn-' + postId);
      var input = document.getElementById('comment-input-' + postId);

      if (replyInfo) replyInfo.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (input) {
        input.placeholder = '写下你的评论...';
        input.value = '';
      }
    }

    async function submitComment(event, postId) {
      event.preventDefault();
      if (commentSubmitting[postId]) return;

      var input = document.getElementById('comment-input-' + postId);
      var nicknameInput = document.getElementById('comment-nickname-' + postId);
      var content = input.value.trim();
      var nickname = nicknameInput.value.trim();

      if (!content) return;

      if (nickname) {
        commentNickname = nickname;
        localStorage.setItem('comment_nickname', nickname);
      }

      commentSubmitting[postId] = true;
      var btn = document.getElementById('comment-submit-btn-' + postId);
      var originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';

      try {
        var body = { content: content, fingerprint: userFingerprint };
        if (nickname) body.nickname = nickname;
        if (replyingTo && replyingTo.postId === postId) body.parent_id = replyingTo.commentId;

        await stableFetch(API_BASE + '/api/posts/' + postId + '/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        input.value = '';
        cancelReply(postId);
        loadComments(postId);
        showToast('评论成功', 'success');
      } catch (err) {
        showToast(err.message || '评论失败', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
        delete commentSubmitting[postId];
      }
    }

    async function checkCommentLikeStatus(commentId) {
      try {
        var data = await stableFetch(API_BASE + '/api/comments/' + commentId + '/like?fingerprint=' + userFingerprint);
        if (data.liked) {
          likedComments.add(commentId);
          updateCommentLikeUI(commentId);
        }
      } catch (err) {}
    }

    function updateCommentLikeUI(commentId) {
      var btn = document.getElementById('comment-like-btn-' + commentId);
      if (!btn) return;
      if (likedComments.has(commentId)) {
        btn.style.color = '#f472b6';
        var icon = btn.querySelector('i');
        if (icon) icon.className = 'fa fa-thumbs-up';
      } else {
        btn.style.color = 'var(--text-muted)';
        var icon = btn.querySelector('i');
        if (icon) icon.className = 'fa fa-thumbs-o-up';
      }
    }

    var commentLikePending = {};
    async function toggleCommentLike(commentId) {
      if (commentLikePending[commentId]) return;
      commentLikePending[commentId] = true;

      try {
        var wasLiked = likedComments.has(commentId);
        if (wasLiked) likedComments.delete(commentId); else likedComments.add(commentId);
        updateCommentLikeUI(commentId);

        var countEl = document.getElementById('comment-like-count-' + commentId);
        if (countEl) {
          var current = parseInt(countEl.textContent) || 0;
          countEl.textContent = wasLiked ? Math.max(0, current - 1) : current + 1;
        }

        var data = await stableFetch(API_BASE + '/api/comments/' + commentId + '/like', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint: userFingerprint })
        });

        if (data.liked) likedComments.add(commentId); else likedComments.delete(commentId);
        updateCommentLikeUI(commentId);
        if (countEl) countEl.textContent = data.like_count || 0;
      } catch (err) {
        if (wasLiked) likedComments.add(commentId); else likedComments.delete(commentId);
        updateCommentLikeUI(commentId);
        showToast(err.message || '操作失败', 'error');
      } finally {
        delete commentLikePending[commentId];
      }
    }

    var deleteSubmitting = {};
    async function deletePost(postId) {
      if (deleteSubmitting[postId]) return;
      if (!confirm('确定要删除这条帖子吗？')) return;
      deleteSubmitting[postId] = true;
      try {
        await stableFetch(API_BASE + '/api/posts/' + postId, {
          method: 'DELETE',
          headers: { 'x-admin-password': adminPassword }
        });
        showToast('帖子已删除', 'success');
        resetAndLoadPosts();
      } catch (err) {
        showToast(err.message || '删除失败', 'error');
      } finally {
        delete deleteSubmitting[postId];
      }
    }

    async function deleteComment(commentId, postId) {
      if (!confirm('确定要删除这条评论吗？')) return;
      try {
        await stableFetch(API_BASE + '/api/comments/' + commentId, {
          method: 'DELETE',
          headers: { 'x-admin-password': adminPassword }
        });
        loadComments(postId);
        showToast('评论已删除', 'success');
      } catch (err) {
        showToast(err.message || '删除失败', 'error');
      }
    }

    // ============ 举报相关 ============
    async function loadReportReasons() {
      try {
        var reasons = await stableFetch(API_BASE + '/api/reports/reasons');
        var container = document.getElementById('report-reasons');
        container.innerHTML = reasons.map(function(r) {
          return '<label class="flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors" style="color: var(--text-gray-200);" onmouseover="this.style.background=\'var(--hover-bg-5)\'" onmouseout="this.style.background=\'transparent\'">' +
            '<input type="radio" name="report-reason" value="' + r.value + '" class="accent-pink-500">' +
            '<span>' + r.label + '</span></label>';
        }).join('');
      } catch (err) {
        document.getElementById('report-reasons').innerHTML = '<p class="text-danger text-sm">加载失败</p>';
      }
    }

    function openReportModal(postId) {
      reportPostId = postId;
      loadReportReasons();
      document.getElementById('report-modal').classList.add('active');
      document.body.classList.add('modal-open');
    }

    function closeReportModal() {
      document.getElementById('report-modal').classList.remove('active');
      document.body.classList.remove('modal-open');
      reportPostId = null;
    }

    async function submitReport() {
      var selected = document.querySelector('input[name="report-reason"]:checked');
      if (!selected) {
        showToast('请选择举报原因', 'error');
        return;
      }

      var btn = document.getElementById('report-submit-btn');
      btn.disabled = true;
      btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i>';

      try {
        await stableFetch(API_BASE + '/api/posts/' + reportPostId + '/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: selected.value, fingerprint: userFingerprint })
        });
        showToast('举报成功，感谢反馈', 'success');
        closeReportModal();
      } catch (err) {
        showToast(err.message || '举报失败', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '提交举报';
      }
    }

    // ============ 模态框 ============
    // 危机关怀浮层：发布命中危机关键词时温和递上求助资源（不拦截发布、不公开标注）
    function showCrisisSupport() {
      var modal = document.getElementById('crisis-modal');
      if (!modal) return;
      modal.classList.add('active');
      document.body.classList.add('modal-open');
    }
    function closeCrisisSupport() {
      var modal = document.getElementById('crisis-modal');
      if (!modal) return;
      modal.classList.remove('active');
      document.body.classList.remove('modal-open');
    }

    function openShareModal() {
      document.getElementById('share-modal').classList.add('active');
      document.body.classList.add('modal-open');
      // 恢复未发送的草稿
      var ta = document.getElementById('post-content');
      var draft = localStorage.getItem('yf_draft');
      if (ta && draft && !ta.value) { ta.value = draft; updateCharCount(); }
      setTimeout(function() { ta.focus(); }, 100);
    }

    function closeShareModal() {
      document.getElementById('share-modal').classList.remove('active');
      document.body.classList.remove('modal-open');
      document.getElementById('share-form').reset();
      document.getElementById('image-preview').style.display = 'none';
      document.getElementById('post-link').style.display = 'none';
      document.getElementById('selected-mood').value = '';
      document.getElementById('selected-expiry').value = '';
      document.getElementById('post-tags').value = '';
      document.getElementById('tags-preview').innerHTML = '';
      document.querySelectorAll('.mood-option').forEach(function(el) { el.classList.remove('selected'); });
      document.querySelectorAll('.expiry-option').forEach(function(el) { el.classList.remove('selected'); });
      document.querySelector('.expiry-option[data-expiry=""]').classList.add('selected');
      updateCharCount();
    }

    function selectMood(mood) {
      document.getElementById('selected-mood').value = mood;
      document.querySelectorAll('.mood-option').forEach(function(el) {
        el.classList.toggle('selected', el.dataset.mood === mood);
      });
    }

    function selectExpiry(hours) {
      document.getElementById('selected-expiry').value = hours;
      document.querySelectorAll('.expiry-option').forEach(function(el) {
        el.classList.toggle('selected', el.dataset.expiry === hours);
      });
    }

    function toggleLinkInput() {
      var linkInput = document.getElementById('post-link');
      if (linkInput.style.display === 'none') {
        linkInput.style.display = '';
        linkInput.focus();
      } else {
        linkInput.style.display = 'none';
      }
    }

    // 发布后按心情给一句共情回应
    function empathyFor(mood) {
      var m = {
        happy: '你的快乐被看见了 ☀️', sad: '说出来，就轻一点了 🫂', angry: '你的情绪是合理的，谢谢你说出来',
        anxious: '别怕，很多人和你一起 🌿', calm: '愿你一直这样平静 🍃', love: '愿这份心动被温柔以待 💕',
        tired: '辛苦了，先好好歇一歇 🌙', excited: '为你高兴，继续闪光 ✨', confused: '慢慢来，答案会出现的',
        grateful: '感恩的心很美 🌸'
      };
      return '发布成功 · ' + (m[mood] || '你的心声已被听见 🌿');
    }

    function updateCharCount() {
      var textarea = document.getElementById('post-content');
      var count = document.getElementById('char-count');
      if (!textarea || !count) return;
      var len = textarea.value.length;
      count.textContent = len + ' 字';
      count.className = 'char-count absolute bottom-3 right-3';
      // 草稿自动保存
      if (textarea.value) localStorage.setItem('yf_draft', textarea.value);
      else localStorage.removeItem('yf_draft');
    }

    function removeImage() {
      document.getElementById('post-image').value = '';
      document.getElementById('image-preview').style.display = 'none';
    }

    function openLightbox(src) {
      var lightbox = document.getElementById('lightbox');
      var img = document.getElementById('lightbox-img');
      if (!lightbox || !img) return;
      img.src = src;
      lightbox.classList.add('active');
    }
    function closeLightbox() {
      var lightbox = document.getElementById('lightbox');
      if (lightbox) lightbox.classList.remove('active');
    }

    // ============ 图片拖拽上传 ============
    function setupDragAndDrop() {
      var wrapper = document.getElementById('content-wrapper');
      var textarea = document.getElementById('post-content');
      if (!wrapper || !textarea) return;

      var dragCounter = 0;
      var dragOverlay = null;

      wrapper.addEventListener('dragenter', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        if (dragCounter === 1) {
          textarea.classList.add('drag-over');
          dragOverlay = document.createElement('div');
          dragOverlay.className = 'drag-overlay';
          dragOverlay.innerHTML = '<i class="fa fa-image" style="margin-right:8px;"></i>释放以添加图片';
          wrapper.style.position = 'relative';
          wrapper.appendChild(dragOverlay);
        }
      });

      wrapper.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
      });

      wrapper.addEventListener('dragleave', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dragCounter--;
        if (dragCounter === 0) {
          textarea.classList.remove('drag-over');
          if (dragOverlay && dragOverlay.parentNode) {
            dragOverlay.parentNode.removeChild(dragOverlay);
          }
          dragOverlay = null;
        }
      });

      wrapper.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        textarea.classList.remove('drag-over');
        if (dragOverlay && dragOverlay.parentNode) {
          dragOverlay.parentNode.removeChild(dragOverlay);
        }
        dragOverlay = null;

        var files = e.dataTransfer.files;
        if (files && files.length > 0) {
          var file = files[0];
          if (!file.type.startsWith('image/')) {
            showToast('请拖拽图片文件', 'error');
            return;
          }
          if (file.size > 5 * 1024 * 1024) {
            showToast('图片大小不能超过 5MB', 'error');
            return;
          }
          var dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          document.getElementById('post-image').files = dataTransfer.files;
          var reader = new FileReader();
          reader.onload = function(ev) {
            var preview = document.getElementById('image-preview');
            var previewImg = document.getElementById('preview-img');
            if (preview && previewImg) {
              previewImg.src = ev.target.result;
              preview.style.display = '';
            }
          };
          reader.readAsDataURL(file);
          showToast('图片已添加', 'success');
        }
      });
    }

    // ============ Ctrl+Enter 快捷发布 ============
    function setupCtrlEnter() {
      var textarea = document.getElementById('post-content');
      if (!textarea) return;
      textarea.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 'Enter') {
          e.preventDefault();
          var form = document.getElementById('share-form');
          if (form) {
            var submitEvent = new Event('submit', { bubbles: true, cancelable: true });
            form.dispatchEvent(submitEvent);
          }
        }
      });
    }

    // 发布帖子
    var formSubmitting = false;
    document.getElementById('share-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      if (formSubmitting) return;

      formSubmitting = true;
      var submitBtn = document.getElementById('submit-btn');
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i><span>发布中...</span>';

      var formData = new FormData();
      formData.append('content', document.getElementById('post-content').value);
      formData.append('fingerprint', userFingerprint);
      var mood = document.getElementById('selected-mood').value;
      if (mood) formData.append('mood', mood);
      var expiry = document.getElementById('selected-expiry').value;
      if (expiry) formData.append('expires_in', expiry);
      var linkVal = document.getElementById('post-link').value.trim();
      if (linkVal) formData.append('link_url', linkVal);
      var file = document.getElementById('post-image').files[0];
      if (file) formData.append('image', file);

      var tagsVal = document.getElementById('post-tags').value.trim();
      if (tagsVal) {
        var tags = tagsVal.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }).slice(0, 5);
        formData.append('tags', JSON.stringify(tags));
      }
      var sensitiveEl = document.getElementById('post-sensitive');
      if (sensitiveEl && sensitiveEl.checked) formData.append('sensitive', 'true');

      try {
        var result = await stableFetch(API_BASE + '/api/posts', { method: 'POST', body: formData });
        closeShareModal();
        localStorage.removeItem('yf_draft');
        showToast(empathyFor(mood), 'success');
        resetAndLoadPosts();
        loadFeaturedPost();
        bumpCounter('yf_post_count');
        if (checkinStats) renderBadges(checkinStats);
        // 命中危机关键词：发布后温和地递上求助资源（不拦截发布）
        if (result && result.crisisSupport) showCrisisSupport();
      } catch (err) {
        showToast(err.message || '发布失败', 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa fa-paper-plane"></i><span>发布</span>';
        formSubmitting = false;
      }
    });

    // 图片预览
    document.getElementById('post-image').addEventListener('change', function(e) {
      var file = e.target.files[0];
      if (file) {
        if (file.size > 5 * 1024 * 1024) {
          showToast('图片大小不能超过 5MB', 'error');
          this.value = '';
          return;
        }
        var reader = new FileReader();
        reader.onload = function(e) {
          var preview = document.getElementById('image-preview');
          var previewImg = document.getElementById('preview-img');
          if (preview && previewImg) {
            previewImg.src = e.target.result;
            preview.style.display = '';
          }
        };
        reader.readAsDataURL(file);
      }
    });

    // 标签输入预览
    document.getElementById('post-tags').addEventListener('input', function() {
      var value = this.value;
      var preview = document.getElementById('tags-preview');
      var tags = value.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });

      if (tags.length > 5) {
        tags = tags.slice(0, 5);
        this.value = tags.join(', ');
      }

      var html = '';
      for (var i = 0; i < tags.length; i++) {
        html += '<span class="tag">' + escapeHtml(tags[i]) + '</span>';
      }
      preview.innerHTML = html;
    });

    // ESC 关闭
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        closeShareModal();
        closeLightbox();
        closeReportModal();
      }
    });

    // 点击模态框外部关闭
    document.getElementById('share-modal').addEventListener('click', function(e) {
      if (e.target === this) closeShareModal();
    });
    document.getElementById('report-modal').addEventListener('click', function(e) {
      if (e.target === this) closeReportModal();
    });

    // 初始化
    document.addEventListener('DOMContentLoaded', function() {
      setupEventDelegation();
      setupInfiniteScroll();
      setupDragAndDrop();
      setupCtrlEnter();
      maybeShowAgeGate();
      applyFestival();
      renderMoodChannels();
      resetAndLoadPosts();
      loadCheckin();
      loadMoodWeather();
      loadFeaturedPost();
      loadPopularTags();
      loadDigest();
      loadPresence();
      setInterval(loadPresence, 60000);
      loadNotifications();
      setInterval(loadNotifications, 60000);
    });
  