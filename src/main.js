// Otogame Prototype - Single file module orchestrating states

const STATE = {
  TITLE: 'title',
  SELECT: 'select',
  PLAY: 'play',
  RESULT: 'result',
};

const KEYS = ['S', 'D', 'F', 'J', 'K', 'L'];
const KEY_MAP = {
  'KeyS': 0,
  'KeyD': 1,
  'KeyF': 2,
  'KeyJ': 3,
  'KeyK': 4,
  'KeyL': 5,
};

const DIFFICULTY = ['EASY', 'NORMAL', 'HARD'];

const $app = document.getElementById('app');
const $canvas = document.getElementById('game-canvas');
const ctx = $canvas.getContext('2d');

// Local persistence keys
const SETTINGS_KEY = 'otogame_settings_v1';
const STATS_KEY = 'otogame_stats_v1';

let audioCtx = null; // created on first user gesture
let tracks = []; // { id, name, type, file, arrayBuffer, audioBuffer, duration }
let gameState = STATE.TITLE;
let selectedTrackId = null;
let selectedDifficulty = 'NORMAL';
let timingOffsetMs = 0; // input judgement offset (+ makes input later)
let showBeatGuide = true;
let judgeTightness = 'NORMAL'; // 'NARROW' | 'NORMAL' | 'WIDE'

// Stats cache (loaded from localStorage on init)
let stats = loadStats ? loadStats() : {};
let selectedSort = 'added'; // 'added' | 'name' | 'recent' | 'best'
let selectedSortDir = 'desc'; // 'asc' | 'desc'
let analysisWorker = null;
let selectedFilter = 'all'; // 'all' | 'hasBest' | 'unplayed'
let searchQuery = '';
// Calibration (metronome)
let calibrator = { active:false, bpm:120, deltas:[], beatTimes:[], running:false, target:16, period:0, startedAt:0 };
// Gameplay options
let autoplay = false;
let hitSound = true;
let hitSoundVol = 0.16; // 0..1
let showJudgeGuides = false;
let guideBeat = false;
let theme = 'dark';
let lastTrackKey = null;
let selectScrollTop = 0;
let musicVol = 1.0;
let fullscreen = false;
let guideVol = 0.25; // 0..1 (independent from hitSoundVol)
let missSound = true;
let exportSize = '1600x900'; // result image size
let bgmMode = false; // Force grid-based chart for BGM-only tracks
// Selection state
let lastDeleted = null; // { track, index, until }

// Gameplay runtime
let play = null; // object containing runtime state when playing

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function setState(next) {
  gameState = next;
  renderUI();
  try {
    const c = document.getElementById('game-canvas');
    if (c) {
      if (gameState === STATE.PLAY || gameState === STATE.RESULT) c.style.pointerEvents = 'auto';
      else c.style.pointerEvents = 'none';
    }
  } catch {}
}

