
  // ============ 背景音乐播放器（Web Audio API 合成） ============
  (function() {
    var audioCtx = null;
    var masterGain = null;
    var isPlaying = false;
    var isExpanded = false;
    var isMuted = false;
    var prevVolume = 30;
    var currentTrack = 0;
    var volume = 0.3;
    var activeNodes = [];
    var visualizerTimer = null;
    var showVolToast = null; // 将在 initDrag 中赋值

    var tracks = [
      {
        name: '星夜漫步', genre: 'Ambient', bpm: 60,
        chords: [
          { notes: [261.63, 329.63, 392.00], duration: 4 },
          { notes: [220.00, 261.63, 329.63], duration: 4 },
          { notes: [174.61, 220.00, 261.63], duration: 4 },
          { notes: [196.00, 246.94, 293.66], duration: 4 },
        ],
        melody: [523.25, 587.33, 659.25, 523.25, 493.88, 440.00, 392.00, 440.00],
        melodyDur: [1, 1, 2, 1, 1, 1, 1, 2],
        padType: 'sine', melodyType: 'triangle'
      },
      {
        name: '雨后清晨', genre: 'Lo-fi Chill', bpm: 72,
        chords: [
          { notes: [293.66, 369.99, 440.00], duration: 3 },
          { notes: [261.63, 329.63, 392.00], duration: 3 },
          { notes: [220.00, 277.18, 329.63], duration: 3 },
          { notes: [246.94, 311.13, 369.99], duration: 3 },
        ],
        melody: [587.33, 523.25, 440.00, 523.25, 493.88, 440.00, 392.00, 349.23],
        melodyDur: [1.5, 0.5, 1, 1, 1.5, 0.5, 1.5, 1.5],
        padType: 'sine', melodyType: 'sine'
      },
      {
        name: '深海之梦', genre: 'Ambient', bpm: 50,
        chords: [
          { notes: [130.81, 164.81, 196.00], duration: 6 },
          { notes: [146.83, 174.61, 220.00], duration: 6 },
          { notes: [116.54, 146.83, 174.61], duration: 6 },
          { notes: [123.47, 155.56, 185.00], duration: 6 },
        ],
        melody: [261.63, 293.66, 329.63, 293.66, 261.63, 220.00, 196.00, 220.00],
        melodyDur: [2, 1, 1, 2, 1, 1, 2, 2],
        padType: 'sine', melodyType: 'triangle'
      },
      {
        name: '午后阳光', genre: 'Chill', bpm: 80,
        chords: [
          { notes: [329.63, 415.30, 493.88], duration: 2.5 },
          { notes: [293.66, 369.99, 440.00], duration: 2.5 },
          { notes: [261.63, 329.63, 392.00], duration: 2.5 },
          { notes: [349.23, 440.00, 523.25], duration: 2.5 },
        ],
        melody: [659.25, 587.33, 523.25, 493.88, 523.25, 587.33, 659.25, 783.99],
        melodyDur: [0.5, 0.5, 1, 0.5, 0.5, 1, 1, 1],
        padType: 'triangle', melodyType: 'sine'
      }
    ];

    function initAudio() {
      if (audioCtx) return;
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = volume * 0.6;
      masterGain.connect(audioCtx.destination);
    }

    function stopAllNodes() {
      for (var i = 0; i < activeNodes.length; i++) {
        try {
          if (activeNodes[i].stop) activeNodes[i].stop(audioCtx.currentTime + 0.5);
          if (activeNodes[i].disconnect) activeNodes[i].disconnect();
        } catch(e) {}
      }
      activeNodes = [];
    }

    function playNote(freq, startTime, duration, type, gainVal) {
      if (!audioCtx || freq <= 0) return;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      var attack = Math.min(0.3, duration * 0.15);
      var release = Math.min(1.0, duration * 0.4);
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(gainVal || 0.08, startTime + attack);
      gain.gain.setValueAtTime(gainVal || 0.08, startTime + duration - release);
      gain.gain.linearRampToValueAtTime(0, startTime + duration);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(startTime);
      osc.stop(startTime + duration + 0.1);
      activeNodes.push(osc);
      activeNodes.push(gain);
    }

    function playTrack(trackIdx) {
      if (!audioCtx) return;
      stopAllNodes();
      var track = tracks[trackIdx];
      var beatDur = 60 / track.bpm;
      var now = audioCtx.currentTime + 0.1;
      var chordTotalDur = 0;
      for (var c = 0; c < track.chords.length; c++) {
        chordTotalDur += track.chords[c].duration * beatDur;
      }
      var loops = 4;
      for (var loop = 0; loop < loops; loop++) {
        var loopOffset = now + loop * chordTotalDur;
        var chordTime = loopOffset;
        for (var c = 0; c < track.chords.length; c++) {
          var chord = track.chords[c];
          var dur = chord.duration * beatDur;
          for (var n = 0; n < chord.notes.length; n++) {
            playNote(chord.notes[n] * 0.5, chordTime, dur + 1, track.padType, 0.18);
            playNote(chord.notes[n], chordTime, dur + 0.5, track.padType, 0.12);
          }
          chordTime += dur;
        }
        var melodyTime = loopOffset;
        for (var m = 0; m < track.melody.length; m++) {
          var mDur = track.melodyDur[m] * beatDur;
          if (melodyTime < loopOffset + chordTotalDur - 1) {
            playNote(track.melody[m], melodyTime, mDur * 0.9, track.melodyType, 0.15);
          }
          melodyTime += mDur;
        }
      }
      // 自动切换下一首
      var totalDur = chordTotalDur * loops;
      setTimeout(function() {
        if (isPlaying && currentTrack === trackIdx) {
          window.musicNext();
        }
      }, totalDur * 1000);
    }

    function updateUI() {
      var player = document.getElementById('music-player');
      var btn = document.getElementById('music-toggle');
      var titleEl = document.getElementById('music-title');
      var artistEl = document.getElementById('music-artist');
      var volIcon = document.getElementById('music-vol-icon');

      // 播放/暂停图标
      if (isPlaying) {
        btn.classList.add('playing');
        btn.innerHTML = '<i class="fa fa-pause"></i>';
      } else {
        btn.classList.remove('playing');
        btn.innerHTML = '<i class="fa fa-play"></i>';
      }

      // 展开/收起
      if (isExpanded) {
        player.classList.remove('collapsed');
      } else {
        player.classList.add('collapsed');
      }

      // 曲目信息
      titleEl.textContent = tracks[currentTrack].name;
      artistEl.textContent = tracks[currentTrack].genre;

      // 音量图标
      if (isMuted || volume === 0) {
        volIcon.className = 'fa fa-volume-off music-volume-icon muted';
      } else if (volume < 0.5) {
        volIcon.className = 'fa fa-volume-down music-volume-icon';
      } else {
        volIcon.className = 'fa fa-volume-up music-volume-icon';
      }

      localStorage.setItem('music_playing', isPlaying ? '1' : '0');
      localStorage.setItem('music_track', currentTrack);
    }

    function startVisualizer() {
      clearInterval(visualizerTimer);
      var bars = document.querySelectorAll('#music-visualizer .bar');
      visualizerTimer = setInterval(function() {
        for (var i = 0; i < bars.length; i++) {
          bars[i].style.height = (isPlaying ? Math.floor(Math.random() * 14 + 3) : 4) + 'px';
        }
      }, 200);
    }

    window.musicTogglePlay = function() {
      initAudio();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      // 首次点击自动展开
      if (!isExpanded) isExpanded = true;
      if (isPlaying) {
        isPlaying = false;
        stopAllNodes();
      } else {
        isPlaying = true;
        playTrack(currentTrack);
      }
      updateUI();
    };

    window.musicCollapse = function() {
      isExpanded = false;
      updateUI();
    };

    window.musicToggleMute = function() {
      if (isMuted) {
        isMuted = false;
        volume = prevVolume / 100;
      } else {
        isMuted = true;
        prevVolume = Math.round(volume * 100);
        volume = 0;
      }
      if (masterGain) masterGain.gain.value = volume * 0.6;
      // 显示音量提示
      if (typeof showVolToast === 'function') showVolToast(volume, isMuted ? 'down' : 'up');
      updateUI();
    };

    window.musicNext = function() {
      initAudio();
      currentTrack = (currentTrack + 1) % tracks.length;
      if (isPlaying) playTrack(currentTrack);
      updateUI();
    };

    window.musicPrev = function() {
      initAudio();
      currentTrack = (currentTrack - 1 + tracks.length) % tracks.length;
      if (isPlaying) playTrack(currentTrack);
      updateUI();
    };

    window.musicSetVolume = function(val) {
      volume = val / 100;
      if (masterGain) masterGain.gain.value = volume * 0.6;
      localStorage.setItem('music_volume', val);
    };

    // 恢复状态
    var savedVol = localStorage.getItem('music_volume');
    if (savedVol !== null) {
      volume = parseInt(savedVol) / 100;
    }
    currentTrack = parseInt(localStorage.getItem('music_track') || '0') % tracks.length;
    document.getElementById('music-title').textContent = tracks[currentTrack].name;
    document.getElementById('music-artist').textContent = tracks[currentTrack].genre;
    startVisualizer();

    // ============ 拖拽移动 + 滑动音量 ============
    (function initDrag() {
      var player = document.getElementById('music-player');
      var isDragging = false;
      var isVolumeSliding = false;
      var startX, startY, startLeft, startBottom;
      var dragThreshold = 6;
      var hasMoved = false;
      var gestureLocked = false; // 锁定手势方向，防止中途切换
      var volStartY, volStartValue;
      var volToastTimer = null;
      var snapSide = null; // 'left' or 'right'
      var isSnapped = false;

      // 恢复保存的位置
      var savedPos = localStorage.getItem('music_position');
      if (savedPos) {
        try {
          var pos = JSON.parse(savedPos);
          if (pos.left !== undefined) player.style.left = pos.left + 'px';
          if (pos.bottom !== undefined) player.style.bottom = pos.bottom + 'px';
          player.style.right = 'auto';
          player.style.top = 'auto';
          // 恢复吸附状态
          if (pos.snapSide) {
            snapSide = pos.snapSide;
            isSnapped = true;
            player.classList.add('snapped-' + snapSide);
          }
        } catch(e) {}
      }

      showVolToast = function(val, direction) {
        var toast = document.getElementById('music-vol-toast');
        var fill = document.getElementById('music-vol-toast-fill');
        var pct = document.getElementById('music-vol-toast-pct');
        var icon = document.getElementById('music-vol-toast-icon');
        var arrow = document.getElementById('music-vol-toast-arrow');
        var pctVal = Math.round(val * 100);
        fill.style.width = pctVal + '%';
        pct.textContent = pctVal + '%';
        if (pctVal === 0) icon.className = 'music-vol-toast-icon fa fa-volume-off';
        else if (pctVal < 50) icon.className = 'music-vol-toast-icon fa fa-volume-down';
        else icon.className = 'music-vol-toast-icon fa fa-volume-up';
        // 方向指示
        if (direction === 'up') {
          arrow.innerHTML = '<i class="fa fa-arrow-up"></i> 增大音量';
        } else if (direction === 'down') {
          arrow.innerHTML = '<i class="fa fa-arrow-down"></i> 减小音量';
        } else {
          arrow.innerHTML = '<i class="fa fa-arrows-v"></i> 滑动调节';
        }
        toast.classList.add('visible');
        clearTimeout(volToastTimer);
        volToastTimer = setTimeout(function() { toast.classList.remove('visible'); }, 1500);
      };

      function onMouseDown(e) {
        if (e.target.closest('button') || e.target.closest('input')) return;
        isDragging = true;
        hasMoved = false;
        gestureLocked = false;
        isVolumeSliding = false;
        startX = e.clientX || (e.touches && e.touches[0].clientX);
        startY = e.clientY || (e.touches && e.touches[0].clientY);
        var rect = player.getBoundingClientRect();
        startLeft = rect.left;
        startBottom = window.innerHeight - rect.bottom;
        volStartY = startY;
        volStartValue = volume;
        // 拖拽时移除吸附状态
        if (isSnapped) {
          player.classList.remove('snapped-left', 'snapped-right');
          isSnapped = false;
        }
        player.classList.add('dragging');
        e.preventDefault();
      }

      function onMouseMove(e) {
        if (!isDragging) return;
        var clientX = e.clientX || (e.touches && e.touches[0].clientX);
        var clientY = e.clientY || (e.touches && e.touches[0].clientY);
        var dx = clientX - startX;
        var dy = clientY - startY;

        if (!hasMoved && (Math.abs(dx) > dragThreshold || Math.abs(dy) > dragThreshold)) {
          hasMoved = true;
          // 锁定手势方向
          gestureLocked = Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
        }

        if (hasMoved) {
          if (gestureLocked === 'horizontal') {
            // 水平拖拽移动位置（也允许少量垂直移动）
            isVolumeSliding = false;
            var newLeft = startLeft + dx;
            var newBottom = startBottom - dy;
            var maxLeft = window.innerWidth - player.offsetWidth;
            var maxBottom = window.innerHeight - player.offsetHeight;
            newLeft = Math.max(10, Math.min(newLeft, maxLeft - 10));
            newBottom = Math.max(10, Math.min(newBottom, maxBottom - 10));
            player.style.left = newLeft + 'px';
            player.style.bottom = newBottom + 'px';
            player.style.right = 'auto';
            player.style.top = 'auto';
          } else if (gestureLocked === 'vertical') {
            // 垂直滑动调节音量
            isVolumeSliding = true;
            var sensitivity = 0.004; // 每像素变化量（稍微提高灵敏度）
            var newVol = volStartValue - dy * sensitivity;
            newVol = Math.max(0, Math.min(1, newVol));
            volume = newVol;
            isMuted = (volume === 0);
            if (masterGain) masterGain.gain.value = volume * 0.6;
            var dir = dy < -2 ? 'up' : (dy > 2 ? 'down' : null);
            showVolToast(volume, dir);
            // 更新音量图标
            var volIcon = document.getElementById('music-vol-icon');
            volIcon.classList.toggle('muted', volume === 0);
            if (volume === 0) volIcon.className = 'fa fa-volume-off music-volume-icon muted';
            else if (volume < 0.5) volIcon.className = 'fa fa-volume-down music-volume-icon';
            else volIcon.className = 'fa fa-volume-up music-volume-icon';
            localStorage.setItem('music_volume', Math.round(volume * 100));
          }
        }
      }

      function snapToEdge(callback) {
        var rect = player.getBoundingClientRect();
        var centerX = rect.left + rect.width / 2;
        var screenCenterX = window.innerWidth / 2;
        var targetLeft, side;
        if (centerX < screenCenterX) {
          targetLeft = 6;
          side = 'left';
        } else {
          targetLeft = window.innerWidth - rect.width - 6;
          side = 'right';
        }
        snapSide = side;
        isSnapped = true;
        // 先移动到边缘位置
        player.style.transition = 'left 0.35s cubic-bezier(.4,0,.2,1), bottom 0.35s cubic-bezier(.4,0,.2,1)';
        player.style.left = targetLeft + 'px';
        setTimeout(function() {
          player.style.transition = '';
          // 添加半隐藏class
          player.classList.add('snapped-' + side);
          if (callback) callback();
        }, 360);
      }

      function onMouseUp(e) {
        if (!isDragging) return;
        isDragging = false;
        player.classList.remove('dragging');

        if (hasMoved && !isVolumeSliding) {
          // 水平拖拽结束 → 吸附边缘（半隐藏）
          snapToEdge(function() {
            var rect = player.getBoundingClientRect();
            localStorage.setItem('music_position', JSON.stringify({
              left: parseFloat(player.style.left),
              bottom: window.innerHeight - rect.bottom,
              snapSide: snapSide
            }));
          });
        } else if (hasMoved && isVolumeSliding) {
          // 音量调节结束，保存状态
          localStorage.setItem('music_volume', Math.round(volume * 100));
        }
        isVolumeSliding = false;
        gestureLocked = false;
      }

      player.addEventListener('mousedown', onMouseDown);
      player.addEventListener('touchstart', onMouseDown, { passive: false });
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('touchmove', onMouseMove, { passive: false });
      document.addEventListener('mouseup', onMouseUp);
      document.addEventListener('touchend', onMouseUp);

      // 窗口大小变化时重新吸附
      window.addEventListener('resize', function() {
        if (isSnapped && !isDragging) {
          player.classList.remove('snapped-left', 'snapped-right');
          setTimeout(function() { snapToEdge(); }, 50);
        }
      });
    })();

    // 播放按钮涟漪效果
    (function() {
      var btn = document.getElementById('music-toggle');
      btn.addEventListener('click', function(e) {
        var ripple = document.createElement('span');
        ripple.className = 'ripple';
        var rect = btn.getBoundingClientRect();
        var size = Math.max(rect.width, rect.height);
        ripple.style.width = ripple.style.height = size + 'px';
        ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
        ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
        btn.appendChild(ripple);
        setTimeout(function() { ripple.remove(); }, 600);
      });
    })();
  })();
  