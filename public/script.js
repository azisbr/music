// --- 0. REGISTER PWA & CUSTOM INSTALL BUTTON ---
let deferredPrompt;
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.log('PWA gagal terdaftar:', err));
    });
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); 
    deferredPrompt = e;
    const installBtn = document.getElementById('installAppBtn');
    if(installBtn) {
        installBtn.style.display = 'flex'; 
        installBtn.addEventListener('click', async () => {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            if(outcome === 'accepted') installBtn.style.display = 'none'; 
            deferredPrompt = null;
        });
    }
});

// --- 1. INDEXEDDB ---
let db;
const request = indexedDB.open("SannMusicDB", 1);
request.onupgradeneeded = function(e) {
    db = e.target.result;
    if(!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
    if(!db.objectStoreNames.contains('liked_songs')) db.createObjectStore('liked_songs', { keyPath: 'videoId' });
};
request.onsuccess = function(e) {
    db = e.target.result;
    window._sannDB = db; // expose untuk firebase-sync.js
    renderLibraryUI();
};

// --- 2. STATE ---
let ytPlayer, isPlaying = false, currentTrack = null, progressInterval;
let queue = [], currentQueueIndex = -1;
let repeatMode = 0; // 0=off, 1=all, 2=one
let sleepTimer = null;
let nowPlayingVideoId = null;

// --- 3. YOUTUBE API ---
function onYouTubeIframeAPIReady() {
    ytPlayer = new YT.Player('youtube-player', {
        height: '1', width: '1',
        playerVars: { 'playsinline': 1, 'controls': 0, 'disablekb': 1 },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady() { setupSwipeGesture(); }

function onPlayerStateChange(event) {
    const mainPlayBtn = document.getElementById('mainPlayBtn');
    const miniPlayBtn = document.getElementById('miniPlayBtn');
    const playPath = "M8 5v14l11-7z";
    const pausePath = "M6 19h4V5H6v14zm8-14v14h4V5h-4z";

    if (event.data == YT.PlayerState.PLAYING) {
        isPlaying = true;
        mainPlayBtn.innerHTML = `<path d="${pausePath}"></path>`;
        miniPlayBtn.innerHTML = `<path d="${pausePath}"></path>`;
        startProgressBar();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        updateNowPlayingIndicator();
        // Vinyl + visualizer + particles
        updateVinylState(true);
        startVisualizer();
        startParticles();
    } else if (event.data == YT.PlayerState.PAUSED) {
        isPlaying = false;
        mainPlayBtn.innerHTML = `<path d="${playPath}"></path>`;
        miniPlayBtn.innerHTML = `<path d="${playPath}"></path>`;
        stopProgressBar();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
        updateNowPlayingIndicator();
        updateVinylState(false);
        stopVisualizer();
        stopParticles();
    } else if (event.data == YT.PlayerState.ENDED) {
        isPlaying = false;
        mainPlayBtn.innerHTML = `<path d="${playPath}"></path>`;
        miniPlayBtn.innerHTML = `<path d="${playPath}"></path>`;
        stopProgressBar();
        updateVinylState(false);
        stopVisualizer();
        handleSongEnd();
    }
}

// --- REPEAT & QUEUE ---
function handleSongEnd() {
    if (repeatMode === 2) {
        ytPlayer.seekTo(0); ytPlayer.playVideo(); return;
    }
    if (queue.length > 0 && currentQueueIndex < queue.length - 1) {
        currentQueueIndex++;
        const next = queue[currentQueueIndex];
        playMusic(next.videoId, encodeURIComponent(JSON.stringify(next)));
    } else if (repeatMode === 1 && queue.length > 0) {
        currentQueueIndex = 0;
        const next = queue[currentQueueIndex];
        playMusic(next.videoId, encodeURIComponent(JSON.stringify(next)));
    } else {
        playNextSimilarSong();
    }
}

function toggleRepeat() {
    repeatMode = (repeatMode + 1) % 3;
    const btn = document.getElementById('repeatBtn');
    const svgPath = `<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"></path>`;
    if (repeatMode === 0) {
        btn.style.fill = 'rgba(255,255,255,0.5)'; btn.innerHTML = svgPath;
        showToast('Ulangi: Mati');
    } else if (repeatMode === 1) {
        btn.style.fill = 'var(--spotify-green)'; btn.innerHTML = svgPath;
        showToast('Ulangi: Semua');
    } else {
        btn.style.fill = 'var(--spotify-green)';
        btn.innerHTML = `${svgPath}<text x="12" y="13.5" text-anchor="middle" fill="var(--spotify-green)" font-size="7" font-weight="bold" font-family="Arial">1</text>`;
        showToast('Ulangi: 1 Lagu');
    }
}

function addToQueue(track) {
    queue.push(track);
    if (currentQueueIndex === -1) currentQueueIndex = 0;
    showToast('Ditambahkan ke antrian');
    renderQueueModal();
}

function openQueueModal() { renderQueueModal(); document.getElementById('queueModal').style.display = 'flex'; }
function closeQueueModal() { document.getElementById('queueModal').style.display = 'none'; }

function renderQueueModal() {
    const container = document.getElementById('queueList');
    if (queue.length === 0) {
        container.innerHTML = '<div style="color:#a7a7a7;text-align:center;padding:30px 20px;">Antrian kosong.<br><small>Tekan ⋮ di lagu untuk tambah ke antrian.</small></div>';
        return;
    }
    let html = '';
    queue.forEach((t, i) => {
        const isActive = i === currentQueueIndex;
        html += `
            <div class="v-item" style="padding:10px 0;border-bottom:1px solid #333;${isActive ? 'opacity:1' : 'opacity:0.7'}">
                <div style="position:relative;width:48px;height:48px;flex-shrink:0;">
                    <img src="${t.img}" class="v-img" onerror="this.src='https://placehold.co/48x48/282828/FFFFFF?text=Music'" style="width:100%;height:100%;">
                    ${isActive && isPlaying ? '<div class="equalizer-bars"><span></span><span></span><span></span></div>' : ''}
                </div>
                <div class="v-info">
                    <div class="v-title" style="${isActive ? 'color:var(--spotify-green)' : ''}">${t.title}</div>
                    <div class="v-sub">${t.artist}${isActive ? ' · Sedang diputar' : ''}</div>
                </div>
                <svg onclick="removeFromQueue(${i})" viewBox="0 0 24 24" style="fill:#a7a7a7;width:20px;height:20px;cursor:pointer;flex-shrink:0;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg>
            </div>`;
    });
    container.innerHTML = html;
}

function removeFromQueue(index) {
    queue.splice(index, 1);
    if (currentQueueIndex >= queue.length) currentQueueIndex = queue.length - 1;
    renderQueueModal();
}

// --- SLEEP TIMER ---
function openSleepTimerModal() { document.getElementById('sleepTimerModal').style.display = 'flex'; }
function closeSleepTimerModal() { document.getElementById('sleepTimerModal').style.display = 'none'; }

function setSleepTimer(minutes) {
    if (sleepTimer) { clearInterval(sleepTimer); sleepTimer = null; }
    const indicator = document.getElementById('sleepTimerIndicator');
    if (minutes === 0) {
        indicator.style.display = 'none';
        showToast('Sleep timer dimatikan');
        closeSleepTimerModal(); return;
    }
    let remaining = minutes * 60;
    indicator.style.display = 'flex';
    const updateDisplay = () => {
        const m = Math.floor(remaining / 60), s = remaining % 60;
        const el = document.getElementById('sleepTimerCountdown');
        if(el) el.innerText = `${m}:${s < 10 ? '0' : ''}${s}`;
    };
    updateDisplay();
    showToast(`Sleep timer: ${minutes} menit`);
    closeSleepTimerModal();
    sleepTimer = setInterval(() => {
        remaining--;
        updateDisplay();
        if (remaining <= 0) {
            clearInterval(sleepTimer); sleepTimer = null;
            indicator.style.display = 'none';
            if (ytPlayer) ytPlayer.pauseVideo();
            showToast('Sleep timer: Musik dijeda');
        }
    }, 1000);
}

// --- SWIPE GESTURE ---
function setupSwipeGesture() {
    const modal = document.getElementById('playerModal');
    let startX = 0, startY = 0;
    modal.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    }, { passive: true });
    modal.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 60) {
            if (dx < 0) { handleSongEnd(); showToast('Lagu berikutnya'); }
            else {
                if (ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getCurrentTime() > 3) {
                    ytPlayer.seekTo(0); showToast('Mulai ulang');
                } else if (queue.length > 0 && currentQueueIndex > 0) {
                    currentQueueIndex--;
                    const prev = queue[currentQueueIndex];
                    playMusic(prev.videoId, encodeURIComponent(JSON.stringify(prev)));
                    showToast('Lagu sebelumnya');
                }
            }
        }
        if (dy > 80 && Math.abs(dx) < 40) minimizePlayer();
    }, { passive: true });
}