function renderUI() {
  $app.innerHTML = '';

  if (gameState === STATE.TITLE) {
    const panel = document.createElement('div');
    panel.className = 'hero';
    panel.innerHTML = `
      <div class="logo">Otogame <span style="opacity:.85">Prototype</span>
        <span class="eq" aria-hidden="true">
          <span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span>
        </span>
      </div>
      <div class="lead">アップロードした楽曲で遊べるリズムゲーム。<br/>曲を選んで、ビートに合わせてキーを叩こう！</div>
      <div class="cta">
        <button id="start-btn" class="start-btn">
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor" focusable="false" aria-hidden="true">
              <path d="M8 5v14l11-7z"></path>
            </svg>
          </span>
          <span>GAME START</span>
        </button>
        <div class="muted">キー: <span class="kbd">S</span> <span class="kbd">D</span> <span class="kbd">F</span> <span class="kbd">J</span> <span class="kbd">K</span> <span class="kbd">L</span></div>
      </div>
    `;
    $app.appendChild(panel);
    document.getElementById('start-btn').onclick = () => setState(STATE.SELECT);
    return;
  }

  if (gameState === STATE.SELECT) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="title">楽曲選択</div>
      <div class="row">
        <input type="file" id="file-input" accept="audio/*" multiple style="display:none" />
        <button id="file-button">音楽ファイルをアップロード</button>
        <div>またはドラッグ＆ドロップ</div>
      </div>
      <div id="drop" class="drag-area" style="margin-top:12px">ここに音楽ファイルをドロップ</div>
      <div class="row" style="margin-top:8px; align-items:center">
        <label style="min-width:8em">URLから追加</label>
        <input id="url-input" type="url" placeholder="https://example.com/music.mp3" style="flex:1; min-width: 240px;" />
        <button id="url-add" class="secondary">追加</button>
        <button id="share-copy" class="secondary">共有リンクをコピー</button>
      </div>
      <div class="muted" style="margin-top:4px">注意: 公開音源かつCORS許可されたURLのみ追加できます。</div>
      <div class="row" style="margin-top:12px; align-items:center">
        <button id="start-global" class="start-btn" ${selectedTrackId? '' : 'disabled'}>
          <span class="icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor" focusable="false" aria-hidden="true">
              <path d="M8 5v14l11-7z"></path>
            </svg>
          </span>
          <span>START</span>
        </button>
        <div class="muted" id="selected-label" style="margin-left:8px">${(() => {
          try {
            const t = tracks.find(x=>x.id===selectedTrackId);
            return t ? `選択中: ${escapeHtml(t.name)} / 難易度 ${selectedDifficulty}` : '選択中: なし';
          } catch { return '選択中: なし'; }
        })()}</div>
        <div class="muted" style="margin-left:12px">Enter / Space でも開始</div>
      </div>
      <div class="row" style="margin-top:12px">
        <label>難易度:</label>
        ${DIFFICULTY.map(d => `
          <button class="secondary diff-btn ${d===selectedDifficulty?'active':''}" data-diff="${d}">${d}</button>
        `).join('')}
      </div>
      <div class="row" style="margin-top:12px; align-items: center">
        <label style="min-width:8em">判定オフセット</label>
        <input id="offset-range" type="range" min="-100" max="100" step="1" value="${timingOffsetMs}"/>
        <span id="offset-label">${timingOffsetMs} ms</span>
        <button id="offset-reset" class="secondary">リセット</button>
      </div>
      <div class="row" style="margin-top:8px; align-items:center">
        <label style="min-width:8em">ビートガイド</label>
        <button id="beat-toggle" class="secondary">${showBeatGuide ? 'ON' : 'OFF'}</button>
      </div>
      <div class="row" style="margin-top:8px; align-items:center">
        <label style="min-width:8em">判定ウィンドウ</label>
        ${['NARROW','NORMAL','WIDE'].map(k=>`
          <button class="secondary jw-btn ${k===judgeTightness?'active':''}" data-jw="${k}">${k}</button>
        `).join('')}
      </div>
      <div class="muted" style="margin-top:4px">
        現在の判定: PERFECT ${Math.round(computeJudgeWindow(judgeTightness).perfect*1000)}ms / GREAT ${Math.round(computeJudgeWindow(judgeTightness).great*1000)}ms / GOOD ${Math.round(computeJudgeWindow(judgeTightness).good*1000)}ms
      </div>
      <div class="row" style="margin-top:8px; align-items:center">
        <label style="min-width:8em">並び替え</label>
        <select id="sort-select">
          <option value="added" ${selectedSort==='added'?'selected':''}>追加順</option>
          <option value="name" ${selectedSort==='name'?'selected':''}>名前</option>
          <option value="recent" ${selectedSort==='recent'?'selected':''}>最近プレイ</option>
          <option value="best" ${selectedSort==='best'?'selected':''}>ベスト(選択難易度)</option>
        </select>
        <button id="sortdir-toggle" class="secondary">${selectedSortDir==='asc'?'昇順':'降順'}</button>
      </div>
      <div class="row" style="margin-top:8px; align-items:center">
        <label style="min-width:8em">フィルタ</label>
        <select id="filter-select">
          <option value="all" ${selectedFilter==='all'?'selected':''}>すべて</option>
          <option value="hasBest" ${selectedFilter==='hasBest'?'selected':''}>ベストあり</option>
          <option value="unplayed" ${selectedFilter==='unplayed'?'selected':''}>未プレイ</option>
        </select>
      </div>
      <div class="row" style="margin-top:8px; align-items:center">
        <label style="min-width:8em">検索</label>
        <input id="search-input" type="text" placeholder="曲名で検索" value="${escapeHtml(searchQuery||'')}" style="flex:1; min-width: 200px;" />
      </div>
      <div class="row" style="margin-top:12px; align-items:center">
        <label style="min-width:8em">自動調整</label>
        <button id="calib-toggle" class="secondary">${calibrator.active ? '閉じる' : 'オフセット自動調整'}</button>
      </div>
      ${calibrator.active ? `
      <div class="card" style="margin-top:8px; position: relative;">
        <div style="margin-bottom:8px; color:#aab3c0">メトロノームに合わせて ${KEYS.join(' ')} を叩いてください。</div>
        <div class="row" style="margin-bottom:8px; align-items:center">
          <label style="min-width:6em">BPM</label>
          <input id="calib-bpm" type="number" min="40" max="240" step="1" value="${calibrator.bpm}" style="width:6em;" />
          <label style="margin-left:8px;">拍数</label>
          <select id="calib-countsel" style="width:6em;">
            ${[8,16,32,64].map(n=>`<option value="${n}" ${calibrator.target===n?'selected':''}>${n}</option>`).join('')}
          </select>
          <button id="calib-start">開始</button>
          <button id="calib-stop" class="secondary">停止</button>
          <button id="calib-clear" class="secondary">クリア</button>
        </div>
        <div class="row" style="color:#aab3c0; margin-bottom:6px">
          <div>進行: <b id="calib-prog">—</b></div>
        </div>
        <canvas id="calib-spark" style="width:100%; height:70px; background: rgba(255,255,255,0.03); border-radius:8px;" height="70"></canvas>
        <div class="row" style="color:#aab3c0; margin-bottom:6px">
          <div>サンプル: <b id="calib-count">${calibrator.deltas.length}</b></div>
          <div>平均偏差: <b id="calib-avg">${formatMs(avgSigned(calibrator.deltas))}</b></div>
          <div>推奨オフセット: <b id="calib-rec">${formatMs(recommendOffset(calibrator.deltas))}</b></div>
        </div>
        <div class="row">
          <button id="calib-apply">推奨を反映</button>
        </div>
      </div>
      `: ''}
      <div class="list" id="track-list"></div>
    `;
    $app.appendChild(panel);

    const $input = panel.querySelector('#file-input');
    const $drop = panel.querySelector('#drop');
    const $btn = panel.querySelector('#file-button');
    const $list = panel.querySelector('#track-list');
    const $startGlobal = panel.querySelector('#start-global');
    const $urlInput = panel.querySelector('#url-input');
    const $urlAdd = panel.querySelector('#url-add');
    const $shareCopy = panel.querySelector('#share-copy');
    const $range = panel.querySelector('#offset-range');
    const $label = panel.querySelector('#offset-label');
    const $reset = panel.querySelector('#offset-reset');
    const $beat = panel.querySelector('#beat-toggle');
    const $jw = panel.querySelectorAll('.jw-btn');
    const $sort = panel.querySelector('#sort-select');
    const $sortDir = panel.querySelector('#sortdir-toggle');
    const $filter = panel.querySelector('#filter-select');
    const $search = panel.querySelector('#search-input');
    const $calibToggle = panel.querySelector('#calib-toggle');
    const $calibBpm = panel.querySelector('#calib-bpm');
    const $calibCountSel = panel.querySelector('#calib-countsel');
    const $calibStart = panel.querySelector('#calib-start');
    const $calibStop = panel.querySelector('#calib-stop');
    const $calibClear = panel.querySelector('#calib-clear');
    const $calibApply = panel.querySelector('#calib-apply');
    const $optAuto = document.createElement('button');
    $optAuto.className = 'secondary';
    $optAuto.textContent = `AUTO: ${autoplay ? 'ON' : 'OFF'}`;
    const $optHs = document.createElement('button');
    $optHs.className = 'secondary';
    $optHs.textContent = `HITSOUND: ${hitSound ? 'ON' : 'OFF'}`;
    const $optMiss = document.createElement('button');
    $optMiss.className = 'secondary';
    $optMiss.textContent = `MISSSOUND: ${missSound ? 'ON' : 'OFF'}`;
    const $optJg = document.createElement('button');
    $optJg.className = 'secondary';
    $optJg.textContent = `JUDGE: ${showJudgeGuides ? 'ON' : 'OFF'}`;
    const $optBeat = document.createElement('button');
    $optBeat.className = 'secondary';
    $optBeat.textContent = `GUIDE: ${guideBeat ? 'ON' : 'OFF'}`;
    const $optTheme = document.createElement('button');
    $optTheme.className = 'secondary';
    $optTheme.textContent = `THEME: ${theme.toUpperCase()}`;
    const $optBgm = document.createElement('button');
    $optBgm.className = 'secondary';
    $optBgm.textContent = `BGM: ${bgmMode ? 'ON' : 'OFF'}`;
    const $optMusicLabel = document.createElement('label');
    $optMusicLabel.textContent = '音量(曲)';
    const $optMusic = document.createElement('input');
    $optMusic.type = 'range'; $optMusic.min = 0; $optMusic.max = 100; $optMusic.value = Math.round(musicVol*100);
    const $optFs = document.createElement('button');
    $optFs.className = 'secondary';
    $optFs.textContent = `FULLSCREEN: ${document.fullscreenElement?'ON':'OFF'}`;
    const $optGuideLabel = document.createElement('label');
    $optGuideLabel.textContent = 'ガイド音量';
    const $optGuide = document.createElement('input');
    $optGuide.type = 'range'; $optGuide.min = 0; $optGuide.max = 100; $optGuide.value = Math.round(guideVol*100);
    const $optLabel = document.createElement('label');
    $optLabel.textContent = '音量';
    const $optVol = document.createElement('input');
    $optVol.type = 'range'; $optVol.min = 0; $optVol.max = 100; $optVol.value = Math.round(hitSoundVol*100);
    const optRow = document.createElement('div');
    optRow.className = 'row';
    optRow.style.marginTop = '8px';
    optRow.style.alignItems = 'center';
    const optTitle = document.createElement('div');
    optTitle.style.minWidth = '8em';
    optTitle.style.color = '#aab3c0';
    optTitle.textContent = 'オプション';
    optRow.appendChild(optTitle);
    optRow.appendChild($optAuto);
    optRow.appendChild($optHs);
    optRow.appendChild($optMiss);
    optRow.appendChild($optJg);
    optRow.appendChild($optBeat);
    optRow.appendChild($optTheme);
    optRow.appendChild($optBgm);
    optRow.appendChild($optLabel);
    optRow.appendChild($optVol);
    optRow.appendChild($optMusicLabel);
    optRow.appendChild($optMusic);
    optRow.appendChild($optFs);
    optRow.appendChild($optGuideLabel);
    optRow.appendChild($optGuide);
    panel.appendChild(optRow);

    panel.querySelectorAll('.diff-btn').forEach(b => {
      b.onclick = () => {
        selectedDifficulty = b.dataset.diff;
        saveSettings();
        renderUI();
      };
    });

    $btn.onclick = () => $input.click();
    $input.onchange = (e) => handleFiles(e.target.files);

    if ($urlAdd) $urlAdd.onclick = async () => {
      const url = ($urlInput?.value||'').trim();
      if (!url) return;
      $urlAdd.disabled = true;
      try { await handleUrlAdd(url); $urlInput.value = ''; } finally { $urlAdd.disabled = false; }
    };
    if ($shareCopy) $shareCopy.onclick = async () => {
      try {
        const link = buildShareLink(tracks);
        await navigator.clipboard.writeText(link);
        alert('共有リンクをコピーしました');
      } catch {
        const ta = document.createElement('textarea'); ta.value = buildShareLink(tracks); document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        alert('共有リンクをコピーしました');
      }
    };

    if ($startGlobal) $startGlobal.onclick = () => {
      if (!selectedTrackId) return;
      const t = tracks.find(x=>x.id===selectedTrackId);
      if (!t) return;
      startPlay(selectedTrackId, selectedDifficulty);
    };

    $range.oninput = () => { timingOffsetMs = parseInt($range.value, 10) || 0; $label.textContent = `${timingOffsetMs} ms`; saveSettings(); };
    $reset.onclick = () => { timingOffsetMs = 0; $range.value = 0; $label.textContent = '0 ms'; saveSettings(); };
    $beat.onclick = () => { showBeatGuide = !showBeatGuide; saveSettings(); renderUI(); };
    $jw.forEach(b => b.onclick = () => { judgeTightness = b.dataset.jw; saveSettings(); renderUI(); });
    $sort.onchange = () => { selectedSort = $sort.value; saveSettings(); renderUI(); };
    if ($sortDir) $sortDir.onclick = () => { selectedSortDir = (selectedSortDir==='asc'?'desc':'asc'); saveSettings(); renderUI(); };
    $filter.onchange = () => { selectedFilter = $filter.value; saveSettings(); renderUI(); };
    if ($search) $search.oninput = () => { searchQuery = $search.value || ''; saveSettings(); renderUI(); };
    if ($calibToggle) $calibToggle.onclick = () => { calibrator.active = !calibrator.active; renderUI(); };
    if ($calibBpm) $calibBpm.onchange = () => { const v = parseInt($calibBpm.value,10); if (!isNaN(v)) calibrator.bpm = Math.max(40, Math.min(240, v)); };
    if ($calibCountSel) $calibCountSel.onchange = () => { const v = parseInt($calibCountSel.value,10); if(!isNaN(v)) calibrator.target = v; };
    if ($calibStart) $calibStart.onclick = () => startCalibrationBeats(calibrator.target||16);
    if ($calibStop) $calibStop.onclick = () => stopCalibration();
    if ($calibClear) $calibClear.onclick = () => { calibrator.deltas = []; renderUI(); };
    if ($calibApply) $calibApply.onclick = () => {
      const rec = recommendOffset(calibrator.deltas);
      if (rec != null) {
        timingOffsetMs = Math.round(rec);
        saveSettings();
        if ($range) { $range.value = timingOffsetMs; $label.textContent = `${timingOffsetMs} ms`; }
        renderUI();
      }
    };
    $optAuto.onclick = () => { autoplay = !autoplay; saveSettings(); renderUI(); };
    $optHs.onclick = () => { hitSound = !hitSound; saveSettings(); renderUI(); };
    $optMiss.onclick = () => { missSound = !missSound; saveSettings(); renderUI(); };
    $optJg.onclick = () => { showJudgeGuides = !showJudgeGuides; saveSettings(); renderUI(); };
    $optBeat.onclick = () => { guideBeat = !guideBeat; saveSettings(); renderUI(); };
    $optTheme.onclick = () => { theme = (theme==='dark'?'light':'dark'); applyTheme(); saveSettings(); renderUI(); };
    $optBgm.onclick = () => { bgmMode = !bgmMode; saveSettings(); renderUI(); };
    $optVol.oninput = () => { hitSoundVol = Math.max(0, Math.min(1, ($optVol.value|0)/100)); saveSettings(); };
    $optMusic.oninput = () => { musicVol = Math.max(0, Math.min(1, ($optMusic.value|0)/100)); if (play?.gain) play.gain.gain.value = musicVol; saveSettings(); };
    $optFs.onclick = () => { toggleFullscreen(); renderUI(); };
    $optGuide.oninput = () => { guideVol = Math.max(0, Math.min(1, ($optGuide.value|0)/100)); saveSettings(); };

    ['dragenter','dragover'].forEach(type => $drop.addEventListener(type, (e)=>{
      e.preventDefault(); e.stopPropagation(); $drop.classList.add('dragover');
    }));
    ['dragleave','drop'].forEach(type => $drop.addEventListener(type, (e)=>{
      e.preventDefault(); e.stopPropagation(); $drop.classList.remove('dragover');
      if (type==='drop') handleFiles(e.dataTransfer.files);
    }));

    // Calibration progress + sparkline
    const $prog = panel.querySelector('#calib-prog');
    const $spark = panel.querySelector('#calib-spark');
    if ($prog) {
      try{
        const ac = ensureAudioContext();
        const done = (calibrator.beatTimes||[]).filter(t=>t<=ac.currentTime).length;
        const total = calibrator.beatTimes?.length || (calibrator.target||0);
        $prog.textContent = calibrator.running ? `${done} / ${total}` : '—';
      }catch{ $prog.textContent = '—'; }
    }
    if ($spark) drawCalibSparkline($spark, calibrator.deltas||[]);

    // filter + sort view
    const filtered = filterTracks(tracks, selectedFilter, selectedDifficulty, stats, searchQuery);
    const sorted = sortTracks([...filtered], selectedSort, selectedDifficulty, stats, selectedSortDir);
    // Undo banner for last-deleted track
    if (lastDeleted && lastDeleted.until > Date.now()) {
      const $undo = document.createElement('div');
      $undo.className = 'card';
      $undo.style.marginTop = '8px';
      $undo.style.display = 'flex';
      $undo.style.alignItems = 'center';
      $undo.style.justifyContent = 'space-between';
      const nm = lastDeleted.track?.name ? escapeHtml(lastDeleted.track.name) : '曲';
      $undo.innerHTML = `<div class="muted">「${nm}」を削除しました。</div>`;
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = '元に戻す';
      btn.onclick = () => {
        const t = lastDeleted.track; const idx = lastDeleted.index|0;
        if (t) {
          if (idx >= 0 && idx <= tracks.length) tracks.splice(idx, 0, t); else tracks.push(t);
        }
        lastDeleted = null;
        renderUI();
      };
      $undo.appendChild(btn);
      panel.appendChild($undo);
    } else {
      lastDeleted = null;
    }
    // restore previous scroll position
    if (selectScrollTop) { $list.scrollTop = selectScrollTop; }
    $list.addEventListener('scroll', () => { selectScrollTop = $list.scrollTop; });
    let focusTarget = null;
    for (const t of sorted) {
      const meta = stats[t.key] || {};
      const card = document.createElement('div');
      card.className = 'card clickable';
      card.style.position = 'relative';
      card.innerHTML = `
        <button class="close" title="一覧から削除" aria-label="この曲をリストから削除">×</button>
        <div class="card-title">${escapeHtml(t.name)}</div>
        <div class="muted" style="margin:6px 0">${t.type} • ${formatDuration(t.duration)} ${meta.bpm ? `• BPM ${meta.bpm}` : ''}</div>
        ${meta.best && meta.best[selectedDifficulty] ? `<div class=\"mono\" style=\"color:#93ffa7; font-size:13px;\">Best(${selectedDifficulty}) Score ${meta.best[selectedDifficulty].score} / ${meta.best[selectedDifficulty].acc.toFixed(1)}% • MaxCombo ${meta.best[selectedDifficulty].combo||0}</div>`: `<div class=\"muted\">未プレイ (${selectedDifficulty})</div>`}
        ${meta.lastPlayedDifficulty ? `<div class="muted">最近: ${meta.lastPlayedDifficulty}</div>` : ''}
      `;
      
      // Selection-based start flow: select card, then press global START
      const $close = card.querySelector('.close');
      $close.onclick = (ev) => {
        ev.stopPropagation();
        const ok = confirm(`「${t.name}」を一覧から削除しますか？`);
        if (ok) {
          const idx = tracks.findIndex(x => x.id === t.id);
          const removed = tracks.splice(idx, 1)[0];
          lastDeleted = { track: removed, index: idx, until: Date.now() + 5000 };
          renderUI();
        }
      };
      card.tabIndex = 0;
      const selectThis = () => { selectedTrackId = t.id; lastTrackKey = t.key||null; saveSettings(); renderUI(); };
      card.addEventListener('click', (e)=>{
        if (!(e.target instanceof HTMLButtonElement)) selectThis();
      });
      card.addEventListener('keydown', (e)=>{
        if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); selectThis(); return; }
        // Arrow key navigation between cards
        const items = Array.from($list.querySelectorAll('.card'));
        const idx = items.indexOf(card);
        if (idx === -1) return;
        const cols = Math.max(1, Math.round($list.clientWidth / (items[0].clientWidth+12)));
        if (e.code === 'ArrowRight') { e.preventDefault(); (items[idx+1]||items[idx]).focus(); }
        if (e.code === 'ArrowLeft') { e.preventDefault(); (items[idx-1]||items[idx]).focus(); }
        if (e.code === 'ArrowDown') { e.preventDefault(); (items[idx+cols]||items[items.length-1]).focus(); }
        if (e.code === 'ArrowUp') { e.preventDefault(); (items[idx-cols]||items[0]).focus(); }
        if (e.code === 'Home') { e.preventDefault(); items[0]?.focus(); }
        if (e.code === 'End') { e.preventDefault(); items[items.length-1]?.focus(); }
      });
      if ((lastTrackKey && t.key === lastTrackKey) || (selectedTrackId && t.id === selectedTrackId)) { card.classList.add('selected'); focusTarget = card; }
      $list.appendChild(card);
    }
    // Focus last selected track if present
    if (focusTarget) { setTimeout(()=> focusTarget.focus(), 0); }
    return;
  }

  if (gameState === STATE.RESULT && play) {
    const p = play; // last play state snapshot
    const acc = computeAccuracy(p);
    const { avgAbsMs, avgSignedMs } = computeErrorStats(p);
    const hint = suggestOffsetHint(avgSignedMs);
    const meta = (p.track && p.track.key) ? (stats[p.track.key] || {}) : {};
    const best = meta.best && meta.best[p.difficulty] ? meta.best[p.difficulty] : null;
    const isNewBest = best ? (p.score > best.score) : true;
    // Persist best stats per difficulty
    try {
      if (p.track && p.track.key) {
        stats[p.track.key] = stats[p.track.key] || { name: p.track.name, duration: p.track.duration, bpm: p.bpm || null, best: {} };
        const prev = stats[p.track.key].best[p.difficulty] || { score: 0, acc: 0, combo: 0 };
        if (p.score > prev.score) {
          // store expanded best including judgeCount for future comparisons
          stats[p.track.key].best[p.difficulty] = { score: p.score, acc: acc, combo: p.maxCombo, judgeCount: { ...p.judgeCount } };
        }
        // Always update last played info
        stats[p.track.key].lastPlayedAt = Date.now();
        stats[p.track.key].lastPlayedDifficulty = p.difficulty;
        if (!stats[p.track.key].bpm && p.bpm) stats[p.track.key].bpm = p.bpm;
        if (!stats[p.track.key].duration) stats[p.track.key].duration = p.track.duration;
        saveStats();
      }
    } catch (e) { console.warn('save stats failed', e); }
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="title">リザルト</div>
      <div class="result-title">${escapeHtml(p.track?.name || '')}</div>
      <div class="result-sub">${p.bpm ? `BPM ${p.bpm} • ` : ''}難易度 ${p.difficulty}</div>
      <div class="stats" style="margin: 8px 0 16px">
        <div class="mono">スコア: <b>${p.score}</b></div>
        <div class="mono">最大COMBO: <b>${p.maxCombo}</b></div>
        <div class="mono">PERFECT: <b>${p.judgeCount.PERFECT}</b></div>
        <div class="mono">GREAT: <b>${p.judgeCount.GREAT}</b></div>
        <div class="mono">GOOD: <b>${p.judgeCount.GOOD}</b></div>
      </div>
      <div class="stats" style="margin: 8px 0 16px">
        <div class="mono">精度率: <b>${acc.toFixed(2)}%</b></div>
        <div class="mono">平均誤差: <b>${avgAbsMs.toFixed(1)} ms</b></div>
        <div class="mono">平均偏差: <b>${avgSignedMs.toFixed(1)} ms</b></div>
        <div class="result-sub" style="grid-column: span 2;">${hint}</div>
      </div>
      <div class="result-rank" style="margin-bottom:8px">RANK: ${rankFromScore(p.score, p.maxScore)} ${isNewBest ? '<span class="muted" style="font-size:14px; color:#93ffa7">NEW BEST!</span>' : ''}</div>
      ${best ? (()=>{ const dS=p.score-best.score; const dA=acc-(best.acc||0); const dC=(p.maxCombo-(best.combo||0));
        const sign=(v)=> (v>0?'+':'');
        const judgeBest = best.judgeCount || null;
        const judgeCur = p.judgeCount || {PERFECT:0,GREAT:0,GOOD:0,MISS:0};
        const judgeDiff = judgeBest ? `
          <div class=\"muted mono\" style=\"margin:4px 0 8px\">判定差分: 
            PERFECT <b style=\"color:${(judgeCur.PERFECT-(judgeBest.PERFECT||0))>=0?'#93ffa7':'#ff9b9b'}\">${sign(judgeCur.PERFECT-(judgeBest.PERFECT||0))}${judgeCur.PERFECT-(judgeBest.PERFECT||0)}</b> /
            GREAT <b style=\"color:${(judgeCur.GREAT-(judgeBest.GREAT||0))>=0?'#93ffa7':'#ff9b9b'}\">${sign(judgeCur.GREAT-(judgeBest.GREAT||0))}${judgeCur.GREAT-(judgeBest.GREAT||0)}</b> /
            GOOD <b style=\"color:${(judgeCur.GOOD-(judgeBest.GOOD||0))>=0?'#93ffa7':'#ff9b9b'}\">${sign(judgeCur.GOOD-(judgeBest.GOOD||0))}${judgeCur.GOOD-(judgeBest.GOOD||0)}</b> /
            MISS <b style=\"color:${(judgeCur.MISS-(judgeBest.MISS||0))>=0?'#93ffa7':'#ff9b9b'}\">${sign(judgeCur.MISS-(judgeBest.MISS||0))}${judgeCur.MISS-(judgeBest.MISS||0)}</b>
          </div>` : '';
        return `<div class=\"mono\" style=\"margin-bottom:6px\">Best(${p.difficulty}) Score ${best.score} / ${best.acc.toFixed(1)}% • MaxCombo ${best.combo||0}</div>
                <div class=\"muted mono\" style=\"margin-bottom:4px\">差分: Score <b style=\"color:${dS>=0?'#93ffa7':'#ff9b9b'}\">${sign(dS)}${dS}</b> / Acc <b style=\"color:${dA>=0?'#93ffa7':'#ff9b9b'}\">${dA>=0?'+':''}${Math.abs(dA).toFixed(1)}%</b> / MaxCombo <b style=\"color:${dC>=0?'#93ffa7':'#ff9b9b'}\">${sign(dC)}${dC}</b></div>` + judgeDiff; })() : ''}
      <div class="row">
        <button id="retry-btn">もう一度プレイ</button>
        <button id="back-btn" class="secondary">曲選択に戻る</button>
        <button id="copy-btn" class="secondary">結果をコピー</button>
        <button id="export-btn" class="secondary">JSONエクスポート</button>
        <button id="saveimg-btn" class="secondary">画像を保存</button>
        <label style="margin-left:8px">画像サイズ</label>
        <select id="img-size">
          ${['1600x900','1200x675','1080x1920'].map(s=>`<option value="${s}" ${exportSize===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
    `;
    $app.appendChild(panel);
    document.getElementById('retry-btn').onclick = () => startPlay(p.track.id, p.difficulty);
    document.getElementById('back-btn').onclick = () => setState(STATE.SELECT);
    const $copy = document.getElementById('copy-btn');
    const $export = document.getElementById('export-btn');
    const $saveimg = document.getElementById('saveimg-btn');
    const $imgSize = document.getElementById('img-size');
    if ($copy) $copy.onclick = async () => {
      try {
        const txt = buildResultSummaryText(p, best, acc, avgAbsMs, avgSignedMs);
        await navigator.clipboard.writeText(txt);
        alert('結果をクリップボードにコピーしました');
      } catch {
        const ta = document.createElement('textarea'); ta.value = buildResultSummaryText(p, best, acc, avgAbsMs, avgSignedMs); document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        alert('結果をクリップボードにコピーしました');
      }
    };
    if ($export) $export.onclick = () => {
      try {
        const obj = buildResultSummaryJSON(p, best, acc, avgAbsMs, avgSignedMs);
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const base = (p.track?.name||'result').replace(/[^\w\-]+/g,'_');
        a.href = url; a.download = `${base}_${p.difficulty}_result.json`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch {}
    };
    if ($imgSize) $imgSize.onchange = () => { exportSize = $imgSize.value || '1600x900'; saveSettings(); };
    if ($saveimg) $saveimg.onclick = () => {
      try {
        const {w:hW, h:hH} = parseSize(exportSize);
        const sz = parseSize(exportSize);
        const url = exportResultImage(p, best, acc, avgAbsMs, avgSignedMs, sz.w, sz.h);
        const a = document.createElement('a');
        const base = (p.track?.name||'result').replace(/[^\w\-]+/g,'_');
        a.href = url; a.download = `${base}_${p.difficulty}_result_${exportSize}.png`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      } catch {
        // fallback: raw canvas
        try {
          const c = document.getElementById('game-canvas');
          const url = c.toDataURL('image/png');
          const a = document.createElement('a');
          const base = (p.track?.name||'result').replace(/[^\w\-]+/g,'_');
          a.href = url; a.download = `${base}_${p.difficulty}_result_${exportSize}.png`;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
        } catch {}
      }
    };
    return;
  }
}

function computeAccuracy(p){
  if (!p || !p.maxScore) return 0;
  return (p.score / p.maxScore) * 100;
}
function computeErrorStats(p){
  const errs = (p && p.hitErrors) ? p.hitErrors : [];
  if (!errs.length) return { avgAbsMs: 0, avgSignedMs: 0 };
  let sumAbs = 0, sum = 0;
  for (const d of errs){ sum += d; sumAbs += Math.abs(d); }
  const avgAbsMs = (sumAbs/errs.length)*1000;
  const avgSignedMs = (sum/errs.length)*1000;
  return { avgAbsMs, avgSignedMs };
}
function buildResultSummaryText(p, best, acc, avgAbsMs, avgSignedMs){
  const title = p.track?.name || '';
  const rank = rankFromScore(p.score, p.maxScore);
  const bestLine = best ? `Best(${p.difficulty}) Score ${best.score} / ${best.acc.toFixed(1)}% / MaxCombo ${best.combo||0}` : 'Best: —';
  return [
    `Otogame 結果`,
    `曲: ${title}`,
    `難易度: ${p.difficulty}${p.bpm?` / BPM ${p.bpm}`:''}`,
    `スコア: ${p.score} / ランク: ${rank}`,
    `最大COMBO: ${p.maxCombo}`,
    `精度率: ${acc.toFixed(2)}% / 平均誤差: ${avgAbsMs.toFixed(1)}ms / 平均偏差: ${avgSignedMs.toFixed(1)}ms`,
    bestLine,
  ].join('\n');
}
function buildResultSummaryJSON(p, best, acc, avgAbsMs, avgSignedMs){
  return {
    title: p.track?.name || '',
    difficulty: p.difficulty,
    bpm: p.bpm || null,
    score: p.score,
    rank: rankFromScore(p.score, p.maxScore),
    maxCombo: p.maxCombo,
    accuracy: acc,
    avgAbsMs, avgSignedMs,
    judgeCount: p.judgeCount,
    best: best || null,
    timestamp: Date.now(),
  };
}
function suggestOffsetHint(avgSignedMs){
  const th = 10; // ms
  if (avgSignedMs > th) return `平均的に遅めです。オフセットを${Math.round(avgSignedMs)}msだけマイナス方向へ調整すると改善します。`;
  if (avgSignedMs < -th) return `平均的に早めです。オフセットを${Math.round(-avgSignedMs)}msだけプラス方向へ調整すると改善します。`;
  return 'オフセットは概ね良好です。';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function handleFiles(fileList) {
  const ac = ensureAudioContext();
  for (const file of fileList) {
    if (!file.type.startsWith('audio/')) continue;
    const id = Math.random().toString(36).slice(2);
    const arrayBuffer = await file.arrayBuffer();
    const key = await computeTrackKey(file, arrayBuffer);
    let audioBuffer;
    try {
      audioBuffer = await ac.decodeAudioData(arrayBuffer.slice(0));
    } catch (e) {
      console.warn('decode error', e);
      continue;
    }
    const track = {
      id,
      name: file.name,
      type: file.type || 'audio',
      file,
      arrayBuffer,
      audioBuffer,
      duration: audioBuffer.duration,
      key,
      addedAt: Date.now(),
    };
    tracks.push(track);
    // Analyze BPM using worker (fallback to inline)
    try {
      const mono = mixToMono(audioBuffer);
      const head = mono.subarray(0, Math.min(mono.length, Math.floor(audioBuffer.sampleRate * 60)));
      const bpm = await analyzeBPMWithWorker(head, audioBuffer.sampleRate);
      if (bpm) {
        stats[key] = stats[key] || { name: track.name, best: {} };
        stats[key].name = track.name;
        stats[key].duration = track.duration;
        stats[key].bpm = bpm;
        saveStats();
      }
    } catch (e) { console.warn('worker analyze failed', e); try { const bpm = quickAnalyzeBPM(audioBuffer); if (bpm){ stats[key]=stats[key]||{name:track.name,best:{}}; stats[key].name=track.name; stats[key].duration=track.duration; stats[key].bpm=bpm; saveStats(); } } catch {} }
  }
  renderUI();
}

async function handleUrlAdd(url) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    const ac = ensureAudioContext();
    const audioBuffer = await ac.decodeAudioData(arrayBuffer.slice(0));
    const id = Math.random().toString(36).slice(2);
    const key = await computeTrackKeyFromUrl(url, arrayBuffer);
    const name = guessNameFromResponse(url, res.headers) || url.split('/').pop() || 'track';
    const track = { id, name, type: 'audio/url', file: null, arrayBuffer, audioBuffer, duration: audioBuffer.duration, key, sourceUrl: url, addedAt: Date.now() };
    tracks.push(track);
    // Quick BPM fill-in
    try {
      const bpm = quickAnalyzeBPM(audioBuffer);
      if (bpm) {
        stats[key] = stats[key] || { name: track.name, best: {} };
        stats[key].name = track.name; stats[key].duration = track.duration; stats[key].bpm = bpm; saveStats();
      }
    } catch {}
    renderUI();
  } catch (e) {
    alert(`URLの追加に失敗しました: ${e?.message||e}.\n公開音源かつCORSが許可されたURLか確認してください。`);
  }
}

function guessNameFromResponse(url, headers) {
  try {
    const cd = headers.get && headers.get('content-disposition');
    if (cd) {
      const m = cd.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
      const raw = decodeURIComponent((m && (m[1]||m[2]||'')).trim());
      if (raw) return raw;
    }
  } catch {}
  try { const p = new URL(url); return decodeURIComponent(p.pathname.split('/').pop()||''); } catch {}
  return null;
}

async function computeTrackKeyFromUrl(url, arrayBuffer){
  const head = arrayBuffer.slice(0, Math.min(65536, arrayBuffer.byteLength));
  const view = new Uint8Array(head);
  let h = 5381;
  const name = String(url);
  for (let i=0;i<name.length;i++) h = ((h<<5) + h) ^ name.charCodeAt(i);
  for (let i=0;i<view.length;i++) h = ((h<<5) + h) ^ view[i];
  h = h >>> 0; return 'u' + h.toString(36);
}

function buildShareLink(tracks){
  const urls = tracks.filter(t=>t && t.sourceUrl).map(t=>({ url: t.sourceUrl, name: t.name||null }));
  if (!urls.length) { return location.href.split('#')[0]; }
  const payload = { v:1, urls };
  const json = JSON.stringify(payload);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return `${location.origin}${location.pathname}#share=${b64}`;
}

// ---------------- Gameplay & Chart Generation ----------------

function startPlay(trackId, difficulty, offsetSec = 0) {
  const track = tracks.find(t => t.id === trackId);
  if (!track) return;
  selectedTrackId = trackId;
  selectedDifficulty = difficulty;
  lastTrackKey = track.key || null;
  saveSettings();
  setState(STATE.PLAY);
  const ac = ensureAudioContext();
  try { if (ac.state !== 'running') { ac.resume && ac.resume(); } } catch {}

  // Generate chart from buffer
  const { chart, bpm, phi } = generateChart(track.audioBuffer, difficulty);

  // Create source
  const src = ac.createBufferSource();
  src.buffer = track.audioBuffer;
  const gain = ac.createGain();
  gain.gain.value = Math.max(0, Math.min(1, musicVol));
  src.connect(gain).connect(ac.destination);

  const travelTime = 1.6; // seconds for note to travel top->line
  const leadIn = 2.5; // visible countdown
  const startAt = ac.currentTime + leadIn;
  const startOffset = Math.max(0, Math.min(track.audioBuffer.duration - 0.01, offsetSec || 0));
  try { src.start(startAt, startOffset); } catch { src.start(startAt); }

  play = createPlayRuntime(track, chart, startAt, travelTime, difficulty);
  play.bpm = bpm;
  play.beatPhi = phi || 0;
  play.guideIndex = 0;
  play.src = src;
  play.gain = gain;
  play.offsetStart = startOffset;
  if (bpm) {
    const period = 60 / bpm;
    play.guidePeriod = period;
    // find first k such that k*period+phi >= 0
    play.guideIndex = Math.ceil(((startOffset||0) - play.beatPhi) / period);
  } else {
    play.guidePeriod = null;
  }
  // Pre-fill stats BPM if detected
  try {
    if (track.key) {
      stats[track.key] = stats[track.key] || { name: track.name, duration: track.duration, best: {} };
      if (!stats[track.key].bpm && bpm) { stats[track.key].bpm = bpm; saveStats(); }
    }
  } catch {}
}

function createPlayRuntime(track, chart, startAt, travelTime, difficulty) {
  const runtime = {
    track,
    difficulty,
    startAt,
    travelTime,
    chart, // [{time, lane, type:'tap'}]
    hits: new Set(), // indices of notes judged
    misses: new Set(),
    score: 0,
    maxScore: chart.length * 1000 + chart.filter(n=>n.type==='hold').length * 500,
    combo: 0,
    maxCombo: 0,
    judgeCount: { PERFECT:0, GREAT:0, GOOD:0, MISS:0 },
    lastJudge: '',
    lastJudgeAt: 0,
    keyStates: new Array(KEYS.length).fill(false),
    done: false,
    paused: false,
    effects: [], // hit visual effects
    bpm: null,
    window: computeJudgeWindow(judgeTightness),
    hitErrors: [], // signed seconds for judged hits
    // Hold-related state
    holdActive: new Array(KEYS.length).fill(null), // idx of active hold per lane
    holdCompleted: new Set(),
    holdHeadJudged: new Set(),
    // Visuals
    laneFlashLevels: new Array(KEYS.length).fill(0),
    laneFlashColor: new Array(KEYS.length).fill('rgba(155,210,255,1)'),
    shakeUntil: 0,
    // Beat guide
    beatPhi: 0,
    guidePeriod: null,
    guideIndex: 0,
    src: null,
    gain: null,
    duration: track?.audioBuffer?.duration || 0,
    toast: null,
    hitLog: [], // [{t, err, lane, judge}]
  };
  return runtime;
}

function computeJudgeWindow(mode) {
  // base windows (seconds): PERFECT 40ms, GREAT 80ms, GOOD 120ms
  const base = { perfect: 0.040, great: 0.080, good: 0.120 };
  let mul = 1.0;
  if (mode === 'NARROW') mul = 0.8;
  else if (mode === 'WIDE') mul = 1.25;
  return { perfect: base.perfect*mul, great: base.great*mul, good: base.good*mul };
}

function rankFromScore(score, maxScore) {
  const rate = maxScore === 0 ? 0 : score / maxScore;
  if (rate >= 0.95) return 'S';
  if (rate >= 0.90) return 'A';
  if (rate >= 0.80) return 'B';
  if (rate >= 0.70) return 'C';
  return 'D';
}

// Basic chart generation using naive BPM + onset detection
function generateChart(audioBuffer, difficulty) {
  // If BGM mode, use a grid-based chart for robust playability
  if (bgmMode) {
    const bpmGuess = quickAnalyzeBPM(audioBuffer) || 120;
    const gc = generateGridChart(audioBuffer, difficulty, bpmGuess);
    return { chart: gc.chart, bpm: gc.bpm, phi: 0 };
  }
  const sampleRate = audioBuffer.sampleRate;
  const data = mixToMono(audioBuffer);

  // Compute spectral flux-like onset curve (energy difference in short frames)
  const frameSize = 1024;
  const hopSize = 512;
  const flux = [];
  let prevMag = null;
  const window = hann(frameSize);
  const fft = new FFT(frameSize);
  for (let i = 0; i + frameSize < data.length; i += hopSize) {
    const frame = data.subarray(i, i + frameSize);
    const w = applyWindow(frame, window);
    const spec = fft.magnitude(w);
    if (prevMag) {
      let sum = 0;
      for (let k = 0; k < spec.length; k++) {
        const diff = spec[k] - prevMag[k];
        if (diff > 0) sum += diff;
      }
      flux.push(sum);
    } else {
      flux.push(0);
    }
    prevMag = spec;
  }
  // Normalize and pick peaks (with light smoothing)
  const normFlux = normalize(flux);
  const smFlux = smooth1D(normFlux, 3);
  const fpsFlux = sampleRate / hopSize;
  // Rough BPM via autocorrelation on flux (do before peak picking for parameters)
  const bpm = estimateBPM(normFlux, sampleRate / hopSize);
  const { thr, nb, minGap } = computePeakParams(smFlux, bpm, fpsFlux);
  let peakIndices = pickPeaks(smFlux, thr, nb); // threshold, neighborhood
  // Enforce minimum gap between peaks to avoid over-dense detections
  if (minGap > 0 && peakIndices.length) {
    const filtered = [];
    let last = -1e9;
    for (const i of peakIndices) {
      if (i - last >= minGap) { filtered.push(i); last = i; }
    }
    peakIndices = filtered;
  }
  let onsetTimes = peakIndices.map(i => (i * hopSize) / sampleRate);

  // Align intro phase (empty beats) to beat grid if BPM is known
  let phi = 0;
  if (bpm && onsetTimes.length) {
    const align = computeBeatAlignmentOffset(onsetTimes, bpm);
    if (isFinite(align) && Math.abs(align) <= 1.5) { // cap excessive shift
      onsetTimes = onsetTimes.map(t => t - align);
      phi = align;
      const tmin = Math.min(...onsetTimes);
      if (tmin < 0) { const shift = -tmin; onsetTimes = onsetTimes.map(t => t + shift); }
    }
  }

  // Difficulty parameters
  const params = getGenParams(difficulty);
  const density = params.density;
  const gridWeights = bpm ? adjustedGridWeights(onsetTimes, bpm, params.gridWeights, difficulty) : params.gridWeights;
  const selectedOnsets = onsetTimes.filter((t, idx) => (idx % Math.max(1, Math.round(1/density + 0.5))) === 0);

  // Build notes with constraints
  const chart = [];
  const lastLaneTime = new Array(KEYS.length).fill(-1e9);
  let lastTimeEmitted = -1e9;
  let lastLane = -1;

  const minIntervalSec = params.minIntervalMs / 1000;
  const perLaneGap = params.perLaneMinMs / 1000;

  for (let i = 0; i < selectedOnsets.length; i++) {
    let t = selectedOnsets[i];
    // Quantize to mixed grid if BPM is detected
    if (bpm) t = quantizeToGrid(t, bpm, gridWeights, params.snapWindowMs/1000);

    // Global min interval
    if (t - lastTimeEmitted < minIntervalSec) continue;

    // Choose lane preferring change from last
    let baseLane = Math.floor(Math.abs(Math.sin(t * 97.31) * 10000)) % KEYS.length;
    if (baseLane === lastLane) baseLane = (baseLane + 1) % KEYS.length;
    if (t - lastLaneTime[baseLane] < perLaneGap) {
      // try another lane
      let tried = 0;
      while (tried < KEYS.length) {
        const alt = (baseLane + 1 + tried) % KEYS.length;
        if (t - lastLaneTime[alt] >= perLaneGap) { baseLane = alt; break; }
        tried++;
      }
      if (tried >= KEYS.length) continue; // no available lane respecting gap
    }

    // Try hold note (requires BPM)
    let placed = false;
    if (bpm && Math.random() < params.holdProb) {
      const period = 60 / bpm;
      const beats = randRange(params.holdMinBeats, params.holdMaxBeats);
      let end = t + beats * period;
      // Snap end to neat grid
      end = quantizeToGrid(end, bpm, { '1':0.0, '1/2':0.5, '1/3':0.0, '1/4':0.5 }, params.snapWindowMs/1000);
      if (end - t >= 0.35) {
        chart.push({ time: t, end, lane: baseLane, type: 'hold' });
        lastLaneTime[baseLane] = end; // block this lane until hold ends
        lastTimeEmitted = t;
        lastLane = baseLane;
        placed = true;
      }
    }

    if (!placed) {
      chart.push({ time: t, lane: baseLane, type: 'tap' });
      lastLaneTime[baseLane] = t;
      lastTimeEmitted = t;
      lastLane = baseLane;

      // Optional chord for taps only
      if (Math.random() < params.chordProb) {
        // pick a second lane different from base respecting per-lane gap
        const candidates = [];
        for (let l=0;l<KEYS.length;l++) if (l!==baseLane && (t - lastLaneTime[l] >= perLaneGap)) candidates.push(l);
        if (candidates.length) {
          const l2 = candidates[Math.floor(Math.random()*candidates.length)];
          chart.push({ time: t, lane: l2, type: 'tap' });
          lastLaneTime[l2] = t;
        }
      }
    }
  }

  // Reduce syncopation on lower difficulties then smooth bursts
  const syncReduced = (bpm && (difficulty !== 'HARD')) ? reduceSyncopation(chart, bpm) : chart;
  const smoothed = smoothBursts(syncReduced, params);
  // Sort by time then lane
  smoothed.sort((a,b)=> a.time===b.time ? a.lane-b.lane : a.time-b.time);
  // Fallback: if too sparse (e.g., ambient/BGM), synthesize a grid chart
  if (smoothed.length < 12) {
    const bpmGuess = bpm || quickAnalyzeBPM(audioBuffer) || 120;
    const gc = generateGridChart(audioBuffer, difficulty, bpmGuess);
    return { chart: gc.chart, bpm: gc.bpm, phi: 0 };
  }
  return { chart: smoothed, bpm, phi };
}

function generateGridChart(audioBuffer, difficulty, bpm) {
  const lanes = KEYS.length;
  const duration = audioBuffer.duration || 0;
  const bps = 60 / (bpm || 120);
  let stepBeats = 1.0;
  if (difficulty === 'NORMAL') stepBeats = 0.5; // 8th
  if (difficulty === 'HARD') stepBeats = 0.25;  // 16th
  const step = bps * stepBeats;
  const lead = 0.8; // avoid very beginning
  const tail = Math.max(0, duration - 0.8);
  const chart = [];
  let lane = 0;
  for (let t = lead; t < tail; t += step) {
    // alternate lanes to avoid repetition; add occasional chords on HARD
    lane = (lane + 1) % lanes;
    chart.push({ time: t, lane, type: 'tap' });
    if (difficulty === 'HARD' && Math.random() < 0.12) {
      const l2 = (lane + 3) % lanes;
      chart.push({ time: t, lane: l2, type: 'tap' });
    }
  }
  chart.sort((a,b)=> a.time===b.time ? a.lane-b.lane : a.time-b.time);
  return { chart, bpm: Math.round(bpm || 120) };
}

function getGenParams(difficulty) {
  if (difficulty === 'EASY') {
    return {
      density: 0.36,
      chordProb: 0.06,
      minIntervalMs: 200,
      perLaneMinMs: 240,
      snapWindowMs: 48,
      gridWeights: { '1':0.1, '1/2':0.6, '1/3':0.0, '1/4':0.3 },
      holdProb: 0.05,
      holdMinBeats: 1.0,
      holdMaxBeats: 2.0,
      burstWindowMs: 320,
      burstLimit: 2,
    };
  }
  if (difficulty === 'HARD') {
    return {
      density: 0.90,
      chordProb: 0.30,
      minIntervalMs: 120,
      perLaneMinMs: 170,
      snapWindowMs: 38,
      gridWeights: { '1':0.10, '1/2':0.35, '1/3':0.20, '1/4':0.35 },
      holdProb: 0.20,
      holdMinBeats: 1.0,
      holdMaxBeats: 3.0,
      burstWindowMs: 240,
      burstLimit: 3,
    };
  }
  // NORMAL
  return {
    density: 0.60,
    chordProb: 0.18,
    minIntervalMs: 160,
    perLaneMinMs: 200,
    snapWindowMs: 44,
    gridWeights: { '1':0.15, '1/2':0.50, '1/3':0.10, '1/4':0.25 },
    holdProb: 0.12,
    holdMinBeats: 1.0,
    holdMaxBeats: 2.5,
    burstWindowMs: 280,
    burstLimit: 3,
  };
}

function quantizeToGrid(t, bpm, gridWeights, snapWindowSec) {
  const period = 60 / bpm;
  const pick = weightedPick(gridWeights);
  let div = 1;
  if (pick === '1/2') div = 1/2; else if (pick === '1/3') div = 1/3; else if (pick === '1/4') div = 1/4; else div = 1;
  const q = period * div;
  const nearest = Math.round(t / q) * q;
  if (Math.abs(nearest - t) <= snapWindowSec) return nearest;
  return t;
}

function weightedPick(map) {
  const entries = Object.entries(map);
  const total = entries.reduce((s,[,w])=>s+w,0) || 1;
  let r = Math.random() * total;
  for (const [k,w] of entries) { if ((r -= w) <= 0) return k; }
  return entries[entries.length-1][0];
}

function adjustedGridWeights(onsets, bpm, base, mode) {
  const period = 60 / bpm;
  const grids = { '1':1, '1/2':1/2, '1/3':1/3, '1/4':1/4 };
  // sigma: tighter on HARD, looser on EASY
  let sigma = 0.020;
  if (mode === 'EASY') sigma = 0.028; else if (mode === 'HARD') sigma = 0.016;
  const first = onsets.slice(0, Math.min(onsets.length, 120));
  const scores = {};
  for (const [k,div] of Object.entries(grids)) {
    const q = period * div;
    let s = 0;
    for (const t of first) {
      const r = t - Math.round(t / q) * q;
      const d = Math.abs(r);
      s += Math.exp(-(d*d)/(2*sigma*sigma));
    }
    scores[k] = s;
  }
  const sum = Object.values(scores).reduce((a,b)=>a+b,0) || 1;
  const norm = Object.fromEntries(Object.entries(scores).map(([k,v]) => [k, v/sum]));
  const out = {};
  for (const k of Object.keys(grids)) {
    const baseW = (base[k]||0);
    const fitW = (norm[k]||0);
    const blend = mode === 'HARD' ? 0.55 : mode === 'EASY' ? 0.30 : 0.40; // use fit more on HARD
    out[k] = baseW * (1-blend) + fitW * blend;
  }
  return out;
}

function reduceSyncopation(chart, bpm) {
  const period = 60 / bpm;
  const q = period / 2; // half-beat
  const out = [];
  let offCount = 0;
  for (const n of chart) {
    const rel = n.time / q;
    const pos = Math.round(rel) % 2; // 0 on-beat, 1 off-beat
    if (pos !== 0) {
      offCount++;
      if (offCount % 2 === 0) continue;
    } else {
      offCount = 0;
    }
    out.push(n);
  }
  return out;
}

function computeBeatAlignmentOffset(onsets, bpm) {
  if (!onsets.length || !bpm) return 0;
  const period = 60 / bpm;
  const q = period / 2; // half-beat grid
  const firstN = onsets.slice(0, Math.min(64, onsets.length));
  // Gaussian kernel width ~ 25ms
  const sigma = 0.025;
  const steps = 96;
  let bestPhi = 0; let bestScore = -Infinity;
  // Precompute distances to grid for a phi
  for (let s=0; s<steps; s++) {
    const phi = (s/steps) * q; // [0,q)
    let score = 0;
    for (const t of firstN) {
      const rel = t - phi;
      // distance to nearest multiple of q
      const r = rel - Math.round(rel / q) * q;
      const d = Math.abs(r);
      const w = Math.exp(-(d*d)/(2*sigma*sigma));
      score += w;
    }
    if (score > bestScore) { bestScore = score; bestPhi = phi; }
  }
  return bestPhi;
}

function smoothBursts(chart, params) {
  const windowSec = (params.burstWindowMs||240) / 1000;
  const limit = params.burstLimit || 3;
  if (!chart.length) return chart;
  // collect unique event times (round to 10ms)
  const times = Array.from(new Set(chart.map(n => Math.round(n.time*100)/100))).sort((a,b)=>a-b);
  const drop = new Set();
  const deque = [];
  for (const t of times) {
    // pop old
    while (deque.length && t - deque[0] > windowSec) deque.shift();
    deque.push(t);
    if (deque.length > limit) {
      // drop latest event to enforce limit
      drop.add(t);
      deque.pop();
    }
  }
  if (drop.size === 0) return chart;
  const dropped = chart.filter(n => drop.has(Math.round(n.time*100)/100));
  const kept = chart.filter(n => !drop.has(Math.round(n.time*100)/100));
  return kept;
}
function sortTracks(arr, mode, diff, stats, dir='desc') {
  const byName = (a,b)=> (a.name||'').localeCompare(b.name||'');
  if (mode === 'name') {
    arr.sort(byName);
    if (dir === 'desc') arr.reverse();
    return arr;
  }
  if (mode === 'recent') {
    arr.sort((a,b)=> {
      const av = (stats[a.key]?.lastPlayedAt||0);
      const bv = (stats[b.key]?.lastPlayedAt||0);
      if (bv !== av) return bv - av;
      const cmp = byName(a,b);
      if (cmp) return cmp;
      return (a.key||'').localeCompare(b.key||'');
    });
    if (dir === 'asc') arr.reverse();
    return arr;
  }
  if (mode === 'best') {
    arr.sort((a,b)=> {
      const av = (stats[a.key]?.best?.[diff]?.score||0);
      const bv = (stats[b.key]?.best?.[diff]?.score||0);
      if (bv !== av) return bv - av;
      const cmp = byName(a,b);
      if (cmp) return cmp;
      return (a.key||'').localeCompare(b.key||'');
    });
    if (dir === 'asc') arr.reverse();
    return arr;
  }
  // added
  arr.sort((a,b)=> (b.addedAt||0) - (a.addedAt||0));
  if (dir === 'asc') arr.reverse();
  return arr;
}

function filterTracks(arr, mode, diff, stats, query='') {
  let out = arr;
  if (mode === 'hasBest') out = out.filter(t => !!(stats[t.key]?.best?.[diff]));
  else if (mode === 'unplayed') out = out.filter(t => !stats[t.key]?.best?.[diff]);
  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    out = out.filter(t => (t.name||'').toLowerCase().includes(q));
  }
  return out;
}

