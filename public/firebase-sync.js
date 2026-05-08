// ============================================================
// FIREBASE SYNC MODULE - SANN404 FORUM Music
// Handles: Auth (Email/Password) + Firestore Sync
// Data: liked_songs, playlists, play_history, search_history
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
    getAuth,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
    updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
    getFirestore,
    doc,
    setDoc,
    getDoc,
    collection,
    getDocs,
    deleteDoc,
    writeBatch,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ─── FIREBASE CONFIG ───────────────────────────────────────
// Ganti dengan config Firebase project kamu sendiri!
const firebaseConfig = {
    apiKey: "AIzaSyAjLVySiEetwFGWHAE6xHbaSqapRxo-iSA",
    authDomain: "my-music707.firebaseapp.com",
    projectId: "my-music707",
    storageBucket: "my-music707.firebasestorage.app",
    messagingSenderId: "968715758496",
    appId: "1:968715758496:web:83207c630c06df12bb12c5",
    measurementId: "G-W4NC9RHJNM"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ─── STATE ─────────────────────────────────────────────────
let currentUser = null;
let syncStatusEl = null;

// ─── INIT ──────────────────────────────────────────────────
export function initFirebase() {
    syncStatusEl = document.getElementById('syncStatusBadge');

    onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        updateAuthUI(user);
        if (user) {
            showSyncStatus('syncing');
            await pullFromFirestore();
            showSyncStatus('synced');
        }
    });
}

// ─── AUTH UI ───────────────────────────────────────────────
function updateAuthUI(user) {
    const loggedIn  = document.getElementById('authLoggedIn');
    const loggedOut = document.getElementById('authLoggedOut');
    const userName  = document.getElementById('authUserName');
    const userEmail = document.getElementById('authUserEmail');
    const avatarInitial = document.getElementById('authAvatarInitial');

    if (user) {
        if (loggedIn)  loggedIn.style.display  = 'block';
        if (loggedOut) loggedOut.style.display  = 'none';
        if (userName)  userName.innerText  = user.displayName || 'Pengguna';
        if (userEmail) userEmail.innerText = user.email;
        const initial = (user.displayName || user.email || 'U')[0].toUpperCase();
        if (avatarInitial) avatarInitial.innerText = initial;
    } else {
        if (loggedIn)  loggedIn.style.display  = 'none';
        if (loggedOut) loggedOut.style.display  = 'block';
        if (userName)  userName.innerText  = '';
        if (userEmail) userEmail.innerText = '';
    }
}

// ─── MODAL HELPERS ─────────────────────────────────────────
export function openAuthModal(tab = 'login') {
    document.getElementById('authModal').style.display = 'flex';
    switchAuthTab(tab);
    document.getElementById('authError').innerText = '';
}

