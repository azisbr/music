from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from ytmusicapi import YTMusic
import httpx
import time
import asyncio

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ytmusic = YTMusic()

YT_API_KEY = "AIzaSyDiAOWqmXkbbjDoP3e-dUjD293MfjTsurs"
YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"

home_cache = {}
CACHE_TTL = 1800

# Cache embeddable check biar ga re-check videoId yang sama
embed_cache = {}

def fmt_ytmusic(results):
    cleaned = []
    for item in results:
        vid = item.get('videoId')
        if not vid:
            continue
        thumbs = item.get('thumbnails', [])
        img = thumbs[-1]['url'] if thumbs else ''
        artist = 'Unknown Artist'
        if 'artists' in item and item['artists']:
            artist = item['artists'][0].get('name', 'Unknown Artist')
        elif 'author' in item:
            artist = item['author']
        cleaned.append({
            "videoId": vid,
            "title": item.get('title', 'Unknown Title'),
            "artist": artist,
            "thumbnail": img
        })
    return cleaned

def search_ytmusic(query: str, limit: int = 20):
    """Search via ytmusicapi — unlimited, gratis"""
    try:
        results = ytmusic.search(query, filter="songs", limit=limit)
        data = fmt_ytmusic(results)
        if data:
            return data
    except Exception as e:
        print(f"ytmusicapi songs error: {e}")
    try:
        results = ytmusic.search(query, limit=limit)
        return fmt_ytmusic(results)
    except Exception as e:
        print(f"ytmusicapi fallback error: {e}")
        return []

async def check_embeddable_batch(video_ids: list) -> dict:
    """
    Cek embeddable status sekaligus batch (1 request = cek banyak videoId)
    Hemat quota: 20 videoId = 1 request aja
    """
    if not video_ids:
        return {}
    
    # Cek cache dulu
    uncached = [vid for vid in video_ids if vid not in embed_cache]
    
    if uncached:
        try:
            # Batch check — pisahkan dengan koma, 1 request buat semua
            ids_str = ",".join(uncached[:50])  # max 50 per request
            params = {
                "part": "status",
                "id": ids_str,
                "key": YT_API_KEY,
            }
            async with httpx.AsyncClient(timeout=8) as client:
                res = await client.get(YT_VIDEOS_URL, params=params)
                data = res.json()
            
            # Simpan hasil ke cache
            found_ids = set()
            for item in data.get("items", []):
                vid_id = item.get("id")
                if vid_id:
                    embeddable = item.get("status", {}).get("embeddable", False)
                    embed_cache[vid_id] = embeddable
                    found_ids.add(vid_id)
            
            # VideoId yang ga ada di response = private/deleted = not embeddable
            for vid_id in uncached:
                if vid_id not in found_ids:
                    embed_cache[vid_id] = False
                    
        except Exception as e:
            print(f"embed check error: {e}")
            # Kalau gagal, anggap semua embeddable biar tetap jalan
            for vid_id in uncached:
                embed_cache[vid_id] = True
    
    return {vid: embed_cache.get(vid, True) for vid in video_ids}

async def get_embeddable_tracks(query: str, need: int = 12) -> list:
    """
    Search via ytmusicapi, filter yang embeddable via YT Data API batch check
    Efisien: 1 batch request buat verifikasi semua sekaligus
    """
    # Ambil lebih banyak dari ytmusicapi buat buffer kalau ada yang diblock
    raw = search_ytmusic(query, limit=need * 2)
    if not raw:
        return []
    
    # Batch check semua videoId sekaligus — hemat quota!
    video_ids = [t['videoId'] for t in raw]
    embed_status = await check_embeddable_batch(video_ids)
    
    # Filter yang embeddable
    filtered = [t for t in raw if embed_status.get(t['videoId'], True)]
    return filtered[:need]

async def yt_trending(max_results: int = 12):
    """Trending Indonesia — pakai ytmusicapi + filter embeddable"""
    try:
        raw = search_ytmusic("lagu indonesia trending hits terpopuler 2025", max_results * 2)
        if not raw:
            return []
        video_ids = [t['videoId'] for t in raw]
        embed_status = await check_embeddable_batch(video_ids)
        filtered = [t for t in raw if embed_status.get(t['videoId'], True)]
        return filtered[:max_results]
    except Exception as e:
        print(f"trending error: {e}")
        return search_ytmusic("lagu indonesia hits", max_results)

@app.get("/api/search")
async def search_music(query: str):
    try:
        results = await get_embeddable_tracks(query, need=15)
        if not results:
            # Last resort: return tanpa filter daripada kosong
            results = search_ytmusic(query, limit=15)
        if not results:
            return {"status": "error", "message": "Tidak ada hasil"}
        return {"status": "success", "data": results}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/home")
async def get_home_data():
    current_time = time.time()
    if "data" in home_cache and (current_time - home_cache.get("timestamp", 0) < CACHE_TTL):
        return {"status": "success", "data": home_cache["data"]}
    try:
        trending, anyar, gembira, galau, tiktok = await asyncio.gather(
            yt_trending(12),
            get_embeddable_tracks("lagu indonesia terbaru 2025 2026", 10),
            get_embeddable_tracks("lagu pop semangat ceria indonesia 2025", 10),
            get_embeddable_tracks("lagu galau sedih indonesia 2025", 10),
            get_embeddable_tracks("lagu viral tiktok indonesia 2025 2026", 10),
        )
        data = {
            "trending": trending,
            "anyar": anyar,
            "gembira": gembira,
            "galau": galau,
            "tiktok": tiktok,
        }
        home_cache["data"] = data
        home_cache["timestamp"] = current_time
        return {"status": "success", "data": data}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/lyrics")
def get_lyrics(video_id: str):
    try:
        watch_playlist = ytmusic.get_watch_playlist(videoId=video_id)
        lyrics_id = watch_playlist.get("lyrics")
        if not lyrics_id:
            return {"status": "error", "message": "Lirik tidak ditemukan"}
        lyrics = ytmusic.get_lyrics(lyrics_id)
        return {"status": "success", "data": lyrics}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/debug")
async def debug():
    result = {"ytmusicapi": "error", "yt_data_api": "error", "embed_cache_size": len(embed_cache)}
    try:
        r = search_ytmusic("pop indonesia", 3)
        result["ytmusicapi"] = "ok" if r else "empty"
        result["sample"] = r[:2] if r else []
    except Exception as e:
        result["ytmusicapi"] = str(e)
    try:
        # Test batch check dengan 1 videoId
        test_ids = [r['videoId'] for r in result.get("sample", [])][:2]
        if test_ids:
            embed = await check_embeddable_batch(test_ids)
            result["yt_data_api"] = "ok"
            result["embed_check"] = embed
        else:
            result["yt_data_api"] = "no sample to test"
    except Exception as e:
        result["yt_data_api"] = str(e)
    return result