function randRange(a, b) {
  return a + Math.random() * (b - a);
}

function mixToMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += d[i];
  }
  for (let i = 0; i < len; i++) out[i] /= buffer.numberOfChannels;
  return out;
}

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2*Math.PI*i)/(n-1)));
  return w;
}
function applyWindow(x, w) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i]*w[i];
  return out;
}

// Very small FFT (real-input magnitude) using radix-2 Cooley–Tukey for prototype
class FFT {
  constructor(n) { this.n = n; this.rev = FFT.makeRev(n); this.cos = new Float32Array(n/2); this.sin = new Float32Array(n/2);
    for (let i=0;i<n/2;i++){ this.cos[i]=Math.cos(-2*Math.PI*i/n); this.sin[i]=Math.sin(-2*Math.PI*i/n);} }
  static makeRev(n){ const r=new Uint32Array(n); let j=0; for(let i=0;i<n;i++){ r[i]=j; let bit=n>>1; while(j & bit){ j^=bit; bit>>=1; } j|=bit; } return r; }
  magnitude(x){
    const n=this.n; const re=new Float32Array(n); const im=new Float32Array(n);
    for(let i=0;i<n;i++){ const ri=this.rev[i]; re[i]=x[ri]||0; im[i]=0; }
    for(let s=1; s<=Math.log2(n); s++){
      const m=1<<s; const m2=m>>1; const step=n/m;
      for(let k=0;k<n;k+=m){
        for(let j=0;j<m2;j++){
          const tpre = this.cos[j*step]*re[k+j+m2] - this.sin[j*step]*im[k+j+m2];
          const tpim = this.sin[j*step]*re[k+j+m2] + this.cos[j*step]*im[k+j+m2];
          re[k+j+m2] = re[k+j]-tpre; im[k+j+m2]=im[k+j]-tpim;
          re[k+j] += tpre;          im[k+j] += tpim;
        }
      }
    }
    const magLen = n/2;
    const mag = new Float32Array(magLen);
    for(let i=0;i<magLen;i++){ mag[i]=Math.hypot(re[i], im[i]); }
    return mag;
  }
}