// --- NOW PLAYING INDICATOR ---
function updateNowPlayingIndicator() {
    document.querySelectorAll('.v-item').forEach(el => el.classList.remove('now-playing'));
    document.querySelectorAll('.v-title').forEach(el => el.style.color = '');
    if (currentTrack && isPlaying) {
        document.querySelectorAll(`[data-videoid="${currentTrack.videoId}"]`).forEach(el => el.classList.add('now-playing'));
    }
}

function updateMediaSession() {
    if ('mediaSession' in navigator && currentTrack) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: currentTrack.title, artist: currentTrack.artist,
            artwork: [{ src: currentTrack.img, sizes: '512x512', type: 'image/png' }]
        });
        navigator.mediaSession.setActionHandler('play', togglePlay);
        navigator.mediaSession.setActionHandler('pause', togglePlay);
        navigator.mediaSession.setActionHandler('nexttrack', handleSongEnd);
    }
}

async function playNextSimilarSong() {
    if (!currentTrack) return;
    try {
        const response = await fetch(`/api/search?query=${encodeURIComponent(currentTrack.artist + " official audio")}`);
        const result = await response.json();
        if (result.status === 'success' && result.data.length > 0) {
            const related = result.data.filter(t => t.videoId !== currentTrack.videoId);
            if (related.length > 0) {
                const next = related[Math.floor(Math.random() * related.length)];
                let img = getHighResImage(next.thumbnail || next.img || 'https://placehold.co/140x140/282828/FFFFFF?text=Music');
                const trackData = encodeURIComponent(JSON.stringify({videoId: next.videoId, title: next.title, artist: next.artist || 'Unknown', img}));
                playMusic(next.videoId, trackData);
            }
        }
    } catch (e) {}
}

function playMusic(videoId, encodedTrackData) {
    currentTrack = JSON.parse(decodeURIComponent(encodedTrackData));
    nowPlayingVideoId = videoId;
    checkIfLiked(currentTrack.videoId);

    // Simpan riwayat putar
    addPlayHistory(currentTrack);

    document.getElementById('miniPlayer').style.display = 'flex';
    document.getElementById('miniPlayerImg').src = currentTrack.img;
    document.getElementById('miniPlayerTitle').innerText = currentTrack.title;
    document.getElementById('miniPlayerArtist').innerText = currentTrack.artist;

    document.getElementById('playerArt').src = currentTrack.img;
    document.getElementById('playerTitle').innerText = currentTrack.title;
    document.getElementById('playerArtist').innerText = currentTrack.artist;
    document.getElementById('playerBg').style.backgroundImage = `url('${currentTrack.img}')`;
    document.getElementById('playerHeaderTitle').innerText = currentTrack.artist;

    updateMediaSession();
    if (ytPlayer && ytPlayer.loadVideoById) ytPlayer.loadVideoById(videoId);

    document.getElementById('progressBar').value = 0;
    document.getElementById('currentTime').innerText = "0:00";
    document.getElementById('totalTime').innerText = "0:00";
    setTimeout(updateNowPlayingIndicator, 300);

    // Update vinyl cover + visibility
    updateVinylCover(currentTrack.img || '');
    updateVinylVisibility();
    // Reset speed ke 1x setiap ganti lagu
    resetPlaybackSpeed();
}

function togglePlay() {
    if (!ytPlayer) return;
    if (isPlaying) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
}

function expandPlayer() { document.getElementById('playerModal').style.display = 'flex'; }
function minimizePlayer() { document.getElementById('playerModal').style.display = 'none'; }

function formatTime(s) { const m = Math.floor(s/60); const sec = Math.floor(s%60); return `${m}:${sec<10?'0':''}${sec}`; }