export function closeAuthModal() {
    document.getElementById('authModal').style.display = 'none';
    document.getElementById('authError').innerText = '';
    ['authLoginEmail','authLoginPass','authRegEmail','authRegPass','authRegName'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

export function switchAuthTab(tab) {
    document.getElementById('authTabLogin').classList.toggle('active', tab === 'login');
    document.getElementById('authTabReg').classList.toggle('active', tab === 'register');
    document.getElementById('authFormLogin').style.display = tab === 'login' ? 'flex' : 'none';
    document.getElementById('authFormReg').style.display   = tab === 'register' ? 'flex' : 'none';
    document.getElementById('authError').innerText = '';
}

function setAuthLoading(loading) {
    const btns = document.querySelectorAll('.auth-submit-btn');
    btns.forEach(b => { b.disabled = loading; b.innerText = loading ? 'Loading...' : b.getAttribute('data-label'); });
}

function showAuthError(msg) {
    const el = document.getElementById('authError');
    if (el) el.innerText = msg;
}

// ─── REGISTER ──────────────────────────────────────────────
export async function doRegister() {
    const name  = document.getElementById('authRegName').value.trim();
    const email = document.getElementById('authRegEmail').value.trim();
    const pass  = document.getElementById('authRegPass').value;

    if (!name || !email || !pass) { showAuthError('Semua field harus diisi!'); return; }
    if (pass.length < 6) { showAuthError('Password minimal 6 karakter.'); return; }

    setAuthLoading(true);
    try {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await updateProfile(cred.user, { displayName: name });
        closeAuthModal();
        showGlobalToast('✅ Akun berhasil dibuat! Selamat datang, ' + name);
    } catch (e) {
        showAuthError(firebaseErrMsg(e.code));
    } finally {
        setAuthLoading(false);
    }
}

// ─── LOGIN ─────────────────────────────────────────────────
export async function doLogin() {
    const email = document.getElementById('authLoginEmail').value.trim();
    const pass  = document.getElementById('authLoginPass').value;

    if (!email || !pass) { showAuthError('Email dan password harus diisi!'); return; }

    setAuthLoading(true);
    try {
        await signInWithEmailAndPassword(auth, email, pass);
        closeAuthModal();
        showGlobalToast('👋 Selamat datang kembali!');
    } catch (e) {
        showAuthError(firebaseErrMsg(e.code));
    } finally {
        setAuthLoading(false);
    }
}

// ─── LOGOUT ────────────────────────────────────────────────
export async function doLogout() {
    if (!confirm('Yakin mau keluar?')) return;
    await signOut(auth);
    showGlobalToast('👋 Berhasil logout.');
}

// ─── ERROR MESSAGES ────────────────────────────────────────
function firebaseErrMsg(code) {
    const map = {
        'auth/email-already-in-use': 'Email sudah terdaftar.',
        'auth/invalid-email': 'Format email tidak valid.',
        'auth/weak-password': 'Password terlalu lemah (min. 6 karakter).',
        'auth/user-not-found': 'Email tidak terdaftar.',
        'auth/wrong-password': 'Password salah.',
        'auth/invalid-credential': 'Email atau password salah.',
        'auth/too-many-requests': 'Terlalu banyak percobaan. Coba lagi nanti.',
        'auth/network-request-failed': 'Gagal koneksi. Cek internet kamu.',
    };
    return map[code] || 'Terjadi kesalahan. Coba lagi.';
}

// ─── SYNC STATUS ───────────────────────────────────────────
function showSyncStatus(state) {
    if (!syncStatusEl) return;
    const states = {
        syncing: { text: '🔄 Menyinkron...', color: '#f39c12' },
        synced:  { text: '☁️ Tersinkron',    color: '#1ed760' },
        error:   { text: '⚠️ Gagal sync',    color: '#e74c3c' },
        offline: { text: '📵 Offline',        color: '#a7a7a7' },
    };
    const s = states[state] || states.offline;
    syncStatusEl.innerText = s.text;
    syncStatusEl.style.color = s.color;
    syncStatusEl.style.display = 'inline';
}

// ─── PUSH TO FIRESTORE ─────────────────────────────────────

export async function pushLikedSongs(songs) {
    if (!currentUser) return;
    try {
        showSyncStatus('syncing');
        const batch = writeBatch(db);
        const colRef = collection(db, 'users', currentUser.uid, 'liked_songs');

        // Clear old then write new
        const existing = await getDocs(colRef);
        existing.forEach(d => batch.delete(d.ref));
        songs.forEach(song => {
            batch.set(doc(colRef, song.videoId), { ...song, updatedAt: serverTimestamp() });
        });
        await batch.commit();
        showSyncStatus('synced');
    } catch (e) {
        console.error('pushLikedSongs error:', e);
        showSyncStatus('error');
    }
}

export async function pushOneLikedSong(song, isDelete = false) {
    if (!currentUser) return;
    try {
        const ref = doc(db, 'users', currentUser.uid, 'liked_songs', song.videoId);
        if (isDelete) await deleteDoc(ref);
        else await setDoc(ref, { ...song, updatedAt: serverTimestamp() });
        showSyncStatus('synced');
    } catch (e) {
        console.error('pushOneLikedSong error:', e);
        showSyncStatus('error');
    }
}

export async function pushPlaylists(playlists) {
    if (!currentUser) return;
    try {
        showSyncStatus('syncing');
        const batch = writeBatch(db);
        const colRef = collection(db, 'users', currentUser.uid, 'playlists');

        const existing = await getDocs(colRef);
        existing.forEach(d => batch.delete(d.ref));
        playlists.forEach(p => {
            // Trim base64 image agar hemat Firestore storage (max 1MB per doc)
            const data = { ...p, updatedAt: serverTimestamp() };
            if (data.img && data.img.startsWith('data:image') && data.img.length > 50000) {
                data.img = ''; // skip simpan gambar besar, pakai default
            }
            batch.set(doc(colRef, p.id), data);
        });
        await batch.commit();
        showSyncStatus('synced');
    } catch (e) {
        console.error('pushPlaylists error:', e);
        showSyncStatus('error');
    }
}

export async function pushPlayHistory(history) {
    if (!currentUser) return;
    try {
        const ref = doc(db, 'users', currentUser.uid, 'meta', 'play_history');
        await setDoc(ref, { items: history.slice(0, 50), updatedAt: serverTimestamp() });
        showSyncStatus('synced');
    } catch (e) {
        console.error('pushPlayHistory error:', e);
        showSyncStatus('error');
    }
}

export async function pushSearchHistory(history) {
    if (!currentUser) return;
    try {
        const ref = doc(db, 'users', currentUser.uid, 'meta', 'search_history');
        await setDoc(ref, { items: history.slice(0, 20), updatedAt: serverTimestamp() });
        showSyncStatus('synced');
    } catch (e) {
        console.error('pushSearchHistory error:', e);
        showSyncStatus('error');
    }
}

// ─── PULL FROM FIRESTORE ───────────────────────────────────

export async function pullFromFirestore() {
    if (!currentUser) return;
    try {
        showSyncStatus('syncing');

        // 1. Liked Songs → IndexedDB
        const likedSnap = await getDocs(collection(db, 'users', currentUser.uid, 'liked_songs'));
        if (!likedSnap.empty) {
            await clearIDBStore('liked_songs');
            const tx = window._sannDB.transaction('liked_songs', 'readwrite');
            const store = tx.objectStore('liked_songs');
            likedSnap.forEach(d => store.put(d.data()));
            await txDone(tx);
        }

        // 2. Playlists → IndexedDB
        const playlistSnap = await getDocs(collection(db, 'users', currentUser.uid, 'playlists'));
        if (!playlistSnap.empty) {
            await clearIDBStore('playlists');
            const tx = window._sannDB.transaction('playlists', 'readwrite');
            const store = tx.objectStore('playlists');
            playlistSnap.forEach(d => {
                const data = d.data();
                delete data.updatedAt; // remove serverTimestamp
                store.put(data);
            });
            await txDone(tx);
        }

        // 3. Play History → localStorage
        const histRef = doc(db, 'users', currentUser.uid, 'meta', 'play_history');
        const histSnap = await getDoc(histRef);
        if (histSnap.exists()) {
            localStorage.setItem('playHistory', JSON.stringify(histSnap.data().items || []));
        }

        // 4. Search History → localStorage
        const searchRef = doc(db, 'users', currentUser.uid, 'meta', 'search_history');
        const searchSnap = await getDoc(searchRef);
        if (searchSnap.exists()) {
            localStorage.setItem('searchHistory', JSON.stringify(searchSnap.data().items || []));
        }

        // Refresh UI
        if (typeof window.renderLibraryUI === 'function') window.renderLibraryUI();
        if (typeof window.renderSearchHistory === 'function') window.renderSearchHistory();

        showSyncStatus('synced');
    } catch (e) {
        console.error('pullFromFirestore error:', e);
        showSyncStatus('error');
    }
}

// ─── IDB HELPERS ───────────────────────────────────────────
function clearIDBStore(storeName) {
    return new Promise((resolve, reject) => {
        const tx = window._sannDB.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

// ─── UTILS ─────────────────────────────────────────────────
function showGlobalToast(msg) {
    if (typeof window.showToast === 'function') window.showToast(msg);
}

export function isLoggedIn() { return !!currentUser; }
export function getCurrentUser() { return currentUser; }

// Internal push helpers (exposed via window.firebaseSync)
export const _pushOneLikedAdd    = (song) => pushOneLikedSong(song, false);
export const _pushOneLikedDelete = (song) => pushOneLikedSong(song, true);
export const _pushLikedSongs     = pushLikedSongs;
export const _pushPlaylists      = pushPlaylists;
export const _pushPlayHistory    = pushPlayHistory;
export const _pushSearchHistory  = pushSearchHistory;