function normalize(arr) {
  const max = Math.max(...arr);
  if (max === 0) return arr.map(()=>0);
  return arr.map(v => v / max);
}

function pickPeaks(arr, threshold=0.3, neighborhood=3) {
  const peaks = [];
  for (let i = neighborhood; i < arr.length - neighborhood; i++) {
    const v = arr[i];
    if (v < threshold) continue;
    let isPeak = true;
    for (let j = 1; j <= neighborhood; j++) {
      if (arr[i-j] >= v || arr[i+j] > v) { isPeak = false; break; }
    }
    if (isPeak) peaks.push(i);
  }
  return peaks;
}

function computePeakParams(curve, bpm, fps) {
  // Adaptive threshold: mean + k*std, clamped to [0.15, 0.6]
  const n = curve.length || 1;
  let mean = 0;
  for (let i=0;i<n;i++) mean += curve[i];
  mean /= n;
  let varsum = 0;
  for (let i=0;i<n;i++) { const d = curve[i]-mean; varsum += d*d; }
  const std = Math.sqrt(varsum / n);
  const base = mean + 0.6 * std;
  const thr = Math.max(0.15, Math.min(0.6, base));
  // Neighborhood: tighter at high BPM
  let nb = 3;
  if (bpm) nb = bpm > 160 ? 2 : bpm < 90 ? 4 : 3;
  // Minimum gap between peaks in frames (avoid double-peaks). Use 1/8拍を目安。
  let minGap = 0;
  if (bpm && fps) {
    const sec = (60 / bpm) / 8; // eighth-note period
    minGap = Math.max(1, Math.round(sec * fps));
  }
  return { thr, nb, minGap };
}