function startProgressBar() {
    stopProgressBar();
    progressInterval = setInterval(() => {
        if (ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getDuration) {
            const cur = ytPlayer.getCurrentTime(), dur = ytPlayer.getDuration();
            if (dur > 0) {
                const pct = (cur/dur)*100;
                const pb = document.getElementById('progressBar');
                pb.value = pct;
                pb.style.background = `linear-gradient(to right, white ${pct}%, rgba(255,255,255,0.2) ${pct}%)`;
                document.getElementById('currentTime').innerText = formatTime(cur);
                document.getElementById('totalTime').innerText = formatTime(dur);
            }
        }
    }, 1000);
}

function stopProgressBar() { clearInterval(progressInterval); }

function seekTo(value) {
    if (ytPlayer && ytPlayer.getDuration) {
        const dur = ytPlayer.getDuration();
        ytPlayer.seekTo((value/100)*dur, true);
        document.getElementById('progressBar').style.background = `linear-gradient(to right, white ${value}%, rgba(255,255,255,0.2) ${value}%)`;
    }
}

// --- TOAST ---
let toastTimeout;
function showToast(message) {
    const toast = document.getElementById('customToast');
    toast.innerText = message;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}

// --- NAVIGASI ---
function switchView(viewName) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById('view-' + viewName).classList.add('active');
    const navItems = document.querySelectorAll('.bottom-nav .nav-item');
    navItems.forEach(n => n.classList.remove('active'));
    // Fix: settings di index 3, developer juga highlight settings (index 3)
    const map = {home:0, search:1, library:2, settings:3, developer:3};
    if (map[viewName] !== undefined) navItems[map[viewName]]?.classList.add('active');
    else if(viewName==='home') navItems[0].classList.add('active');
    else if(viewName==='search') navItems[1].classList.add('active');
    else if(viewName==='library') { navItems[2].classList.add('active'); renderLibraryUI(); }
    window.scrollTo(0,0);
}

// --- RENDER HELPERS ---
const dotsSvg = (track) => {
    const td = encodeURIComponent(JSON.stringify(track));
    return `<svg class="dots-icon" viewBox="0 0 24 24" onclick="event.stopPropagation();openTrackMenu('${td}')"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"></path></svg>`;
};

// --- TRACK CONTEXT MENU ---
let contextTrack = null;
function openTrackMenu(encodedTrackData) {
    contextTrack = JSON.parse(decodeURIComponent(encodedTrackData));
    document.getElementById('trackMenuTitle').innerText = contextTrack.title;
    document.getElementById('trackMenuArtist').innerText = contextTrack.artist;
    document.getElementById('trackMenuImg').src = contextTrack.img;
    document.getElementById('trackMenuModal').style.display = 'flex';
}
function closeTrackMenu() { document.getElementById('trackMenuModal').style.display = 'none'; contextTrack = null; }
function trackMenuAddToQueue() { if(!contextTrack) return; addToQueue({...contextTrack}); closeTrackMenu(); }
function trackMenuAddToPlaylist() { if(!contextTrack) return; currentTrack = contextTrack; closeTrackMenu(); openAddToPlaylistModal(); }
function trackMenuLike() {
    if(!contextTrack) return;
    if(!db) { showToast('Database belum siap, coba lagi.'); return; }
    const tx = db.transaction("liked_songs","readwrite");
    const store = tx.objectStore("liked_songs");
    const req = store.get(contextTrack.videoId);
    req.onsuccess = () => {
        if(req.result) {
            store.delete(contextTrack.videoId);
            showToast('Dihapus dari Lagu yang Disukai');
            if(window.firebaseSync?.isLoggedIn()) window.firebaseSync._pushOneLikedDelete && window.firebaseSync._pushOneLikedDelete(contextTrack);
        } else {
            store.put(contextTrack);
            showToast('Ditambahkan ke Lagu yang Disukai');
            if(window.firebaseSync?.isLoggedIn()) window.firebaseSync._pushOneLikedAdd && window.firebaseSync._pushOneLikedAdd(contextTrack);
        }
        renderLibraryUI();
    };
    closeTrackMenu();
}

function getHighResImage(url) {
    if(!url) return url;
    if(url.match(/=w\d+-h\d+/)) return url.replace(/=w\d+-h\d+[^&]*/g,'=w512-h512-l90-rj');
    return url;
}

// SKELETON LOADING
function createSkeletonList(count=4) {
    let h='';
    for(let i=0;i<count;i++) h+=`<div class="v-item"><div class="skeleton" style="width:48px;height:48px;border-radius:4px;flex-shrink:0;"></div><div class="v-info"><div class="skeleton" style="height:14px;width:70%;border-radius:4px;margin-bottom:8px;"></div><div class="skeleton" style="height:12px;width:45%;border-radius:4px;"></div></div></div>`;
    return h;
}
function createSkeletonCards(count=6) {
    let h='';
    for(let i=0;i<count;i++) h+=`<div class="h-card"><div class="skeleton" style="width:140px;height:140px;border-radius:8px;margin-bottom:8px;"></div><div class="skeleton" style="height:12px;width:80%;border-radius:4px;margin-bottom:6px;"></div><div class="skeleton" style="height:10px;width:55%;border-radius:4px;"></div></div>`;
    return h;
}

function createListHTML(track) {
    let img = getHighResImage(track.thumbnail || track.img || 'https://placehold.co/48x48/282828/FFFFFF?text=Music');
    const artist = track.artist || 'Unknown';
    const obj = {videoId:track.videoId, title:track.title, artist, img};
    const td = encodeURIComponent(JSON.stringify(obj));
    const active = currentTrack && currentTrack.videoId === track.videoId;
    return `
        <div class="v-item ${active?'now-playing':''}" data-videoid="${track.videoId}" onclick="playMusic('${track.videoId}','${td}')">
            <div style="position:relative;width:48px;height:48px;flex-shrink:0;">
                <img src="${img}" class="v-img" onerror="this.src='https://placehold.co/48x48/282828/FFFFFF?text=Music'" style="width:100%;height:100%;">
                ${active&&isPlaying?'<div class="equalizer-bars"><span></span><span></span><span></span></div>':''}
            </div>
            <div class="v-info">
                <div class="v-title" style="${active?'color:var(--spotify-green)':''}">  ${track.title}</div>
                <div class="v-sub">${artist}</div>
            </div>
            ${dotsSvg(obj)}
        </div>`;
}

