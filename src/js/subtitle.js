/**
 * HTML5 <track> 字幕：支持 WebVTT URL；控制栏快捷图标一键开关；齿轮内为轨列表（YouTube 式）
 */

/** Keep in sync with web-client `subtitle-preference.ts` ALNITAK_SUBTITLE_PREF_LS_KEY */
const ALNITAK_SUBTITLE_PREF_KEY = 'alnitak-pref-subtitle-track';
const ALNITAK_SUBTITLE_BG_KEY = 'alnitak-pref-subtitle-bg';

function subtitlePrefNorm(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

function readSubtitleBgPreference() {
  try {
    if (typeof localStorage === 'undefined') return true;
    var raw = localStorage.getItem(ALNITAK_SUBTITLE_BG_KEY);
    return raw === null ? true : raw === '1';
  } catch (_) {
    return true;
  }
}

function persistSubtitleBgPreference(val) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ALNITAK_SUBTITLE_BG_KEY, val ? '1' : '0');
    }
  } catch (_) {}
}

function readSubtitlePreference() {
  try {
    var raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(ALNITAK_SUBTITLE_PREF_KEY) : null;
    if (!raw) return null;
    var o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    return {
      label: typeof o.label === 'string' ? o.label : '',
      lang: typeof o.lang === 'string' ? o.lang : '',
    };
  } catch (_) {
    return null;
  }
}

function persistSubtitlePreferenceFromTextTrack(track) {
  try {
    if (!track || typeof localStorage === 'undefined') return;
    localStorage.setItem(
      ALNITAK_SUBTITLE_PREF_KEY,
      JSON.stringify({
        label: track.label ? String(track.label).trim() : '',
        lang: track.language ? String(track.language).trim() : '',
      }),
    );
  } catch (_) {
    /* quota / private */
  }
}

/** 若无记忆或无匹配返回 0（第一条轨） */
function pickPreferredSubtitleTrackIndex(tracks) {
  if (!tracks || !tracks.length) return 0;
  var pref = readSubtitlePreference();
  if (!pref || (!pref.label && !pref.lang)) return 0;
  var i;
  if (pref.label) {
    var nl = subtitlePrefNorm(pref.label);
    for (i = 0; i < tracks.length; i++) {
      if (subtitlePrefNorm(tracks[i].label) === nl) return i;
    }
  }
  if (pref.lang) {
    var lc = subtitlePrefNorm(pref.lang);
    for (i = 0; i < tracks.length; i++) {
      if (subtitlePrefNorm(tracks[i].language) === lc) return i;
    }
  }
  return 0;
}