function smooth1D(arr, win=3) {
  const n = arr.length; if (win<=1 || n===0) return arr.slice();
  const half = Math.floor(win/2);
  const out = new Array(n).fill(0);
  for (let i=0;i<n;i++){
    let sum=0, cnt=0;
    for (let k=-half;k<=half;k++){
      const j = i+k;
      if (j>=0 && j<n){ sum += arr[j]; cnt++; }
    }
    out[i] = cnt? sum/cnt : arr[i];
  }
  return out;
}

function estimateBPM(onsetCurve, fps) {
  // autocorrelation over plausible tempo range 60-200 BPM
  const minBPM = 60, maxBPM = 200;
  const minLag = Math.floor((60/maxBPM) * fps);
  const maxLag = Math.floor((60/minBPM) * fps);
  let bestLag = 0, bestVal = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < onsetCurve.length - lag; i++) sum += onsetCurve[i] * onsetCurve[i+lag];
    if (sum > bestVal) { bestVal = sum; bestLag = lag; }
  }
  if (bestLag === 0) return null;
  let bpm = 60 * fps / bestLag;
  // Adjust to common tempo by doubling/halving into 80-160 range
  while (bpm < 80) bpm *= 2;
  while (bpm > 160) bpm /= 2;
  return Math.round(bpm);
}

// ---------------- Rendering & Input ----------------

function resizeCanvas() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const w = window.innerWidth;
  const h = window.innerHeight;
  $canvas.width = Math.floor(w * dpr);
  $canvas.height = Math.floor(h * dpr);
  $canvas.style.width = w + 'px';
  $canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);
$canvas.addEventListener('mousedown', (e) => {
  if (gameState !== STATE.PLAY || !play) return;
  const rect = $canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left);
  const y = (e.clientY - rect.top);
  const r = play._progressRect;
  if (r && x>=r.x && x<=r.x+r.w && y>=r.y && y<=r.y+r.h) {
    play.seeking = true;
    play.seekTargetSec = Math.max(0, Math.min(r.dur, r.dur * ((x - r.x)/r.w)));
  }
});
$canvas.addEventListener('mousemove', (e) => {
  if (!play?.seeking) return;
  const rect = $canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left);
  const r = play._progressRect; if (!r) return;
  play.seekTargetSec = Math.max(0, Math.min(r.dur, r.dur * ((x - r.x)/r.w)));
});
$canvas.addEventListener('mouseup', () => {
  if (!play?.seeking) return;
  const t = play.seekTargetSec || 0;
  try { play?.src?.stop?.(); } catch {}
  startPlay(play.track.id, play.difficulty, t);
  play.seeking = false;
});
window.addEventListener('blur', () => { if (gameState===STATE.PLAY && play && !play.paused) { ensureAudioContext().suspend(); play.paused = true; } });
$canvas.addEventListener('click', (e) => {
  if (gameState !== STATE.PLAY || !play) return;
  const rect = $canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left);
  const y = (e.clientY - rect.top);
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const cx = x; const cy = y; // CSS pixels since we set transform
  // Control buttons hit test
  const br = play._btnRects;
  if (br) {
    const hit = (r)=> r && cx>=r.x && cx<=r.x+r.w && cy>=r.y && cy<=r.y+r.h;
    if (hit(br.pause)) {
      e.preventDefault();
      const ac = ensureAudioContext();
      if (play.paused) { ac.resume(); play.paused = false; }
      else { ac.suspend(); play.paused = true; }
      return;
    }
    if (hit(br.retry)) {
      e.preventDefault();
      try { play?.src?.stop?.(); } catch {}
      startPlay(play.track.id, play.difficulty);
      return;
    }
    if (hit(br.back)) {
      e.preventDefault();
      try { play?.src?.stop?.(); } catch {}
      ensureAudioContext().suspend();
      setState(STATE.SELECT);
      play = null;
      return;
    }
  }
  const r = play._progressRect;
  if (r && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
    const ratio = (cx - r.x) / r.w;
    const target = Math.max(0, Math.min(r.dur, r.dur * ratio));
    try { play?.src?.stop?.(); } catch {}
    startPlay(play.track.id, play.difficulty, target);
  }
});

function pointerToLane(ev){
  const g = play?._laneGeom; if (!g) return -1;
  const rect = $canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  if (y < g.topY || y > g.lineY) return -1;
  const rel = x - g.leftX;
  if (rel < 0 || rel > g.laneWidth * g.lanes) return -1;
  const lane = Math.floor(rel / g.laneWidth);
  if (lane < 0 || lane >= g.lanes) return -1;
  return lane;
}

$canvas.addEventListener('pointerdown', (e) => {
  if (gameState !== STATE.PLAY || !play) return;
  const lane = pointerToLane(e);
  if (lane >= 0) {
    e.preventDefault();
    handleLanePress(lane);
  }
});
$canvas.addEventListener('pointerup', (e) => {
  if (gameState !== STATE.PLAY || !play) return;
  const lane = pointerToLane(e);
  if (lane >= 0) {
    e.preventDefault();
    handleLaneRelease(lane);
  }
});