function createCardHTML(track, isArtist=false) {
    let img = getHighResImage(track.thumbnail || track.img || 'https://placehold.co/140x140/282828/FFFFFF?text=Music');
    const artist = track.artist || 'Unknown';
    const td = encodeURIComponent(JSON.stringify({videoId:track.videoId, title:track.title, artist, img}));
    const click = isArtist ? `openArtistView('${track.title}')` : `playMusic('${track.videoId}','${td}')`;
    return `
        <div class="h-card" onclick="${click}">
            <img src="${img}" class="h-img${isArtist?' artist-img':''}" onerror="this.src='https://placehold.co/140x140/282828/FFFFFF?text=Music'">
            <div class="h-title">${track.title}</div>
            <div class="h-sub">${isArtist?'Artis':artist}</div>
        </div>`;
}

let homeDisplayedVideoIds = new Set();
async function fetchAndRender(query, containerId, formatType, isArtist=false, isHome=false) {
    const el = document.getElementById(containerId);
    if(el) el.innerHTML = formatType==='list' ? createSkeletonList() : createSkeletonCards();
    try {
        const res = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
        const result = await res.json();
        if(result.status==='success') {
            const limit = containerId==='recentList' ? 4 : (formatType==='list' ? 4 : 8);
            let tracks=[];
            for(let t of result.data) {
                if(isHome) { if(!homeDisplayedVideoIds.has(t.videoId)) { tracks.push(t); homeDisplayedVideoIds.add(t.videoId); } }
                else tracks.push(t);
                if(tracks.length>=limit) break;
            }
            let html=''; tracks.forEach(t => html += formatType==='list'?createListHTML(t):createCardHTML(t,isArtist));
            if(el) el.innerHTML = html || '<div style="color:#a7a7a7;font-size:13px;">Tidak ada hasil.</div>';
        }
    } catch(e) { if(el) el.innerHTML='<div style="color:#a7a7a7;font-size:13px;">Gagal memuat.</div>'; }
}

function loadHomeData() {
    homeDisplayedVideoIds.clear();
    fetchAndRender('lagu indonesia hits terbaru','recentList','list',false,true);
    fetchAndRender('lagu pop indonesia rilis terbaru','rowAnyar','card',false,true);
    fetchAndRender('lagu ceria gembira semangat','rowGembira','card',false,true);
    fetchAndRender('top 50 indonesia playlist update','rowCharts','card',false,true);
    fetchAndRender('lagu galau sedih indonesia terpopuler','rowGalau','card',false,true);
    fetchAndRender('lagu viral terbaru 2026','rowBaru','card',false,true);
    fetchAndRender('lagu fyp tiktok viral','rowTiktok','card',false,true);
    fetchAndRender('penyanyi pop indonesia paling hits','rowArtists','card',true,true);
    fetchAndRender('hit terpopuler hari ini','rowHitsHariIni','card',false,true);
    fetchAndRender('playlist dibuat untuk tiktok','rowUntukTiktok','card',false,true);
    fetchAndRender('album dan single populer','rowAlbumSingle','card',false,true);
}

// --- SEARCH HISTORY ---
function getSearchHistory() { try { return JSON.parse(localStorage.getItem('searchHistory')||'[]'); } catch { return []; } }
function addSearchHistory(q) {
    let h = getSearchHistory().filter(x=>x!==q);
    h.unshift(q); h=h.slice(0,10);
    localStorage.setItem('searchHistory', JSON.stringify(h));
    // Sync ke Firebase
    if(window.firebaseSync?.isLoggedIn()) window.firebaseSync._pushSearchHistory && window.firebaseSync._pushSearchHistory(h);
}
function clearSearchHistory() { localStorage.removeItem('searchHistory'); renderSearchHistory(); showToast('Riwayat pencarian dihapus'); }
function removeSearchHistory(query) {
    let h = getSearchHistory().filter(q=>q!==query);
    localStorage.setItem('searchHistory',JSON.stringify(h));
    renderSearchHistory();
}
function renderSearchHistory() {
    const history = getSearchHistory();
    const sec = document.getElementById('searchHistorySection');
    const con = document.getElementById('searchHistoryContainer');
    if(!history.length) { if(sec) sec.style.display='none'; return; }
    if(sec) sec.style.display='block';
    let html='';
    history.forEach(q => {
        const safe = q.replace(/'/g,"\\'").replace(/"/g,'&quot;');
        html+=`<div class="search-history-item" onclick="doSearch('${safe}')">
            <svg viewBox="0 0 24 24" style="fill:var(--text-sub);width:18px;height:18px;flex-shrink:0;"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"></path></svg>
            <span style="flex:1;font-size:14px;">${q}</span>
            <svg viewBox="0 0 24 24" onclick="event.stopPropagation();removeSearchHistory('${safe}')" style="fill:var(--text-sub);width:18px;height:18px;cursor:pointer;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg>
        </div>`;
    });
    if(con) con.innerHTML=html;
}

function doSearch(query) {
    document.getElementById('searchInput').value = query;
    document.getElementById('searchCategoriesUI').style.display = 'none';
    document.getElementById('searchHistorySection').style.display = 'none';
    document.getElementById('searchResultsUI').style.display = 'block';
    document.getElementById('searchResults').innerHTML = createSkeletonList(6);
    addSearchHistory(query);
    fetch(`/api/search?query=${encodeURIComponent(query)}`)
        .then(r=>r.json())
        .then(result => {
            if(result.status==='success') {
                let html=''; result.data.forEach(t=>html+=createListHTML(t));
                document.getElementById('searchResults').innerHTML = html||'<div style="color:#a7a7a7;text-align:center;">Tidak ada hasil.</div>';
            }
        }).catch(()=>{});
}