class Subtitle {
  constructor(player) {
    this.player = player;
    this.available = false;
    this.loadSuccess = false;
    this.selectedTrackIndex = -1;

    /** 字幕 setup 会话：防止连续 updateSubtitles/remove 轨道时旧 track 的 load/error 干扰 */
    this.setupSessionId = 0;

    this.settingEntry = player.template.subtitleSettingEntry;
    this.subtitleLabelEl = player.template.subtitleSettingLabel;
    this.subtitleValueEl = player.template.subtitleSettingValue;
    this.subtitlesPanel = player.template.subtitleSettingPanel;
    this.subtitlesBack = player.template.subtitleSettingBack;
    this.subtitlesList = player.template.subtitleSettingList;
    this.settingBox = player.template.settingBox;
    this.quickWrap = player.template.subtitleQuickWrap;
    this.quickButton = player.template.subtitleQuickButton;

    this.hasMenuUi = !!(this.settingEntry && this.subtitleLabelEl && this.subtitleValueEl && this.subtitlesPanel && this.subtitlesBack && this.subtitlesList);

    /** 字幕背景开关 */
    this.subtitleBgEnabled = readSubtitleBgPreference();
    this._bgStyleEl = null;
    this._cueOverlay = null;
    this._cueOverlayInner = null;
    this._cueChangeHandler = null;
    this.syncSubtitleBg();

    if (this.quickButton) {
      this.quickButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.quickToggle();
      });
    }

    if (this.hasMenuUi) {
      this.settingEntry.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!this.available) return;
        this.openSubmenu();
      });

      this.subtitlesBack.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closeSubmenu();
      });

      this.subtitlesList.addEventListener('click', (e) => {
        const opt = e.target.closest('[data-track-index], [data-subtitle-bg]');
        if (!opt || !this.available) return;
        e.stopPropagation();
        if (opt.hasAttribute('data-subtitle-bg')) {
          this.subtitleBgEnabled = !this.subtitleBgEnabled;
          persistSubtitleBgPreference(this.subtitleBgEnabled);
          this.syncSubtitleBg();
          this.rebuildSubtitleList();
          this.syncListActive();
          return;
        }
        const raw = opt.getAttribute('data-track-index');
        const idx = raw === '-1' || raw === null ? -1 : Number.parseInt(raw, 10);
        this.selectedTrackIndex = Number.isNaN(idx) ? -1 : idx;
        this.applySubtitleState();
        if (this.selectedTrackIndex >= 0 && this.player.video && this.available) {
          var stt = this.collectSubtitleTracks(this.player.video)[this.selectedTrackIndex];
          if (stt) persistSubtitlePreferenceFromTextTrack(stt);
        }
        this.refreshSubsUi();
      });
    }

    this.syncQuickButton();
    if (this.hasMenuUi) {
      this.setAvailable(false);
    }
  }

  quickToggle() {
    if (!this.available || !this.player.video) return;
    const tracks = this.collectSubtitleTracks(this.player.video);
    if (!tracks.length) return;
    if (this.selectedTrackIndex >= 0) {
      this.selectedTrackIndex = -1;
    } else {
      var idxPref = pickPreferredSubtitleTrackIndex(tracks);
      this.selectedTrackIndex = Math.min(Math.max(0, idxPref), tracks.length - 1);
    }
    this.applySubtitleState();
    this.refreshSubsUi();
  }

  refreshSubsUi() {
    if (this.hasMenuUi) {
      this.syncEntryRow();
      if (this.settingBox && this.settingBox.classList.contains('wplayer-setting-box-subtitles-menu')) {
        this.syncListActive();
      }
    }
    this.syncQuickButton();
  }

  syncQuickButton() {
    if (!this.quickWrap || !this.quickButton) return;
    const dis = !this.available;
    const on = !dis && this.selectedTrackIndex >= 0;
    this.quickWrap.classList.toggle('wplayer-subtitles-quick-disabled', dis);
    this.quickWrap.classList.toggle('wplayer-subtitles-quick-on', on);
    this.quickButton.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  syncSubtitleBg() {
    this._applySubtitleBgMode();
  }

  /**
   * 字幕背景开关：
   *   - 更新 ::cue 样式（降级备选）
   *   - 更新覆盖层内层 class（主线方案，背景仅包裹文字）
   */
  _applySubtitleBgMode() {
    var video = this.player && this.player.video;
    if (!video) return;

    var container = this.player.container;
    if (!container) return;

    var id = 'wplayer-subtitle-bg-style-' + (this.player.index || 0);
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      el.type = 'text/css';
      container.appendChild(el);
    }

    if (this.subtitleBgEnabled) {
      el.textContent = 'video.wplayer-video-current::cue { background: rgba(0,0,0,0.72) !important; }';
    } else {
      el.textContent = 'video.wplayer-video-current::cue { background: transparent !important; }';
    }
    this._bgStyleEl = el;

    // 覆盖层内层背景同步（inline-block 仅包裹文字）
    if (this._cueOverlayInner) {
      this._cueOverlayInner.classList.toggle('wplayer-subtitle-cue-inner-bg', this.subtitleBgEnabled);
    }
  }

  _removeBgStyleEl() {
    var id = 'wplayer-subtitle-bg-style-' + (this.player.index || 0);
    var el = document.getElementById(id);
    if (el) { el.parentNode.removeChild(el); }
    this._bgStyleEl = null;
  }

  /** 创建自定义字幕覆盖层并监听 cuechange */
  _createCueOverlay(track) {
    this._removeCueOverlay();
    var container = this.player.container;
    if (!container) return;
    var videoWrap = container.querySelector('.wplayer-video-wrap');
    if (!videoWrap) return;
    var overlay = document.createElement('div');
    overlay.className = 'wplayer-subtitle-cue-overlay';
    var inner = document.createElement('div');
    inner.className = 'wplayer-subtitle-cue-inner';
    if (this.subtitleBgEnabled) {
      inner.classList.add('wplayer-subtitle-cue-inner-bg');
    }
    overlay.appendChild(inner);
    videoWrap.appendChild(overlay);
    this._cueOverlay = overlay;
    this._cueOverlayInner = inner;

    var self = this;
    this._cueChangeHandler = function () {
      self._updateCueOverlayText(track);
    };
    track.oncuechange = this._cueChangeHandler;
    // 立即渲染当前激活的字幕
    this._updateCueOverlayText(track);
  }

  _updateCueOverlayText(track) {
    if (!this._cueOverlay || !this._cueOverlayInner) return;
    var cues = track.activeCues;
    if (cues && cues.length > 0) {
      var texts = [];
      for (var i = 0; i < cues.length; i++) {
        texts.push(cues[i].text);
      }
      this._cueOverlayInner.textContent = texts.join('\n');
      this._cueOverlay.style.display = 'block';
    } else {
      this._cueOverlay.style.display = 'none';
    }
  }

  _removeCueOverlay() {
    if (this._cueOverlay) {
      if (this._cueOverlay.parentNode) {
        this._cueOverlay.parentNode.removeChild(this._cueOverlay);
      }
      this._cueOverlay = null;
      this._cueOverlayInner = null;
    }
    // 清理 oncuechange
    if (this._cueChangeHandler) {
      var video = this.player && this.player.video;
      if (video) {
        var tracks = this.collectSubtitleTracks(video);
        for (var i = 0; i < tracks.length; i++) {
          if (tracks[i].oncuechange === this._cueChangeHandler) {
            tracks[i].oncuechange = null;
          }
        }
      }
      this._cueChangeHandler = null;
    }
  }

  onSettingsHide() {
    this.closeSubmenu();
  }

  closeSubmenu() {
    if (this.settingBox) {
      this.settingBox.classList.remove('wplayer-setting-box-subtitles-menu');
    }
  }

  openSubmenu() {
    if (!this.settingBox || !this.available) return;
    this.settingBox.classList.add('wplayer-setting-box-subtitles-menu');
    this.rebuildSubtitleList();
    this.syncListActive();
  }

  trackDisplayLabel(track, index) {
    const lbl = track.label && String(track.label).trim();
    if (lbl) return lbl;
    const lang = track.language && String(track.language).trim();
    if (lang) return lang;
    return `${this.player.tran('subtitles')} ${index + 1}`;
  }

  listFromOptions() {
    const v = this.player.options.video;
    if (!v) return [];
    if (Array.isArray(v.subtitles) && v.subtitles.length) return v.subtitles;
    if (Array.isArray(v.subtitle) && v.subtitle.length) return v.subtitle;
    if (v.subtitle && typeof v.subtitle === 'object' && v.subtitle.src) return [v.subtitle];
    return [];
  }

  collectSubtitleTracks(video) {
    const out = [];
    const { textTracks } = video;
    if (!textTracks) return out;
    for (let i = 0; i < textTracks.length; i++) {
      const t = textTracks[i];
      if (t.kind === 'subtitles' || t.kind === 'captions') {
        out.push(t);
      }
    }
    if (out.length > 0) {
      console.info('[Alnitak:subtitle:debug] collectSubtitleTracks', {
        total: textTracks.length,
        filtered: out.length,
        tracks: JSON.stringify(out.map((t, i) => ({ i, label: t.label, lang: t.language, mode: t.mode, kind: t.kind }))),
      });
    }
    return out;
  }

  syncEntryRow() {
    if (!this.hasMenuUi) return;
    const video = this.player.video;
    const n = video ? this.collectSubtitleTracks(video).length : 0;
    const subtitleWord = this.player.tran('subtitles');
    this.subtitleLabelEl.textContent = n > 0 ? `${subtitleWord} (${n})` : subtitleWord;

    if (!this.available) {
      this.subtitleValueEl.textContent = this.player.tran('subtitle-unavailable');
      return;
    }
    if (!video || n === 0) {
      this.subtitleValueEl.textContent = this.player.tran('off');
      return;
    }
    if (this.selectedTrackIndex < 0) {
      this.subtitleValueEl.textContent = this.player.tran('off');
      return;
    }
    const tracks = this.collectSubtitleTracks(video);
    const idx = Math.min(this.selectedTrackIndex, tracks.length - 1);
    this.subtitleValueEl.textContent = this.trackDisplayLabel(tracks[idx], idx);
  }

  rebuildSubtitleList() {
    if (!this.hasMenuUi) return;
    this.subtitlesList.innerHTML = '';
    const mk = (idx, text) => {
      const div = document.createElement('div');
      div.className = 'wplayer-setting-subtitles-option';
      div.setAttribute('data-track-index', String(idx));
      const check = document.createElement('span');
      check.className = 'wplayer-setting-subtitles-check';
      check.textContent = '✓';
      const lab = document.createElement('span');
      lab.className = 'wplayer-label';
      lab.textContent = text;
      div.appendChild(check);
      div.appendChild(lab);
      this.subtitlesList.appendChild(div);
    };

    mk(-1, this.player.tran('off'));

    const video = this.player.video;
    if (!video) return;
    const tracks = this.collectSubtitleTracks(video);
    for (let i = 0; i < tracks.length; i++) {
      mk(i, this.trackDisplayLabel(tracks[i], i));
    }

    const bgDiv = document.createElement('div');
    bgDiv.className = 'wplayer-setting-subtitles-bg-item';
    bgDiv.setAttribute('data-subtitle-bg', '1');
    const bgLab = document.createElement('span');
    bgLab.className = 'wplayer-label';
    bgLab.textContent = this.player.tran('subtitle-bg') || '字幕背景';
    const toggleDiv = document.createElement('div');
    toggleDiv.className = 'wplayer-toggle';
    const toggleId = 'wplayer-subtitle-bg-' + (this.player.index || 0);
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.id = toggleId;
    toggleInput.checked = this.subtitleBgEnabled;
    const toggleLabel = document.createElement('label');
    toggleLabel.setAttribute('for', toggleId);
    toggleDiv.appendChild(toggleInput);
    toggleDiv.appendChild(toggleLabel);
    bgDiv.appendChild(bgLab);
    bgDiv.appendChild(toggleDiv);
    this.subtitlesList.appendChild(bgDiv);

    // Prevent label→input synthetic click which double-toggles on some browsers.
    // The delegated click on subtitlesList handles state; native label activation
    // would fire a second click on the hidden checkbox, toggling bgEnabled back.
    toggleLabel.addEventListener('click', (e) => {
      e.preventDefault();
    });
  }

  syncListActive() {
    if (!this.hasMenuUi) return;
    const rows = this.subtitlesList.querySelectorAll('.wplayer-setting-subtitles-option');
    rows.forEach((row) => {
      const raw = row.getAttribute('data-track-index');
      const idx = raw === '-1' || raw === null ? -1 : Number.parseInt(raw, 10);
      row.classList.toggle('wplayer-setting-subtitles-option-active', idx === this.selectedTrackIndex);
    });
    const bgItem = this.subtitlesList.querySelector('[data-subtitle-bg] input[type="checkbox"]');
    if (bgItem) {
      bgItem.checked = this.subtitleBgEnabled;
    }
  }

  applySubtitleState() {
    const video = this.player.video;
    if (!video || !this.player.events) return;
    const tracks = this.collectSubtitleTracks(video);
    console.info('[Alnitak:subtitle:debug] applySubtitleState', {
      available: this.available,
      selectedTrackIndex: this.selectedTrackIndex,
      trackCount: tracks.length,
      tracks: JSON.stringify(tracks.map((t, i) => ({ i, label: t.label, lang: t.language, mode: t.mode, kind: t.kind }))),
    });
    if (!tracks.length) {
      this._removeCueOverlay();
      this.player.events.trigger('subtitle_hide');
      this.player.events.trigger('subtitle_change', { visible: false, trackIndex: -1 });
      return;
    }
    if (!this.available || this.selectedTrackIndex < 0) {
      tracks.forEach((t) => { t.mode = 'disabled'; });
      this._removeCueOverlay();
      this.player.events.trigger('subtitle_hide');
      this.player.events.trigger('subtitle_change', { visible: false, trackIndex: -1 });
      return;
    }
    let idx = Math.min(this.selectedTrackIndex, tracks.length - 1);
    if (idx < 0) idx = 0;
    this.selectedTrackIndex = idx;
    // 覆盖层方案：track 始终 hidden（禁止原生渲染），通过覆盖层显示字幕
    tracks.forEach((t, i) => {
      t.mode = i === idx ? 'hidden' : 'disabled';
    });
    this._createCueOverlay(tracks[idx]);
    console.info('[Alnitak:subtitle:debug] applySubtitleState:after', {
      selectedIndex: idx,
      tracks: JSON.stringify(tracks.map((t, i) => ({ i, label: t.label, lang: t.language, mode: t.mode }))),
    });
    this.player.events.trigger('subtitle_show');
    this.player.events.trigger('subtitle_change', {
      visible: true,
      trackIndex: idx,
      label: this.trackDisplayLabel(tracks[idx], idx),
    });
  }

  setup(video) {
    if (!video) return;

    this._removeCueOverlay();

    const sid = ++this.setupSessionId;
    console.info('[Alnitak:subtitle:wplayer] setup:start', {
      sid,
      cueVideoTag: !!(video.tagName && String(video.tagName).toLowerCase() === 'video'),
    });

    video.querySelectorAll('track[data-wplayer-subtitle]').forEach((n) => {
      n.remove();
    });

    this.selectedTrackIndex = -1;

    const list = this.listFromOptions();
    if (!list.length) {
      console.info('[Alnitak:subtitle:wplayer] setup:empty-list', { sid });
      this.setAvailable(false);
      if (video) this.applyModesAllOff(video);
      return;
    }

    console.info('[Alnitak:subtitle:wplayer] setup:list', {
      sid,
      n: list.length,
      items: list.map((item, idx) => ({
        idx,
        srcPrefix: item.src ? String(item.src).slice(0, 72) : '',
        kind: item.kind,
        default: !!item.default,
        label: item.label,
        srclang: item.srclang,
      })),
    });

    this.setAvailable(false);
    this.applyModesAllOff(video);

    let defaultIndex = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].default) {
        defaultIndex = i;
        break;
      }
    }
    this.defaultIndex = defaultIndex;
    this.loadSuccess = true;

    list.forEach((item, idx) => {
      if (!item.src) return;
      const trackEl = document.createElement('track');
      trackEl.dataset.wplayerSubtitle = '1';
      trackEl.kind = item.kind || 'subtitles';
      trackEl.src = item.src;
      if (item.label) trackEl.label = item.label;
      if (item.srclang) trackEl.srclang = item.srclang;
      // 不设 default：由 applySubtitleState() 统一管理轨道启用，避免浏览器自动覆盖

      trackEl.addEventListener('error', () => {
        console.warn('[Alnitak:subtitle:wplayer] track:error', {
          sid, idx,
          srcPrefix: item.src ? String(item.src).slice(0, 80) : '',
          srclang: item.srclang,
        });
      }, { once: true });
      trackEl.addEventListener('load', () => {
        console.info('[Alnitak:subtitle:wplayer] track:load', {
          sid, idx, srclang: item.srclang,
        });
      }, { once: true });

      video.appendChild(trackEl);
    });

    // 与 DPlayer 对齐：创建 <track> 后立即激活，不等待加载
    var selectedIdx = pickPreferredSubtitleTrackIndex(this.collectSubtitleTracks(video));
    this.selectedTrackIndex = Math.min(Math.max(0, selectedIdx), list.length - 1);
    this.setAvailable(true);
    this.syncSubtitleBg();
    this.applySubtitleState();
    this.refreshSubsUi();

    // 防浏览器自动覆盖 track mode（Chrome 语言偏好记忆会将 disabled 轨改为 showing）
    var self = this;
    var protectIdx = this.selectedTrackIndex;
    var protectSid = sid;
    var protectCount = 0;

    function protectModes() {
      if (protectSid !== sid) return;
      if (protectCount++ > 10) return;
      var cur = self.collectSubtitleTracks(video);
      var expectMode = 'hidden';
      var needsReapply = cur.some(function (ct, ci) {
        if (ci === protectIdx) return ct.mode !== expectMode;
        return ct.mode !== 'disabled';
      });
      if (needsReapply) {
        cur.forEach(function (ct) { ct.mode = 'disabled'; });
        requestAnimationFrame(function () {
          if (cur[protectIdx]) cur[protectIdx].mode = expectMode;
        });
      }
      setTimeout(protectModes, 200);
    }
    setTimeout(protectModes, 200);
  }

  applyModesAllOff(video) {
    const { textTracks } = video;
    if (!textTracks || !textTracks.length) return;
    console.info('[Alnitak:subtitle:debug] applyModesAllOff', {
      count: textTracks.length,
      tracks: JSON.stringify(Array.from(textTracks).map((t, i) => ({ i, label: t.label, lang: t.language, mode: t.mode, kind: t.kind }))),
    });
    for (let i = 0; i < textTracks.length; i++) {
      textTracks[i].mode = 'disabled';
    }
  }

  setAvailable(v) {
    this.available = v;
    if (this.hasMenuUi) {
      this.settingEntry.classList.toggle('wplayer-subtitles-setting-disabled', !v);
      if (!v) this.closeSubmenu();
      this.syncEntryRow();
    }
    this.syncQuickButton();
  }

  /**
   * 动态更新字幕列表（不重建播放器）
   * @param {Array|Object} config - 与 video.subtitles / video.subtitle 同形
   */
  updateSubtitleConfig(config) {
    if (Array.isArray(config)) {
      this.player.options.video.subtitles = config;
      delete this.player.options.video.subtitle;
    } else if (config && config.src) {
      this.player.options.video.subtitle = config;
      delete this.player.options.video.subtitles;
    }
    this.setup(this.player.video);
  }
}

export default Subtitle;