function render() {
  ctx.clearRect(0,0,$canvas.width,$canvas.height);
  const w = $canvas.clientWidth;
  const h = $canvas.clientHeight;

  // Background gradient pulse
  const t = performance.now() / 1000;
  const g = ctx.createLinearGradient(0,0,w,h);
  g.addColorStop(0, `hsl(${(t*20)%360},60%,12%)`);
  g.addColorStop(1, `hsl(${(t*20+120)%360},60%,8%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0,0,w,h);

  if (gameState === STATE.PLAY && play) {
    drawPlay(w,h);
  } else if (gameState === STATE.RESULT && play) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0,0,w,h);
    drawResult(w,h);
  } else {
    // dim canvas when not playing
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0,0,w,h);
  }
  
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

function drawPlay(w, h) {
  const ac = ensureAudioContext();
  const p = play;
  const timeRaw = ac.currentTime - p.startAt; // negative before start
  const time = Math.max(0, timeRaw) + (p.offsetStart||0);
  const lineY = Math.floor(h * 0.82);
  const topY = Math.floor(h * 0.08);
  const lanes = KEYS.length;
  const laneWidth = Math.floor(w * 0.8 / lanes);
  const leftX = Math.floor(w * 0.1);
  // expose lane geometry for pointer input mapping
  p._laneGeom = { leftX, laneWidth, topY, lineY, lanes, w };

  // Judge line
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillRect(leftX, lineY, laneWidth*lanes, 3);

  // Judge guides (GOOD/GREAT/PERFECT bands)
  if (showJudgeGuides) {
    const { perfect: wP, great: wG, good: wD } = p.window;
    const toPixels = (sec) => sec / p.travelTime * (lineY - topY);
    const drawBand = (half, color) => {
      const hpx = Math.max(2, toPixels(half));
      ctx.fillStyle = color;
      ctx.fillRect(leftX, lineY - hpx, laneWidth*lanes, hpx*2);
    };
    drawBand(wD, 'rgba(255,90,90,0.08)');   // GOOD
    drawBand(wG, 'rgba(255,255,90,0.10)'); // GREAT
    drawBand(wP, 'rgba(120,255,180,0.12)'); // PERFECT
  }

  // Optional screen shake on MISS
  if (performance.now() < p.shakeUntil) {
    const dx = (Math.random()-0.5) * 4;
    const dy = (Math.random()-0.5) * 4;
    ctx.save();
    ctx.translate(dx, dy);
  } else {
    ctx.save();
  }

  // Lanes
  for (let l = 0; l < lanes; l++) {
    const x = leftX + l * laneWidth;
    ctx.fillStyle = laneFill(l, 0.10);
    ctx.fillRect(x+1, topY, laneWidth-2, lineY-topY);
  }

  // Active key highlight
  for (let l=0;l<lanes;l++){
    if (p.keyStates[l]) {
      const x = leftX + l * laneWidth;
      ctx.fillStyle = laneFill(l, 0.30);
      ctx.fillRect(x+1, lineY-12, laneWidth-2, 12);
    }
  }

  // Lane flash overlays
  for (let l=0;l<lanes;l++){
    const lvl = p.laneFlashLevels[l];
    if (lvl > 0.01) {
      const x = leftX + l * laneWidth;
      ctx.fillStyle = withAlpha(p.laneFlashColor[l], Math.min(0.5, lvl));
      ctx.fillRect(x+1, topY, laneWidth-2, lineY-topY);
      // decay
      p.laneFlashLevels[l] *= 0.86;
    }
  }

  // Beat guide (if BPM known)
  if (showBeatGuide && p.bpm) {
    const period = 60 / p.bpm;
    const approach = p.travelTime;
    const from = time - 0.1; // draw slightly above tail
    const to = time + approach;
    const first = Math.floor(from / period) - 1;
    const last = Math.ceil(to / period) + 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let k = first; k <= last; k++) {
      const tBeat = k * period;
      if (tBeat < 0) continue;
      const progress = 1 - ((tBeat - time) / approach);
      const y = topY + (lineY - topY) * progress;
      if (y < topY || y > lineY) continue;
      ctx.beginPath();
      ctx.moveTo(leftX, y);
      ctx.lineTo(leftX + laneWidth*lanes, y);
      ctx.stroke();
    }
  }

  // Notes render & auto-miss
  const approach = p.travelTime;
  const headTime = time + approach;
  const tailTime = Math.max(0, time - 0.2);

  // Autoplay judgement
  if (autoplay) {
    for (let i = 0; i < p.chart.length; i++) {
      const n = p.chart[i];
      if (n.type === 'hold') {
        if (!p.holdHeadJudged.has(i) && !p.misses.has(i) && time >= n.time) {
          judgeHoldHead(p, i, n, n.time);
        }
      } else {
        if (!p.hits.has(i) && !p.misses.has(i) && time >= n.time) {
          judgeNote(p, i, n, n.time);
        }
      }
    }
  }

  // Guide beat ticks (audio): schedule a little ahead
  if (guideBeat && p.bpm && p.guidePeriod && !p.paused) {
    const period = p.guidePeriod;
    let k = p.guideIndex;
    while (true) {
      const tBeat = k * period + (p.beatPhi||0);
      if (tBeat > time + 0.35) break;
      if (tBeat >= time) {
        const when = ensureAudioContext().currentTime + (tBeat - time);
        const strong = (k % 4) === 0;
        scheduleGuideTick(when, strong);
      }
      k++;
    }
    p.guideIndex = k;
  }

  for (let i = 0; i < p.chart.length; i++) {
    const n = p.chart[i];
    const isHold = n.type === 'hold';
    // Skip finished ones
    if (!isHold && (p.hits.has(i) || p.misses.has(i))) continue;
    if (isHold && (p.holdCompleted.has(i) || p.misses.has(i))) continue;

    // Auto head miss
    if (!isHold && n.time < tailTime) { judgeNote(p, i, n, time, 'MISS'); continue; }
    if (isHold && !p.holdHeadJudged.has(i) && n.time < tailTime) { judgeNote(p, i, n, time, 'MISS'); continue; }

    // Cull far future
    if (n.time > headTime) break;

    const x = leftX + n.lane * laneWidth;
    const yHead = topY + (lineY - topY) * (1 - ((n.time - time) / approach));

    if (isHold) {
      const end = n.end;
      const yTail = topY + (lineY - topY) * (1 - ((end - time) / approach));
      // body
      const y0 = Math.max(topY, Math.min(yHead, yTail));
      const y1 = Math.min(lineY, Math.max(yHead, yTail));
      if (y1 > topY && y0 < lineY) {
        ctx.fillStyle = 'rgba(155,210,255,0.25)';
        ctx.fillRect(x+10, y0, laneWidth-20, Math.max(4, y1 - y0));
      }
      // head
      ctx.fillStyle = '#9bd2ff';
      ctx.fillRect(x+6, yHead-10, laneWidth-12, 18);
      ctx.strokeStyle = 'rgba(155,210,255,0.25)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x+6, yHead-10, laneWidth-12, 18);

      // Auto tail finalize after it passes judge line
      const { good: wGood } = p.window;
      if (time > end + wGood && !p.holdCompleted.has(i) && p.holdHeadJudged.has(i)) {
        // if still holding, success; else miss
        const success = !!p.keyStates[n.lane];
        completeHold(p, i, success);
      }
      continue;
    }

    // tap
    ctx.fillStyle = '#9bd2ff';
    ctx.fillRect(x+6, yHead-10, laneWidth-12, 18);
    ctx.strokeStyle = 'rgba(155,210,255,0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x+6, yHead-10, laneWidth-12, 18);
  }

  // Hold end guide markers for active holds
  for (let l=0; l<lanes; l++) {
    const idx = p.holdActive[l];
    if (idx == null) continue;
    if (p.holdCompleted.has(idx) || p.misses.has(idx)) continue;
    const n = p.chart[idx];
    const end = n.end;
    // Only draw if within the vertical playfield
    const progressTail = 1 - ((end - time) / approach);
    const yTail = topY + (lineY - topY) * progressTail;
    if (yTail < topY || yTail > lineY) continue;
    const x = leftX + l * laneWidth;
    // Emphasis increases near end time
    const dt = Math.abs(end - time);
    const near = Math.max(0, 1 - dt / 0.25); // within 250ms => 0..1
    const alpha = 0.25 + 0.55 * near;
    ctx.fillStyle = `rgba(120,255,180,${alpha.toFixed(2)})`;
    ctx.fillRect(x+8, yTail-2, laneWidth-16, 4);
  }

  // UI overlay (score left, BPM right, combo center)
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = '600 18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`SCORE ${String(p.score).padStart(6,' ')}`, leftX, topY-10);
  // Now playing title (muted)
  if (p.track?.name) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '600 12px system-ui, sans-serif';
    const title = String(p.track.name);
    const maxw = laneWidth*lanes/2 - 20;
    let ttxt = title;
    while (ctx.measureText(ttxt).width > maxw && ttxt.length>3) ttxt = ttxt.slice(0, -2);
    if (ttxt !== title) ttxt += '…';
    ctx.fillText(ttxt, leftX, topY+6);
    ctx.restore();
  }
  if (p.bpm) {
    const txt = `BPM ${p.bpm}`;
    const tw = ctx.measureText(txt).width;
    ctx.fillText(txt, leftX + laneWidth*lanes - tw, topY-10);
  }
  if (p.combo > 0) {
    const txt = `${p.combo}x`;
    ctx.save();
    ctx.font = p.combo >= 10 ? '800 32px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' : '700 22px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    const tw = ctx.measureText(txt).width;
    const cx = leftX + laneWidth*lanes/2 - tw/2;
    const cy = topY - 8;
    ctx.strokeText(txt, cx, cy);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(txt, cx, cy);
    ctx.restore();
  }

  // Control buttons (top-right): Pause/Resume, Retry, Back
  const btnH = 24, btnW = 28, btnGap = 8;
  const btnY = topY - 24;
  let bx = leftX + laneWidth*lanes - (btnW*3 + btnGap*2);
  const rects = {};
  const drawBtn = (label) => {
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    roundRect(ctx, bx, btnY, btnW, btnH, 6); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = '700 14px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, bx + btnW/2 - tw/2, btnY + 16);
    const r = { x: bx, y: btnY, w: btnW, h: btnH };
    bx += btnW + btnGap;
    return r;
  };
  rects.pause = drawBtn(p.paused ? '▶' : 'Ⅱ');
  rects.retry = drawBtn('R');
  rects.back  = drawBtn('←');
  play._btnRects = rects;

  // Progress bar (bottom area above keycaps)
  const progY = lineY + 42;
  const progW = laneWidth*lanes;
  const tNow = time;
  const dur = Math.max(1, p.duration || (p.chart.length? p.chart[p.chart.length-1].time+3 : 1));
  const ratio = Math.max(0, Math.min(1, tNow / dur));
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  roundRect(ctx, leftX, progY, progW, 6, 3); ctx.fill();
  ctx.fillStyle = 'rgba(155,210,255,0.9)';
  roundRect(ctx, leftX, progY, progW*ratio, 6, 3); ctx.fill();
  // time labels
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillText(formatDurationMMSS(tNow), leftX, progY+16);
  const twd = ctx.measureText(formatDurationMMSS(dur)).width;
  ctx.fillText(formatDurationMMSS(dur), leftX+progW-twd, progY+16);
  // store last progress bar rect for seek handling
  play._progressRect = { x: leftX, y: progY, w: progW, h: 16, dur };
  if (p.lastJudge && !p.paused) {
    const elapsed = performance.now()/1000 - p.lastJudgeAt;
    const alpha = Math.max(0, 1 - elapsed/0.8);
    if (alpha > 0) {
      ctx.save();
      const txt = p.lastJudge;
      ctx.font = '800 28px system-ui, sans-serif';
      const tw = ctx.measureText(txt).width;
      const x = leftX + laneWidth*lanes/2 - tw/2;
      const y = topY + 22;
      // background pill
      const padX = 10, padY = 6, rad = 10;
      ctx.fillStyle = `rgba(0,0,0,${(0.35*alpha).toFixed(2)})`;
      roundRect(ctx, x - padX, y - 22, tw + padX*2, 30, rad);
      ctx.fill();
      // text
      ctx.fillStyle = withAlpha(judgeColor(txt), alpha);
      ctx.fillText(txt, x, y);
      ctx.restore();
    }
  }

  // Effects
  for (let i=p.effects.length-1; i>=0; i--) {
    const e = p.effects[i];
    const nowMs = performance.now();
    const elapsed = nowMs - e.birth;
    const kind = e.kind || 'ring';
    const dur = e.dur || (kind === 'judge' ? 700 : 350);
    const t = Math.min(1, Math.max(0, elapsed / dur));
    if (elapsed >= dur) { p.effects.splice(i,1); continue; }
    const x = leftX + e.lane * laneWidth + laneWidth/2;
    const baseY = lineY - 6;
    if (kind === 'judge') {
      const alpha = (1 - t);
      const y = baseY - 18 - t * 20;
      ctx.fillStyle = e.color ? withAlpha(e.color, alpha) : `rgba(255,255,255,${alpha.toFixed(2)})`;
      ctx.font = '16px system-ui, sans-serif';
      const tw = ctx.measureText(e.text||'').width;
      ctx.fillText(e.text||'', x - tw/2, y);
    } else if (kind === 'ring') {
      const r0 = e.r0 || 6;
      const r1 = e.r1 || 34;
      const r = r0 + (r1 - r0) * t;
      const alpha = (1 - t);
      const color = e.color || 'rgba(155,210,255,1)';
      ctx.strokeStyle = withAlpha(color, alpha);
      ctx.lineWidth = e.lineWidth || 2;
      ctx.beginPath();
      ctx.arc(x, baseY, r, 0, Math.PI*2);
      ctx.stroke();
    } else if (kind === 'combo') {
      const alpha = 1 - t;
      const scale = 1 + 0.2 * Math.sin(t * Math.PI);
      ctx.save();
      ctx.translate(leftX + laneWidth*lanes/2, topY + (lineY-topY)/2);
      ctx.scale(scale, scale);
      ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;
      ctx.strokeStyle = `rgba(0,0,0,${(0.35*alpha).toFixed(2)})`;
      ctx.lineWidth = 3;
      ctx.font = '800 40px system-ui, sans-serif';
      const tw = ctx.measureText(e.text||'').width;
      ctx.strokeText(e.text||'', -tw/2, 0);
      ctx.fillText(e.text||'', -tw/2, 0);
      ctx.restore();
    }
  }

  // Toast message
  if (p.toast && performance.now() < p.toast.until) {
    const alpha = Math.max(0, (p.toast.until - performance.now()) / 1000);
    ctx.save();
    const txt = p.toast.text || '';
    ctx.font = '700 16px system-ui, sans-serif';
    const tw = ctx.measureText(txt).width;
    const x = leftX + laneWidth*lanes/2 - tw/2;
    const y = topY - 28;
    ctx.fillStyle = `rgba(0,0,0,${(0.35*alpha).toFixed(2)})`;
    roundRect(ctx, x-8, y-18, tw+16, 24, 8); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;
    ctx.fillText(txt, x, y);
    ctx.restore();
  }

  // Pause overlay
  if (p.paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#fff';
    ctx.font = '700 28px system-ui, sans-serif';
    ctx.fillText('PAUSED', leftX, topY+30);
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText('Space: 再開    R: リトライ    Esc: 曲選択', leftX, topY+54);
  }

  // Countdown before start
  if (timeRaw < 0) {
    const remain = -timeRaw;
    const n = Math.ceil(remain);
    const txt = n >= 1 && n <= 3 ? String(n) : '';
    if (txt) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '72px system-ui, sans-serif';
      ctx.fillText(txt, leftX + laneWidth*lanes/2 - 18, topY + (lineY-topY)/2);
    }
  }

  // Keycaps at judge line
  for (let l=0;l<lanes;l++){
    const x = leftX + l * laneWidth;
    ctx.fillStyle = p.keyStates[l] ? laneFill(l, 0.65) : laneFill(l, 0.18);
    ctx.fillRect(x+6, lineY+6, laneWidth-12, 24);
    ctx.fillStyle = '#fff';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText(KEYS[l], x + laneWidth/2 - 5, lineY+24);
  }

  // End detection
  if (!p.done) {
    const lastTime = p.chart.length ? p.chart[p.chart.length-1].time : 0;
    if (time > lastTime + 3) {
      p.done = true;
      // Move to result with snapshot
      setState(STATE.RESULT);
    }
  }
  ctx.restore();
}

function drawResult(w, h) {
  const p = play;
  if (!p) return;
  const leftX = Math.floor(w * 0.1);
  const topY = Math.floor(h * 0.08);
  const lanes = KEYS.length;
  const laneWidth = Math.floor(w * 0.8 / lanes);
  const lineY = Math.floor(h * 0.82);

  // Error timeline (top area above histogram)
  const wChart = laneWidth * lanes;
  const hTimeline = 70;
  const yT = lineY - hTimeline - 210; // place above histogram area
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(leftX, yT, wChart, hTimeline);
  // axis 0ms
  const yZero = yT + hTimeline/2;
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(leftX, yZero, wChart, 1);
  // labels
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.fillText('誤差タイムライン (-150ms..+150ms)', leftX, yT - 6);
  // points
  const durAll = Math.max(1, p.duration || (p.chart.length? p.chart[p.chart.length-1].time+3 : 1));
  const clampMs = (ms)=> Math.max(-150, Math.min(150, ms));
  const colorFor = (j)=> j==='PERFECT'?'rgba(120,255,180,1)':(j==='GREAT'?'rgba(180,220,255,1)':(j==='GOOD'?'rgba(255,245,170,1)':'rgba(255,120,120,1)'));
  if (Array.isArray(p.hitLog)) {
    // scatter points
    for (const ev of p.hitLog) {
      const x = leftX + (Math.max(0, Math.min(durAll, ev.t)) / durAll) * wChart;
      if (ev.err == null || !isFinite(ev.err)) {
        // miss: draw cross near top
        const y = yT + 10;
        ctx.strokeStyle = 'rgba(255,120,120,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x-4, y-4); ctx.lineTo(x+4, y+4); ctx.moveTo(x+4,y-4); ctx.lineTo(x-4,y+4); ctx.stroke();
      } else {
        const ms = clampMs(ev.err*1000);
        const y = yZero - (ms/150) * (hTimeline/2 - 4);
        ctx.fillStyle = colorFor(ev.judge);
        ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI*2); ctx.fill();
      }
    }
    // smoothed line (moving average on valid hits)
    const events = p.hitLog.filter(ev => ev.err != null && isFinite(ev.err)).slice().sort((a,b)=>a.t-b.t);
    if (events.length >= 3) {
      const K = 7; // window size
      ctx.strokeStyle = 'rgba(255,255,120,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i=0;i<events.length;i++){
        let s=0, c=0;
        for (let j=-Math.floor(K/2); j<=Math.floor(K/2); j++){
          const k = i+j; if (k<0||k>=events.length) continue; s += events[k].err; c++;
        }
        const avg = c? (s/c) : events[i].err;
        const x = leftX + (Math.max(0, Math.min(durAll, events[i].t)) / durAll) * wChart;
        const ms = clampMs(avg*1000);
        const y = yZero - (ms/150) * (hTimeline/2 - 6);
        if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
    }
  }

  // Histogram of hit errors (-150ms..+150ms)
  const bins = new Array(15).fill(0);
  for (const d of p.hitErrors || []) {
    const ms = d * 1000;
    if (ms < -150 || ms > 150) continue;
    const idx = Math.min(14, Math.max(0, Math.floor((ms + 150) / 20)));
    bins[idx]++;
  }
  const maxBin = Math.max(1, ...bins);
  const hChart = 120;
  const x0 = leftX;
  const y0 = lineY - hChart - 80;
  // frame
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(x0, y0, wChart, hChart);
  // zero line (0ms)
  const zeroX = x0 + wChart * (150 / 300);
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(zeroX, y0, 1, hChart);
  // bars
  const barW = wChart / bins.length;
  for (let i=0;i<bins.length;i++){
    const v = bins[i];
    const bh = (v / maxBin) * (hChart - 10);
    const bx = x0 + i * barW + 1;
    const by = y0 + hChart - bh - 2;
    ctx.fillStyle = 'rgba(155,210,255,0.8)';
    ctx.fillRect(bx, by, Math.max(1, barW-2), bh);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.fillText('誤差ヒストグラム (-150ms ← 0 → +150ms)', x0, y0-8);
}

function judgeNote(p, idx, n, now, forced) {
  if (p.hits.has(idx) || p.misses.has(idx)) return;
  if (n.type === 'hold') {
    return judgeHoldHead(p, idx, n, now, forced);
  }
  const delta = forced ? Infinity : (now - n.time); // signed seconds, + is late
  const dt = Math.abs(delta);
  const { perfect: wPerfect, great: wGreat, good: wGood } = p.window;
  let judge = 'MISS';
  if (!forced) {
    if (dt <= wPerfect) judge = 'PERFECT';
    else if (dt <= wGreat) judge = 'GREAT';
    else if (dt <= wGood) judge = 'GOOD';
  }
  if (judge === 'MISS') {
    p.misses.add(idx);
    // log miss
    p.hitLog && p.hitLog.push({ t: n.time, err: null, lane: n.lane, judge: 'MISS' });
    p.combo = 0;
    p.lastJudge = 'MISS';
    p.lastJudgeAt = performance.now()/1000;
    p.judgeCount.MISS++;
    // Lane judge popup (red)
    p.effects.push({ kind:'judge', text:'MISS', lane: n.lane, birth: performance.now(), color: 'rgba(255,90,90,1)', dur: 700 });
    p.laneFlashLevels[n.lane] = 1;
    p.laneFlashColor[n.lane] = 'rgba(255,90,90,1)';
    p.shakeUntil = performance.now() + 150;
    if (missSound) playMissSound(n.lane);
  } else {
    p.hits.add(idx);
    p.hitErrors.push(delta);
    // log hit
    p.hitLog && p.hitLog.push({ t: n.time, err: delta, lane: n.lane, judge });
    if (hitSound) playHitSound(n.lane);
    if (judge === 'PERFECT') { p.score += 1000; p.judgeCount.PERFECT++; }
    else if (judge === 'GREAT') { p.score += 700; p.judgeCount.GREAT++; }
    else { p.score += 300; p.judgeCount.GOOD++; }
    p.combo += 1;
    p.maxCombo = Math.max(p.maxCombo, p.combo);
    p.lastJudge = judge;
    p.lastJudgeAt = performance.now()/1000;
    p.effects.push({ kind:'ring', lane: n.lane, birth: performance.now() });
    p.effects.push({ kind:'judge', text: judge, lane: n.lane, birth: performance.now(), color: judge==='PERFECT'?'rgba(255,255,255,1)':(judge==='GREAT'?'rgba(180,220,255,1)':'rgba(155,210,255,1)') });
    p.laneFlashLevels[n.lane] = 1;
    p.laneFlashColor[n.lane] = judge==='PERFECT'?'rgba(255,255,255,1)':(judge==='GREAT'?'rgba(180,220,255,1)':'rgba(155,210,255,1)');
    checkComboMilestone(p);
  }
}

function judgeHoldHead(p, idx, n, now, forced) {
  if (p.holdHeadJudged.has(idx) || p.holdCompleted.has(idx) || p.misses.has(idx)) return;
  const delta = forced ? Infinity : (now - n.time);
  const dt = Math.abs(delta);
  const { perfect: wPerfect, great: wGreat, good: wGood } = p.window;
  let judge = 'MISS';
  if (!forced) {
    if (dt <= wPerfect) judge = 'PERFECT';
    else if (dt <= wGreat) judge = 'GREAT';
    else if (dt <= wGood) judge = 'GOOD';
  }
  if (judge === 'MISS') {
    p.misses.add(idx);
    p.combo = 0;
    p.lastJudge = 'MISS';
    p.lastJudgeAt = performance.now()/1000;
    p.judgeCount.MISS++;
    p.effects.push({ kind:'judge', text:'MISS', lane: n.lane, birth: performance.now(), color: 'rgba(255,90,90,1)', dur: 700 });
    p.laneFlashLevels[n.lane] = 1;
    p.laneFlashColor[n.lane] = 'rgba(255,90,90,1)';
    p.shakeUntil = performance.now() + 150;
    if (missSound) playMissSound(n.lane);
  } else {
    p.holdHeadJudged.add(idx);
    p.hitErrors.push(delta);
    // log hold head
    p.hitLog && p.hitLog.push({ t: n.time, err: delta, lane: n.lane, judge });
    if (hitSound) playHitSound(n.lane);
    if (judge === 'PERFECT') { p.score += 1000; p.judgeCount.PERFECT++; }
    else if (judge === 'GREAT') { p.score += 700; p.judgeCount.GREAT++; }
    else { p.score += 300; p.judgeCount.GOOD++; }
    p.combo += 1;
    p.maxCombo = Math.max(p.maxCombo, p.combo);
    p.lastJudge = judge;
    p.lastJudgeAt = performance.now()/1000;
    p.effects.push({ kind:'ring', lane: n.lane, birth: performance.now() });
    p.effects.push({ kind:'judge', text: judge, lane: n.lane, birth: performance.now(), color: judge==='PERFECT'?'rgba(255,255,255,1)':(judge==='GREAT'?'rgba(180,220,255,1)':'rgba(155,210,255,1)') });
    // start holding on this lane
    p.holdActive[n.lane] = idx;
    p.laneFlashLevels[n.lane] = 1;
    p.laneFlashColor[n.lane] = judge==='PERFECT'?'rgba(255,255,255,1)':(judge==='GREAT'?'rgba(180,220,255,1)':'rgba(155,210,255,1)');
    checkComboMilestone(p);
  }
}

function completeHold(p, idx, success) {
  if (p.holdCompleted.has(idx) || p.misses.has(idx)) return;
  const n = p.chart[idx];
  p.holdCompleted.add(idx);
  p.holdActive[n.lane] = null;
  if (success) {
    p.score += 500; // completion bonus
    p.lastJudge = 'HOLD';
    p.lastJudgeAt = performance.now()/1000;
    // finish ring (bigger, greenish)
    p.effects.push({ kind:'ring', lane: n.lane, birth: performance.now(), r0: 10, r1: 48, color:'rgba(120,255,180,1)', lineWidth: 3, dur: 420 });
    p.effects.push({ kind:'judge', text:'HOLD', lane: n.lane, birth: performance.now(), color:'rgba(180,255,210,1)', dur: 800 });
    p.laneFlashLevels[n.lane] = 1;
    p.laneFlashColor[n.lane] = 'rgba(120,255,180,1)';
    if (hitSound) playHitSound(n.lane, true);
  } else {
    // early release counts as MISS and breaks combo
    p.misses.add(idx);
    p.combo = 0;
    p.lastJudge = 'MISS';
    p.lastJudgeAt = performance.now()/1000;
    p.judgeCount.MISS++;
    p.effects.push({ kind:'judge', text:'EARLY', lane: n.lane, birth: performance.now(), color: 'rgba(255,120,120,1)', dur: 800 });
    p.laneFlashLevels[n.lane] = 1;
    p.laneFlashColor[n.lane] = 'rgba(255,120,120,1)';
    p.shakeUntil = performance.now() + 150;
  }
}

function checkComboMilestone(p) {
  if (!p || !p.combo) return;
  const milestones = [50, 100, 200, 300, 500, 800, 1000];
  if (milestones.includes(p.combo)) {
    p.effects.push({ kind:'combo', text: `${p.combo} COMBO`, birth: performance.now(), dur: 900 });
  }
}

function withAlpha(rgba, a) {
  // Accept rgba(...) or any color; fallback to white
  try {
    if (rgba.startsWith('rgba(')) {
      const inside = rgba.slice(5, -1).split(',').map(s=>s.trim());
      const [r,g,b] = inside;
      return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
    }
  } catch {}
  return `rgba(255,255,255,${a.toFixed(2)})`;
}

function exportResultImage(p, best, acc, avgAbsMs, avgSignedMs, outWOpt, outHOpt){
  const src = document.getElementById('game-canvas');
  const srcW = src.width; const srcH = src.height;
  // Fixed output resolution (HD)
  const outW = outWOpt||1600, outH = outHOpt||900;
  const cvs = document.createElement('canvas');
  cvs.width = outW; cvs.height = outH;
  const c = cvs.getContext('2d');
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  // base: draw current canvas letterboxed to fixed size
  c.fillStyle = '#0b0f16';
  c.fillRect(0,0,outW,outH);
  if (srcW && srcH) {
    const scale = Math.min(outW/srcW, outH/srcH);
    const dw = Math.floor(srcW * scale);
    const dh = Math.floor(srcH * scale);
    const dx = Math.floor((outW - dw)/2);
    const dy = Math.floor((outH - dh)/2);
    c.drawImage(src, 0, 0, srcW, srcH, dx, dy, dw, dh);
  }
  // overlay gradient
  const g = c.createLinearGradient(0,0,0,outH);
  g.addColorStop(0, 'rgba(0,0,0,0.10)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.25)');
  g.addColorStop(1, 'rgba(0,0,0,0.35)');
  c.fillStyle = g; c.fillRect(0,0,outW,outH);
  // panel card
  const pad = Math.floor(outW*0.06);
  const cardW = Math.min(Math.floor(outW*0.56), outW - pad*2);
  const cardH = Math.min(Math.floor(outH*0.60), outH - pad*2);
  const x = pad; const y = pad;
  c.fillStyle = 'rgba(20,24,34,0.75)';
  roundRect(c, x, y, cardW, cardH, 16); c.fill();
  // subtle shadow
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.25)';
  c.shadowBlur = 12; c.shadowOffsetY = 4;
  roundRect(c, x, y, cardW, cardH, 16); c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 2; c.stroke();
  c.restore();
  const innerPad = 18;
  let cx = x + innerPad; let cy = y + innerPad;
  // title
  c.fillStyle = '#fff';
  c.font = '700 26px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  const title = String(p.track?.name || '');
  wrapFillText(c, title, cx, cy+2, cardW - innerPad*2, 28);
  cy += 36 + Math.floor((c.measureText(title).width > (cardW-innerPad*2)) ? 14 : 0);
  // sub
  c.fillStyle = 'rgba(255,255,255,0.75)';
  c.font = '600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  c.fillText(`${p.bpm?`BPM ${p.bpm} • `:''}難易度 ${p.difficulty}`, cx, cy);
  cy += 24;
  // rank + score
  const rank = rankFromScore(p.score, p.maxScore);
  c.fillStyle = '#fff'; c.font = '800 40px system-ui, sans-serif';
  c.fillText(`RANK ${rank}`, cx, cy+32);
  c.font = '700 22px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  c.fillStyle = 'rgba(155,210,255,0.95)';
  c.fillText(`SCORE ${p.score}`, cx + 250, cy+28);
  cy += 56;
  // grid stats
  c.font = '600 16px system-ui, sans-serif'; c.fillStyle='#fff';
  const stats1 = [
    ['精度率', `${acc.toFixed(2)}%`],
    ['平均誤差', `${avgAbsMs.toFixed(1)} ms`],
    ['平均偏差', `${avgSignedMs.toFixed(1)} ms`],
    ['最大COMBO', `${p.maxCombo}`],
  ];
  const colW = Math.floor((cardW - innerPad*2) / 2);
  for (let i=0;i<stats1.length;i++){
    const col = i % 2; const row = Math.floor(i/2);
    const bx = cx + col * colW; const by = cy + row*26;
    c.fillStyle = 'rgba(255,255,255,0.7)'; c.font = '600 14px system-ui, sans-serif'; c.fillText(stats1[i][0], bx, by);
    c.fillStyle = '#fff'; c.font = '700 18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'; c.fillText(stats1[i][1], bx+120, by);
  }
  cy += 26 * Math.ceil(stats1.length/2) + 12;
  // judges
  c.fillStyle = 'rgba(255,255,255,0.7)'; c.font='600 14px system-ui, sans-serif';
  c.fillText('判定', cx, cy);
  c.font='700 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'; c.fillStyle='#b4ffd2'; c.fillText(`PERFECT ${p.judgeCount.PERFECT}`, cx+60, cy);
  c.fillStyle='#b4d8ff'; c.fillText(`GREAT ${p.judgeCount.GREAT}`, cx+220, cy);
  c.fillStyle='#fff5aa'; c.fillText(`GOOD ${p.judgeCount.GOOD}`, cx+380, cy);
  c.fillStyle='#ff7878'; c.fillText(`MISS ${p.judgeCount.MISS}`, cx+520, cy);
  cy += 28;
  // best and diffs
  if (best) {
    c.fillStyle='rgba(255,255,255,0.7)'; c.font='600 14px system-ui, sans-serif';
    c.fillText(`Best(${p.difficulty})`, cx, cy);
    c.fillStyle='#fff'; c.font='700 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    c.fillText(`Score ${best.score} / ${best.acc.toFixed(1)}% • MaxCombo ${best.combo||0}`, cx+90, cy);
    cy += 24;
    const dS=p.score-best.score; const dA=acc-(best.acc||0); const dC=(p.maxCombo-(best.combo||0));
    const pos=(v)=> v>=0; const sign=(v)=> (v>0?'+':'');
    const col = (v)=> pos(v)?'#93ffa7':'#ff9b9b';
    c.fillStyle='rgba(255,255,255,0.7)'; c.font='600 14px system-ui, sans-serif'; c.fillText('差分', cx, cy);
    c.font='700 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    c.fillStyle = col(dS); c.fillText(`Score ${sign(dS)}${dS}`, cx+60, cy);
    c.fillStyle = col(dA); c.fillText(`Acc ${dA>=0?'+':''}${Math.abs(dA).toFixed(1)}%`, cx+200, cy);
    c.fillStyle = col(dC); c.fillText(`MaxCombo ${sign(dC)}${dC}`, cx+330, cy);
    cy += 26;
  }
  // small logo top-right on card
  c.save();
  const logo = 'Otogame';
  c.font = '800 18px system-ui, sans-serif';
  const lw = c.measureText(logo).width;
  c.fillStyle = 'rgba(255,255,255,0.85)';
  c.fillText(logo, x + cardW - lw - innerPad, y + 26);
  c.restore();
  // footer timestamp
  const ts = new Date();
  const tstr = `${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`;
  c.fillStyle='rgba(255,255,255,0.6)'; c.font='600 12px system-ui, sans-serif';
  c.fillText(`Generated by Otogame • ${tstr} • ${outW}x${outH}`, cx, y + cardH - 14);
  return cvs.toDataURL('image/png');
}

function parseSize(key){
  try{
    if (typeof key !== 'string') return { w: 1600, h: 900 };
    const m = key.match(/^(\d+)x(\d+)$/);
    if (!m) return { w: 1600, h: 900 };
    const w = parseInt(m[1],10), h = parseInt(m[2],10);
    if (!isFinite(w) || !isFinite(h) || w<=0 || h<=0) return { w: 1600, h: 900 };
    return { w, h };
  } catch { return { w: 1600, h: 900 }; }
}

function wrapFillText(ctx, text, x, y, maxWidth, lineHeight){
  const words = String(text).split(/\s+/);
  let line = '';
  for (let n=0;n<words.length;n++){
    const test = line ? (line + ' ' + words[n]) : words[n];
    const w = ctx.measureText(test).width;
    if (w > maxWidth && line) {
      ctx.fillText(line, x, y); y += lineHeight; line = words[n];
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

function laneFill(lane, alpha) {
  const baseHue = 200; // blueish base
  const spread = 60; // total hue spread
  const lanes = KEYS.length || 6;
  const h = (baseHue - spread/2) + (lane/(lanes-1)) * spread;
  const s = theme==='light' ? 70 : 60;
  const l = theme==='light' ? 65 : 40;
  const a = Math.max(0, Math.min(1, alpha));
  return `hsla(${Math.round(h)}, ${s}%, ${l}%, ${a})`;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h/2, w/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}

function makeToast(text, ms=1000) {
  if (!play) return;
  play.toast = { text, until: performance.now() + ms };
}

function judgeColor(label) {
  switch(label) {
    case 'PERFECT': return 'rgba(180,255,210,1)';
    case 'GREAT': return 'rgba(180,220,255,1)';
    case 'GOOD': return 'rgba(255,245,170,1)';
    case 'HOLD': return 'rgba(180,255,210,1)';
    case 'MISS': return 'rgba(255,120,120,1)';
    default: return 'rgba(255,255,255,1)';
  }
}

function handleLanePress(lane){
  if (!play) return;
  if (play.paused) return;
  play.keyStates[lane] = true;
  const ac = ensureAudioContext();
  const now = Math.max(0, ac.currentTime - play.startAt) + timingOffsetMs/1000;
  const nowAdj = now + (play.offsetStart||0);
  // find the earliest unjudged note in this lane near now
  let bestIdx = -1; let bestDt = 1e9;
  for (let i = 0; i < play.chart.length; i++) {
    const n = play.chart[i];
    if (n.lane !== lane) continue;
    if (n.type === 'hold') {
      // skip if head already judged or completed
      if (play.holdHeadJudged.has(i) || play.holdCompleted.has(i) || play.misses.has(i)) continue;
    } else {
      if (play.hits.has(i) || play.misses.has(i)) continue;
    }
    const dt = Math.abs(n.time - nowAdj);
    if (dt < bestDt) { bestDt = dt; bestIdx = i; }
    if (n.time > nowAdj + 0.15) break; // early exit
  }
  if (bestIdx >= 0) {
    judgeNote(play, bestIdx, play.chart[bestIdx], nowAdj);
  }
}
function handleLaneRelease(lane){
  if (!play) return;
  if (play.paused) return;
  play.keyStates[lane] = false;
  // Early release on hold
  const idx = play.holdActive[lane];
  if (idx != null) {
    const n = play.chart[idx];
    const ac = ensureAudioContext();
    const now = Math.max(0, ac.currentTime - play.startAt) + (play.offsetStart||0) + timingOffsetMs/1000;
    const { good: wGood } = play.window;
    if (now < n.end - wGood) {
      // released too early -> fail
      completeHold(play, idx, false);
    } else if (Math.abs(now - n.end) <= wGood) {
      // release within window near end -> success
      completeHold(play, idx, true);
    } else if (now > n.end + wGood) {
      // release after tail window -> auto success already handled in render, but ensure cleanup
      completeHold(play, idx, true);
    }
  }
}

window.addEventListener('keydown', (e) => {
  // Calibration taps on select screen
  if (gameState === STATE.SELECT && calibrator.active && (e.code in KEY_MAP)) {
    const ac = ensureAudioContext();
    if (calibrator.beatTimes.length) {
      const now = ac.currentTime;
      // find nearest scheduled beat
      let best = Infinity; let bestBeat = null;
      for (const bt of calibrator.beatTimes) {
        const d = now - bt;
        if (Math.abs(d) < Math.abs(best)) { best = d; bestBeat = bt; }
      }
      if (bestBeat != null) {
        const ms = best * 1000; // signed: + late
        calibrator.deltas.push(ms);
        // keep recent 200 samples max
        if (calibrator.deltas.length > 200) calibrator.deltas.shift();
        // refresh UI numbers
        renderUI();
      }
    }
    return; // don't pass to gameplay
  }
  // SELECT shortcuts
  if (gameState === STATE.SELECT && !calibrator.active) {
    if ((e.code === 'Enter' || e.code === 'Space') && selectedTrackId) {
      e.preventDefault();
      startPlay(selectedTrackId, selectedDifficulty);
      return;
    }
    if (e.code === 'Digit1') { selectedDifficulty = 'EASY'; saveSettings(); renderUI(); return; }
    if (e.code === 'Digit2') { selectedDifficulty = 'NORMAL'; saveSettings(); renderUI(); return; }
    if (e.code === 'Digit3') { selectedDifficulty = 'HARD'; saveSettings(); renderUI(); return; }
    if (e.code === 'KeyA') { autoplay = !autoplay; saveSettings(); renderUI(); return; }
    if (e.code === 'KeyG') { guideBeat = !guideBeat; saveSettings(); renderUI(); return; }
    if (e.code === 'KeyJ') { showJudgeGuides = !showJudgeGuides; saveSettings(); renderUI(); return; }
    if (e.code === 'KeyW') { judgeTightness = judgeTightness==='NARROW'?'NORMAL':(judgeTightness==='NORMAL'?'WIDE':'NARROW'); saveSettings(); renderUI(); return; }
    if (e.code === 'KeyV') { showBeatGuide = !showBeatGuide; saveSettings(); renderUI(); return; }
  }
  if (gameState === STATE.PLAY && play) {
    if (e.code === 'Space') { // pause/resume
      e.preventDefault();
      const ac = ensureAudioContext();
      if (play.paused) { ac.resume(); play.paused = false; }
      else { ac.suspend(); play.paused = true; }
      return;
    }
    if (e.code === 'KeyR') { // retry
      e.preventDefault();
      try { play?.src?.stop?.(); } catch {}
      startPlay(play.track.id, play.difficulty);
      return;
    }
    if (e.code === 'Escape') { // back to select
      e.preventDefault();
      try { play?.src?.stop?.(); } catch {}
      ensureAudioContext().suspend();
      setState(STATE.SELECT);
      play = null;
      return;
    }
    if (e.code === 'ArrowRight') { // seek +5s
      e.preventDefault();
      const ac = ensureAudioContext();
      const cur = Math.max(0, ac.currentTime - play.startAt) + (play.offsetStart||0);
      const target = Math.min((play.duration||cur+5), cur + 5);
      try { play?.src?.stop?.(); } catch {}
      startPlay(play.track.id, play.difficulty, target);
      return;
    }
    if (e.code === 'ArrowLeft') { // seek -5s
      e.preventDefault();
      const ac = ensureAudioContext();
      const cur = Math.max(0, ac.currentTime - play.startAt) + (play.offsetStart||0);
      const target = Math.max(0, cur - 5);
      try { play?.src?.stop?.(); } catch {}
      startPlay(play.track.id, play.difficulty, target);
      return;
    }
    if (e.code === 'KeyM') { // toggle hit sound
      e.preventDefault(); hitSound = !hitSound; saveSettings(); return;
    }
    // Fullscreen toggle moved to F11 or Alt+Enter to avoid conflict with gameplay key 'F'
    if (e.code === 'F11' || (e.code === 'Enter' && (e.altKey || e.metaKey))) {
      e.preventDefault(); toggleFullscreen(); return;
    }
    if (e.code === 'BracketRight') { // offset +5ms
      e.preventDefault(); timingOffsetMs = Math.min(200, timingOffsetMs + 5); saveSettings(); makeToast(`OFFSET ${timingOffsetMs}ms`); return; }
    if (e.code === 'BracketLeft') { // offset -5ms
      e.preventDefault(); timingOffsetMs = Math.max(-200, timingOffsetMs - 5); saveSettings(); makeToast(`OFFSET ${timingOffsetMs}ms`); return; }
  }
  if (!(e.code in KEY_MAP)) return;
  const lane = KEY_MAP[e.code];
  handleLanePress(lane);
});
window.addEventListener('keyup', (e) => {
  if (!(e.code in KEY_MAP)) return;
  const lane = KEY_MAP[e.code];
  handleLaneRelease(lane);
});

// Initialize UI
loadSettings();
applyTheme();
// Disable canvas interactions on non-play states to ensure UI is clickable
try { const c = document.getElementById('game-canvas'); if (c) c.style.pointerEvents = 'none'; } catch {}
renderUI();

// Global error handler to surface issues in UI (useful on hosted envs)
window.addEventListener('error', (e)=>{
  try{
    const app = document.getElementById('app');
    const card = document.createElement('div');
    card.className = 'panel';
    card.innerHTML = `<div class="title">エラーが発生しました</div>
      <div class="mono" style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(String(e.message||e.error||'Unknown error'))}</div>`;
    app.appendChild(card);
  }catch{}
});
window.addEventListener('unhandledrejection', (e)=>{
  try{
    const app = document.getElementById('app');
    const card = document.createElement('div');
    card.className = 'panel';
    card.innerHTML = `<div class="title">エラー(非同期)</div>
      <div class="mono" style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(String(e.reason||'Unknown rejection'))}</div>`;
    app.appendChild(card);
  }catch{}
});

// Import shared set from URL hash (if present)
(async function importShareFromHash(){
  try {
    const m = location.hash.match(/[#&]share=([^&]+)/);
    if (!m) return;
    const json = decodeURIComponent(escape(atob(m[1])));
    const payload = JSON.parse(json);
    if (payload && Array.isArray(payload.urls)) {
      for (const it of payload.urls) {
        if (it && it.url) { try { await handleUrlAdd(it.url); } catch {} }
      }
    }
  } catch (e) {
    console.warn('import share failed', e);
  }
})();

// ---------------- Persistence & Utilities ----------------
function saveSettings() {
  try {
    const obj = { selectedDifficulty, timingOffsetMs, showBeatGuide, judgeTightness, selectedSort, selectedSortDir, selectedFilter, searchQuery, autoplay, hitSound, hitSoundVol, missSound, showJudgeGuides, guideBeat, guideVol, theme, lastTrackKey, musicVol, exportSize, bgmMode };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
  } catch {}
}
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      if (obj.selectedDifficulty && DIFFICULTY.includes(obj.selectedDifficulty)) selectedDifficulty = obj.selectedDifficulty;
      if (typeof obj.timingOffsetMs === 'number') timingOffsetMs = obj.timingOffsetMs;
      if (typeof obj.showBeatGuide === 'boolean') showBeatGuide = obj.showBeatGuide;
      if (obj.judgeTightness) judgeTightness = obj.judgeTightness;
      if (obj.selectedSort) selectedSort = obj.selectedSort;
      if (obj.selectedFilter) selectedFilter = obj.selectedFilter;
      if (obj.selectedSortDir === 'asc' || obj.selectedSortDir === 'desc') selectedSortDir = obj.selectedSortDir;
      if (typeof obj.searchQuery === 'string') searchQuery = obj.searchQuery;
      if (typeof obj.autoplay === 'boolean') autoplay = obj.autoplay;
      if (typeof obj.hitSound === 'boolean') hitSound = obj.hitSound;
      if (typeof obj.hitSoundVol === 'number') hitSoundVol = obj.hitSoundVol;
      if (typeof obj.showJudgeGuides === 'boolean') showJudgeGuides = obj.showJudgeGuides;
      if (typeof obj.guideBeat === 'boolean') guideBeat = obj.guideBeat;
      if (obj.theme === 'light' || obj.theme === 'dark') theme = obj.theme;
      if (obj.lastTrackKey) lastTrackKey = obj.lastTrackKey;
      if (typeof obj.musicVol === 'number') musicVol = Math.max(0, Math.min(1, obj.musicVol));
      if (typeof obj.guideVol === 'number') guideVol = Math.max(0, Math.min(1, obj.guideVol));
      if (typeof obj.missSound === 'boolean') missSound = obj.missSound;
      if (typeof obj.exportSize === 'string') exportSize = obj.exportSize;
      if (typeof obj.bgmMode === 'boolean') bgmMode = obj.bgmMode;
    }
  } catch {}
}
function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch { return {}; }
}
function saveStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch {}
}
async function computeTrackKey(file, arrayBuffer) {
  const head = arrayBuffer.slice(0, Math.min(65536, arrayBuffer.byteLength));
  const view = new Uint8Array(head);
  let h = 5381;
  const name = file.name + ':' + file.size + ':' + (file.type||'audio');
  for (let i=0;i<name.length;i++) h = ((h<<5) + h) ^ name.charCodeAt(i);
  for (let i=0;i<view.length;i++) h = ((h<<5) + h) ^ view[i];
  h = h >>> 0;
  return 't' + h.toString(36);
}
function quickAnalyzeBPM(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const data = mixToMono(audioBuffer);
  const maxSamples = Math.min(data.length, Math.floor(sampleRate * 60));
  const frameSize = 1024, hopSize = 512;
  const window = hann(frameSize);
  const fft = new FFT(frameSize);
  const flux = [];
  let prevMag = null;
  for (let i = 0; i + frameSize < maxSamples; i += hopSize) {
    const frame = data.subarray(i, i + frameSize);
    const w = applyWindow(frame, window);
    const spec = fft.magnitude(w);
    if (prevMag) {
      let sum = 0;
      for (let k = 0; k < spec.length; k++) { const diff = spec[k] - prevMag[k]; if (diff > 0) sum += diff; }
      flux.push(sum);
    } else {
      flux.push(0);
    }
    prevMag = spec;
  }
  const normFlux = normalize(flux);
  const fps = sampleRate / hopSize;
  return estimateBPM(normFlux, fps);
}
function formatDuration(sec) {
  if (!isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2,'0')}`;
}