// CATEGORY SEARCH
function renderSearchCategories() {
    const cats = [
        {title:'Dibuat Untuk Kamu',color:'#8d67ab',img:'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=100&q=80',query:'lagu rekomendasi indonesia'},
        {title:'Rilis Baru',color:'#739c18',img:'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=100&q=80',query:'lagu baru rilis terbaru 2026'},
        {title:'Pop',color:'#477d95',img:'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=100&q=80',query:'lagu pop indonesia hits'},
        {title:'Indie',color:'#e1118c',img:'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=100&q=80',query:'lagu indie indonesia populer'},
        {title:'Musik Indonesia',color:'#e8115b',img:'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=100&q=80',query:'lagu indonesia terpopuler'},
        {title:'Tangga Lagu',color:'#8d67ab',img:'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=100&q=80',query:'top chart tangga lagu indonesia'},
        {title:'K-pop',color:'#e8115b',img:'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=100&q=80',query:'kpop hits terbaru'},
        {title:'Viral TikTok',color:'#188653',img:'https://images.unsplash.com/photo-1584551246679-0daf3d275d0f?w=100&q=80',query:'lagu viral tiktok fyp 2026'},
        {title:'R&B / Soul',color:'#1e3264',img:'https://images.unsplash.com/photo-1593697821252-0c9137d9fc45?w=100&q=80',query:'rnb soul hits populer'},
        {title:'Galau & Sedih',color:'#c0392b',img:'https://images.unsplash.com/photo-1507838153414-b4b713384a76?w=100&q=80',query:'lagu galau sedih indonesia'},
    ];
    let html='';
    cats.forEach(cat=>{
        html+=`<div class="category-card" style="background-color:${cat.color}" onclick="doSearch('${cat.query}');switchView('search');">
            <div class="category-title">${cat.title}</div>
            <img src="${cat.img}" class="category-img">
        </div>`;
    });
    document.getElementById('categoryGrid').innerHTML = html;
}

let searchTimeout;
document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if(!q) {
        document.getElementById('searchCategoriesUI').style.display='block';
        document.getElementById('searchResultsUI').style.display='none';
        renderSearchHistory(); return;
    }
    document.getElementById('searchCategoriesUI').style.display='none';
    document.getElementById('searchHistorySection').style.display='none';
    document.getElementById('searchResultsUI').style.display='block';
    document.getElementById('searchResults').innerHTML = createSkeletonList(6);
    searchTimeout = setTimeout(()=>doSearch(q), 800);
});

document.getElementById('searchInput').addEventListener('focus', ()=>{
    if(!document.getElementById('searchInput').value.trim()) renderSearchHistory();
});

async function openArtistView(artistName) {
    document.getElementById('artistNameDisplay').innerText = artistName;
    document.getElementById('artistTracksContainer').innerHTML = createSkeletonList(6);
    switchView('artist');
    try {
        const res = await fetch(`/api/search?query=${encodeURIComponent(artistName + " official audio")}`);
        const result = await res.json();
        if(result.status==='success') {
            let html=''; result.data.forEach(t=>html+=createListHTML(t));
            document.getElementById('artistTracksContainer').innerHTML=html;
            if(result.data.length>0) {
                const ft=result.data[0];
                let img=getHighResImage(ft.thumbnail||ft.img||'https://placehold.co/48x48/282828/FFFFFF?text=Music');
                const td=encodeURIComponent(JSON.stringify({videoId:ft.videoId,title:ft.title,artist:ft.artist||'Unknown',img}));
                document.querySelector('.artist-play-btn').setAttribute('onclick',`playMusic('${ft.videoId}','${td}')`);
            }
        }
    } catch(e){}
}

function checkIfLiked(videoId) {
    const tx=db.transaction("liked_songs","readonly");
    const req=tx.objectStore("liked_songs").get(videoId);
    req.onsuccess=()=>{
        const btn=document.getElementById('btnLikeSong');
        btn.style.fill=req.result?'#1ed760':'white';
    };
}

function toggleLike() {
    if(!currentTrack) return;
    const tx=db.transaction("liked_songs","readwrite");
    const store=tx.objectStore("liked_songs");
    const req=store.get(currentTrack.videoId);
    req.onsuccess=()=>{
        const btn=document.getElementById('btnLikeSong');
        if(req.result) {
            store.delete(currentTrack.videoId);
            btn.style.fill='white';
            showToast('Dihapus dari Lagu yang Disukai');
            if(window.firebaseSync?.isLoggedIn()) window.firebaseSync._pushOneLikedDelete && window.firebaseSync._pushOneLikedDelete(currentTrack);
        } else {
            store.put(currentTrack);
            btn.style.fill='#1ed760';
            showToast('Ditambahkan ke Lagu yang Disukai');
            if(window.firebaseSync?.isLoggedIn()) window.firebaseSync._pushOneLikedAdd && window.firebaseSync._pushOneLikedAdd(currentTrack);
        }
        renderLibraryUI();
    };
}

function renderLibraryUI() {
    if(!db) return;
    const container=document.getElementById('libraryContainer');
    const tx=db.transaction("liked_songs","readonly");
    const req=tx.objectStore("liked_songs").getAll();
    req.onsuccess=()=>{
        let html=`<div class="lib-item" onclick="openPlaylistView('liked')">
            <div class="lib-item-img liked"><svg viewBox="0 0 24 24" style="fill:white;width:28px;height:28px;"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"></path></svg></div>
            <div class="lib-item-info">
                <div class="lib-item-title">Lagu yang Disukai</div>
                <div class="lib-item-sub"><svg class="pin-icon" viewBox="0 0 24 24"><path d="M12 2L15 8l6 1-4.5 4.5L18 20l-6-3-6 3 1.5-6.5L3 9l6-1z"></path></svg> Playlist • ${req.result.length} lagu</div>
            </div>
        </div>`;
        const txP=db.transaction("playlists","readonly");
        const reqP=txP.objectStore("playlists").getAll();
        reqP.onsuccess=()=>{
            reqP.result.forEach(p=>{
                html+=`<div class="lib-item">
                    <img src="${p.img||'https://via.placeholder.com/120?text=+'}" class="lib-item-img" onerror="this.src='https://via.placeholder.com/120?text=+'" onclick="openPlaylistView('${p.id}')">
                    <div class="lib-item-info" onclick="openPlaylistView('${p.id}')">
                        <div class="lib-item-title">${p.name}</div>
                        <div class="lib-item-sub">Playlist • ${(p.tracks||[]).length} lagu</div>
                    </div>
                    <svg viewBox="0 0 24 24" onclick="event.stopPropagation();openPlaylistOptions('${p.id}')" style="fill:var(--text-sub);width:24px;height:24px;cursor:pointer;flex-shrink:0;"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"></path></svg>
                </div>`;
            });
            html+=`<div class="lib-item"><div class="lib-item-img add-btn circle"><svg viewBox="0 0 24 24" style="fill:white;width:32px;height:32px;"><path d="M11 11V4h2v7h7v2h-7v7h-2v-7H4v-2h7z"></path></svg></div><div class="lib-item-info"><div class="lib-item-title">Tambahkan artis</div></div></div>
            <div class="lib-item"><div class="lib-item-img add-btn add-btn-sq"><svg viewBox="0 0 24 24" style="fill:white;width:32px;height:32px;"><path d="M11 11V4h2v7h7v2h-7v7h-2v-7H4v-2h7z"></path></svg></div><div class="lib-item-info"><div class="lib-item-title">Tambahkan podcast</div></div></div>`;
            container.innerHTML=html;
        };
    };
}

// PLAYLIST OPTIONS (rename/delete)
let currentPlaylistOptionsId=null;
function openPlaylistOptions(id) { currentPlaylistOptionsId=id; document.getElementById('playlistOptionsModal').style.display='flex'; }
function closePlaylistOptions() { document.getElementById('playlistOptionsModal').style.display='none'; currentPlaylistOptionsId=null; }

function renamePlaylistPrompt() {
    closePlaylistOptions();
    const newName=prompt('Nama baru untuk playlist:');
    if(!newName||!newName.trim()) return;
    const tx=db.transaction("playlists","readwrite");
    const store=tx.objectStore("playlists");
    const req=store.get(currentPlaylistOptionsId);
    req.onsuccess=()=>{ const p=req.result; p.name=newName.trim(); store.put(p); tx.oncomplete=()=>{ renderLibraryUI(); showToast('Playlist diubah namanya'); }; };
}

function deletePlaylistConfirm() {
    closePlaylistOptions();
    if(!confirm('Hapus playlist ini?')) return;
    const tx=db.transaction("playlists","readwrite");
    tx.objectStore("playlists").delete(currentPlaylistOptionsId);
    tx.oncomplete=()=>{ renderLibraryUI(); showToast('Playlist dihapus'); };
}

// HAPUS LAGU DARI PLAYLIST
function removeTrackFromPlaylist(playlistId, videoId) {
    if(playlistId==='liked') {
        const tx=db.transaction("liked_songs","readwrite");
        tx.objectStore("liked_songs").delete(videoId);
        tx.oncomplete=()=>{ openPlaylistView('liked'); showToast('Dihapus dari Lagu yang Disukai'); };
        return;
    }
    const tx=db.transaction("playlists","readwrite");
    const store=tx.objectStore("playlists");
    const req=store.get(playlistId);
    req.onsuccess=()=>{
        const p=req.result;
        p.tracks=(p.tracks||[]).filter(t=>t.videoId!==videoId);
        store.put(p);
        tx.oncomplete=()=>{ openPlaylistView(playlistId); showToast('Lagu dihapus dari playlist'); };
    };
}

let currentViewPlaylistId=null, currentPlaylistTracks=[];

function openPlaylistView(id) {
    currentViewPlaylistId=id;
    switchView('playlist');
    const con=document.getElementById('playlistTracksContainer');
    con.innerHTML=createSkeletonList();
    if(id==='liked') {
        document.getElementById('playlistNameDisplay').innerText="Lagu yang Disukai";
        document.getElementById('playlistImageDisplay').src="1ced33a183cb33692d94252ad74fa4d9 (1).jpg";
        const tx=db.transaction("liked_songs","readonly");
        const req=tx.objectStore("liked_songs").getAll();
        req.onsuccess=()=>{ currentPlaylistTracks=req.result; document.getElementById('playlistStatsDisplay').innerText=`${req.result.length} lagu disimpan`; renderTracksInPlaylist(req.result,id); };
    } else {
        const tx=db.transaction("playlists","readonly");
        const req=tx.objectStore("playlists").get(id);
        req.onsuccess=()=>{
            const p=req.result;
            currentPlaylistTracks=p.tracks||[];
            document.getElementById('playlistNameDisplay').innerText=p.name;
            document.getElementById('playlistImageDisplay').src=p.img||'https://via.placeholder.com/240/282828/ffffff?text=+';
            document.getElementById('playlistStatsDisplay').innerText=`${(p.tracks||[]).length} lagu disimpan`;
            renderTracksInPlaylist(p.tracks||[],id);
        };
    }
}

function playFirstPlaylistTrack() {
    if(currentPlaylistTracks&&currentPlaylistTracks.length>0) {
        queue=[...currentPlaylistTracks]; currentQueueIndex=0;
        const ft=currentPlaylistTracks[0];
        playMusic(ft.videoId, encodeURIComponent(JSON.stringify(ft)));
        showToast('Memutar playlist');
    }
}

function renderTracksInPlaylist(tracks, playlistId) {
    const con=document.getElementById('playlistTracksContainer');
    if(!tracks||!tracks.length) { con.innerHTML='<div style="color:var(--text-sub);text-align:center;padding:20px;">Playlist ini masih kosong.</div>'; return; }
    let html='';
    tracks.forEach(t=>{
        const img=t.img||t.thumbnail||'https://placehold.co/48x48/282828/FFFFFF?text=Music';
        const td=encodeURIComponent(JSON.stringify(t));
        const active=currentTrack&&currentTrack.videoId===t.videoId;
        html+=`<div class="v-item ${active?'now-playing':''}" data-videoid="${t.videoId}">
            <div style="position:relative;width:48px;height:48px;flex-shrink:0;" onclick="playMusic('${t.videoId}','${td}')">
                <img src="${img}" class="v-img" onerror="this.src='https://placehold.co/48x48/282828/FFFFFF?text=Music'" style="width:100%;height:100%;">
                ${active&&isPlaying?'<div class="equalizer-bars"><span></span><span></span><span></span></div>':''}
            </div>
            <div class="v-info" onclick="playMusic('${t.videoId}','${td}')">
                <div class="v-title" style="${active?'color:var(--spotify-green)':''}"> ${t.title}</div>
                <div class="v-sub">${t.artist}</div>
            </div>
            <svg viewBox="0 0 24 24" onclick="removeTrackFromPlaylist('${playlistId}','${t.videoId}')" style="fill:#a7a7a7;width:22px;height:22px;cursor:pointer;flex-shrink:0;" title="Hapus dari playlist"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"></path></svg>
        </div>`;
    });
    con.innerHTML=html;
}