function formatDurationMMSS(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2,'0')}`;
}

function applyTheme(){
  try { document.documentElement.setAttribute('data-theme', theme || 'dark'); } catch {}
}

function toggleFullscreen() {
  try {
    const doc = document;
    const docEl = doc.documentElement;
    const inFS = !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement);
    const request = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen || doc.msExitFullscreen;
    if (!inFS) {
      if (request) request.call(docEl);
      fullscreen = true;
    } else {
      if (exit) exit.call(doc);
      fullscreen = false;
    }
  } catch {}
}

function avgSigned(arr){ if(!arr||!arr.length) return 0; return arr.reduce((a,b)=>a+b,0)/arr.length; }
function formatMs(v){ if(v==null||!isFinite(v)) return '—'; return `${v.toFixed(1)} ms`; }
function recommendOffset(deltas){ if(!deltas||!deltas.length) return null; const avg = avgSigned(deltas); return Math.max(-200, Math.min(200, Math.round(timingOffsetMs - avg))); }

function startCalibrationBeats(count=16){
  const ac = ensureAudioContext();
  const bpm = calibrator.bpm || 120;
  const period = 60 / bpm;
  const startAt = ac.currentTime + 0.6;
  calibrator.beatTimes = [];
  for (let i=0;i<count;i++){
    const t = startAt + i*period;
    scheduleClick(t, i % 4 === 0);
    calibrator.beatTimes.push(t);
  }
  calibrator.running = true;
  calibrator.target = count;
  calibrator.period = period;
  calibrator.startedAt = startAt;
}
function stopCalibration(){ calibrator.running = false; }
function scheduleClick(when, strong=false){
  try{
    const ac = ensureAudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const freq = strong ? 1600 : 1200;
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.6, when+0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when+0.06);
    osc.connect(gain).connect(ac.destination);
    osc.start(when);
    osc.stop(when+0.08);
  }catch(e){/* ignore */}
}

function drawCalibSparkline(canvas, deltas){
  try {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio||1));
    const cssW = canvas.clientWidth || 560;
    const cssH = canvas.clientHeight || 70;
    const w = Math.floor(cssW * dpr);
    const h = Math.floor(cssH * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,cssW,cssH);
    // frame and zero line
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0,0,cssW,cssH);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(0, Math.floor(cssH/2), cssW, 1);
    const maxAbs = 150; // ms
    const N = deltas.length;
    if (!N) return;
    // polyline
    ctx.strokeStyle = 'rgba(155,210,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i=0;i<N;i++){
      const ms = Math.max(-maxAbs, Math.min(maxAbs, deltas[i]));
      const x = (i/(Math.max(1,N-1))) * cssW;
      const y = (cssH/2) - (ms/maxAbs) * (cssH/2 - 4);
      if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();
    // average line
    const avg = avgSigned(deltas);
    const yAvg = (cssH/2) - (Math.max(-maxAbs, Math.min(maxAbs, avg))/maxAbs) * (cssH/2 - 4);
    ctx.strokeStyle = 'rgba(255,255,120,0.9)';
    ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(0, yAvg); ctx.lineTo(cssW, yAvg); ctx.stroke();
    ctx.setLineDash([]);
  } catch {}
}

function playHitSound(lane=0, strong=false){
  try{
    const ac = ensureAudioContext();
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const base = strong ? 880 : 740;
    const freq = base + (lane * 22);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, hitSoundVol), now+0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, now+0.05);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now+0.07);
  }catch(e){}
}

function scheduleGuideTick(when, strong=false){
  try{
    const ac = ensureAudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const freq = strong ? 1000 : 800;
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, when);
    const amp = Math.max(0.0002, guideVol);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(amp, when+0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, when+0.05);
    osc.connect(gain).connect(ac.destination);
    osc.start(when);
    osc.stop(when+0.06);
  }catch(e){}
}

function playMissSound(lane=0) {
  try{
    const ac = ensureAudioContext();
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const freq = 220 + (lane*10);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, hitSoundVol*0.6), now+0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, now+0.08);
    osc.connect(gain).connect(ac.destination);
    osc.start(now);
    osc.stop(now+0.1);
  } catch(e){}
}

function ensureAnalysisWorker() {
  if (!analysisWorker) {
    try {
      const url = new URL('./analysisWorker.js', import.meta.url);
      // use classic worker (no module imports inside worker)
      analysisWorker = new Worker(url, { type: 'classic' });
    } catch (e) {
      // fallback to relative path from document for environments without import.meta.url support
      analysisWorker = new Worker('src/analysisWorker.js');
    }
  }
  return analysisWorker;
}
function analyzeBPMWithWorker(float32Array, sampleRate) {
  return new Promise((resolve, reject) => {
    try {
      const w = ensureAnalysisWorker();
      const onMsg = (e) => {
        const msg = e.data;
        if (!msg) return;
        if (msg.type === 'bpm') { w.removeEventListener('message', onMsg); resolve(msg.bpm || null); }
        else if (msg.type === 'error') { w.removeEventListener('message', onMsg); reject(new Error(msg.error||'worker error')); }
      };
      w.addEventListener('message', onMsg);
      // Transfer the underlying buffer for performance
      w.postMessage({ type: 'bpm', sampleRate, data: float32Array }, [float32Array.buffer]);
    } catch (err) { reject(err); }
  });
}