let base64PlaylistImage='';
function openCreatePlaylist() { document.getElementById('createPlaylistModal').style.display='block'; }
function closeCreatePlaylist() { document.getElementById('createPlaylistModal').style.display='none'; document.getElementById('cpName').value=''; document.getElementById('cpPreview').src='https://via.placeholder.com/120x120?text=+'; base64PlaylistImage=''; }
function previewImage(e) { const f=e.target.files[0]; const r=new FileReader(); r.onloadend=()=>{ document.getElementById('cpPreview').src=r.result; base64PlaylistImage=r.result; }; if(f) r.readAsDataURL(f); }
function saveNewPlaylist() {
    const name=document.getElementById('cpName').value||"Playlist baruku";
    const p={id:Date.now().toString(),name,img:base64PlaylistImage,tracks:[]};
    const tx=db.transaction("playlists","readwrite");
    tx.objectStore("playlists").put(p);
    tx.oncomplete=()=>{ closeCreatePlaylist(); renderLibraryUI(); showToast('Playlist baru dibuat'); };
}

function openAddToPlaylistModal() {
    if(!currentTrack) return;
    const tx=db.transaction("playlists","readonly");
    const req=tx.objectStore("playlists").getAll();
    req.onsuccess=()=>{
        let html='';
        req.result.forEach(p=>{ html+=`<div class="lib-item" onclick="addTrackToPlaylist('${p.id}')" style="margin-bottom:12px;cursor:pointer;"><img src="${p.img||'https://via.placeholder.com/50'}" style="width:50px;height:50px;object-fit:cover;border-radius:4px;" onerror="this.src='https://via.placeholder.com/50'"><div style="color:white;font-size:16px;">${p.name}</div></div>`; });
        if(!req.result.length) html='<div style="color:#a7a7a7;text-align:center;">Belum ada playlist. Buat dulu di Koleksi Kamu.</div>';
        document.getElementById('addToPlaylistList').innerHTML=html;
        document.getElementById('addToPlaylistModal').style.display='flex';
    };
}

function closeAddToPlaylistModal() { document.getElementById('addToPlaylistModal').style.display='none'; }

function addTrackToPlaylist(playlistId) {
    const tx=db.transaction("playlists","readwrite");
    const store=tx.objectStore("playlists");
    const req=store.get(playlistId);
    req.onsuccess=()=>{
        const p=req.result;
        if(!p.tracks) p.tracks=[];
        if(!p.tracks.find(t=>t.videoId===currentTrack.videoId)) { p.tracks.push(currentTrack); store.put(p); showToast('Ditambahkan ke '+p.name); }
        else showToast('Sudah ada di '+p.name);
        closeAddToPlaylistModal();
    };
}


// --- LYRICS ---
async function getLyrics() {
    if (!currentTrack) { showToast('Putar lagu dulu ya!'); return; }
    
    document.getElementById('lyricsTrackImg').src = currentTrack.img;
    document.getElementById('lyricsTrackTitle').innerText = currentTrack.title;
    document.getElementById('lyricsTrackArtist').innerText = currentTrack.artist;
    document.getElementById('lyricsBg').style.backgroundImage = `url('${currentTrack.img}')`;
    document.getElementById('lyricsModal').style.display = 'flex';
    document.getElementById('lyricsBody').innerHTML = '<div style="color:rgba(255,255,255,0.7);font-size:16px;text-align:center;margin-top:60px;">Menarik lirik dari server... ⏳</div>';

    try {
        const res = await fetch(`/api/lyrics?video_id=${currentTrack.videoId}`);
        const result = await res.json();
        if (result.status === 'success' && result.data && result.data.lyrics) {
            document.getElementById('lyricsBody').innerHTML = result.data.lyrics;
        } else {
            document.getElementById('lyricsBody').innerHTML = '<div style="color:rgba(255,255,255,0.6);font-size:16px;text-align:center;margin-top:60px;">😔 Lirik tidak tersedia untuk lagu ini.</div>';
        }
    } catch(e) {
        document.getElementById('lyricsBody').innerHTML = '<div style="color:#ff5252;font-size:16px;text-align:center;margin-top:60px;">Gagal memuat lirik. Cek koneksi internet.</div>';
    }
}

function closeLyrics() {
    document.getElementById('lyricsModal').style.display = 'none';
    document.getElementById('lyricsBody').innerHTML = '';
}

// --- PLAY HISTORY ---
function getPlayHistory() { try { return JSON.parse(localStorage.getItem('playHistory')||'[]'); } catch { return []; } }
function addPlayHistory(track) {
    let h = getPlayHistory().filter(t => t.videoId !== track.videoId);
    h.unshift({ videoId: track.videoId, title: track.title, artist: track.artist, img: track.img, playedAt: Date.now() });
    h = h.slice(0, 50);
    localStorage.setItem('playHistory', JSON.stringify(h));
    // Sync ke Firebase
    if(window.firebaseSync?.isLoggedIn()) window.firebaseSync._pushPlayHistory && window.firebaseSync._pushPlayHistory(h);
}

// --- SYNC ALL NOW ---
async function syncAllNow() {
    if(!window.firebaseSync?.isLoggedIn()) { showToast('Login dulu ya!'); return; }
    showToast('Menyinkron semua data...');
    // Liked songs
    const tx = db.transaction('liked_songs','readonly');
    const req = tx.objectStore('liked_songs').getAll();
    req.onsuccess = async () => {
        if(window.firebaseSync._pushLikedSongs) await window.firebaseSync._pushLikedSongs(req.result);
        // Playlists
        const tx2 = db.transaction('playlists','readonly');
        const req2 = tx2.objectStore('playlists').getAll();
        req2.onsuccess = async () => {
            if(window.firebaseSync._pushPlaylists) await window.firebaseSync._pushPlaylists(req2.result);
            if(window.firebaseSync._pushPlayHistory) await window.firebaseSync._pushPlayHistory(getPlayHistory());
            if(window.firebaseSync._pushSearchHistory) await window.firebaseSync._pushSearchHistory(getSearchHistory());
            showToast('Semua data berhasil disinkron');
        };
    };
}

window.renderLibraryUI = renderLibraryUI;
window.renderSearchHistory = renderSearchHistory;
window.syncAllNow = syncAllNow;


// ============================================================
// TEMA CUSTOM
// ============================================================
const THEMES = ['dark','light','amoled','gradient'];

function setTheme(theme) {
    THEMES.forEach(t => document.body.classList.remove('theme-' + t));
    if (theme !== 'dark') document.body.classList.add('theme-' + theme);
    localStorage.setItem('sann_theme', theme);
    // Update active swatch
    document.querySelectorAll('.theme-swatch').forEach(el => el.classList.remove('active'));
    const sw = document.getElementById('swatch-' + theme);
    if (sw) sw.classList.add('active');
    showToast('Tema ' + theme.charAt(0).toUpperCase() + theme.slice(1) + ' aktif');
}

function loadTheme() {
    const saved = localStorage.getItem('sann_theme') || 'dark';
    setTheme(saved);
}

// ============================================================
// SETTINGS - save/load toggles
// ============================================================
function saveSetting(key, val) {
    localStorage.setItem('sann_' + key, JSON.stringify(val));
    applySetting(key, val);
}

function applySetting(key, val) {
    if (key === 'glass') {
        document.body.classList.toggle('no-glass', !val);
    } else if (key === 'vinyl') {
        updateVinylVisibility();
    } else if (key === 'visualizer') {
        const viz = document.getElementById('visualizerContainer');
        if (viz) viz.style.display = val ? 'flex' : 'none';
    } else if (key === 'particles') {
        if (!val) stopParticles(); else if (isPlaying) startParticles();
    }
}

function loadSettings() {
    ['vinyl','visualizer','particles','glass'].forEach(key => {
        const val = localStorage.getItem('sann_' + key);
        const parsed = val === null ? true : JSON.parse(val);
        const el = document.getElementById('toggle' + key.charAt(0).toUpperCase() + key.slice(1));
        if (el) el.checked = parsed;
        applySetting(key, parsed);
    });
}

function getSetting(key) {
    const val = localStorage.getItem('sann_' + key);
    return val === null ? true : JSON.parse(val);
}

// ============================================================
// PLAYBACK SPEED
// ============================================================
const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
let currentSpeedIndex = 2; // default 1x

function cyclePlaybackSpeed() {
    if (!ytPlayer || !ytPlayer.setPlaybackRate) {
        showToast('Putar lagu dulu ya!');
        return;
    }
    currentSpeedIndex = (currentSpeedIndex + 1) % SPEED_STEPS.length;
    const speed = SPEED_STEPS[currentSpeedIndex];
    if (ytPlayer && ytPlayer.setPlaybackRate) {
        ytPlayer.setPlaybackRate(speed);
    }
    const btn = document.getElementById('speedBtn');
    if (btn) {
        btn.innerText = speed + 'x';
        // Highlight kalau bukan 1x
        btn.style.borderColor = speed === 1 ? 'white' : 'var(--spotify-green)';
        btn.style.color = speed === 1 ? 'white' : 'var(--spotify-green)';
    }
    showToast('Kecepatan: ' + speed + 'x');
}

// Reset speed ke 1x setiap ganti lagu
function resetPlaybackSpeed() {
    currentSpeedIndex = 2;
    const btn = document.getElementById('speedBtn');
    if (btn) {
        btn.innerText = '1x';
        btn.style.borderColor = 'white';
        btn.style.color = 'white';
    }
}

// ============================================================
// VINYL PLAYER
// ============================================================
function updateVinylVisibility() {
    const useVinyl = getSetting('vinyl');
    const wrapper = document.getElementById('vinylWrapper');
    const staticArt = document.getElementById('playerArt');
    if (wrapper) wrapper.style.display = useVinyl ? 'block' : 'none';
    if (staticArt) staticArt.style.display = useVinyl ? 'none' : 'block';
}

function updateVinylState(playing) {
    const disc = document.getElementById('vinylDisc');
    const needle = document.getElementById('vinylNeedle');
    if (!disc) return;
    if (playing) {
        disc.classList.add('playing');
        if (needle) { needle.classList.remove('off'); needle.classList.add('on'); }
    } else {
        disc.classList.remove('playing');
        if (needle) { needle.classList.remove('on'); needle.classList.add('off'); }
    }
}

function updateVinylCover(imgSrc) {
    const cover = document.getElementById('vinylCover');
    if (cover) cover.src = imgSrc;
}

// ============================================================
// AUDIO VISUALIZER
// ============================================================
let vizInterval = null;

function startVisualizer() {
    if (!getSetting('visualizer')) return;
    const bars = document.querySelectorAll('.viz-bar');
    const container = document.getElementById('visualizerContainer');
    if (container) container.classList.add('playing');
    if (vizInterval) clearInterval(vizInterval);
    vizInterval = setInterval(() => {
        bars.forEach(bar => {
            const h = Math.floor(Math.random() * 35) + 4;
            bar.style.height = h + 'px';
        });
    }, 120);
}

function stopVisualizer() {
    if (vizInterval) { clearInterval(vizInterval); vizInterval = null; }
    const bars = document.querySelectorAll('.viz-bar');
    const container = document.getElementById('visualizerContainer');
    if (container) container.classList.remove('playing');
    bars.forEach((bar, i) => {
        const heights = [8,14,20,28,35,28,20,14,20,28,35,28,20,14,8];
        bar.style.height = (heights[i] || 14) + 'px';
    });
}

// ============================================================
// PARTICLES
// ============================================================
let particleAnim = null;
let particles = [];

function startParticles() {
    if (!getSetting('particles')) return;
    const canvas = document.getElementById('particlesCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth || window.innerWidth;
    canvas.height = canvas.offsetHeight || window.innerHeight;

    particles = Array.from({length: 35}, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 3 + 1,
        dx: (Math.random() - 0.5) * 0.6,
        dy: (Math.random() - 0.5) * 0.6,
        alpha: Math.random() * 0.5 + 0.2,
    }));

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,255,255,${p.alpha})`;
            ctx.fill();
            p.x += p.dx; p.y += p.dy;
            if (p.x < 0 || p.x > canvas.width) p.dx *= -1;
            if (p.y < 0 || p.y > canvas.height) p.dy *= -1;
        });
        particleAnim = requestAnimationFrame(draw);
    }
    if (particleAnim) cancelAnimationFrame(particleAnim);
    draw();
}

function stopParticles() {
    if (particleAnim) { cancelAnimationFrame(particleAnim); particleAnim = null; }
    const canvas = document.getElementById('particlesCanvas');
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

// ============================================================
// INIT
// ============================================================
window.setTheme = setTheme;
window.saveSetting = saveSetting;

window.onload = () => {
    loadHomeData();
    renderSearchCategories();
    renderSearchHistory();
    loadTheme();
    loadSettings();
};
