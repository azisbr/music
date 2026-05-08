from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from ytmusicapi import YTMusic
import httpx
import time

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ytmusic = YTMusic()

YT_API_KEY = "AIzaSyDiAOWqmXkbbjDoP3e-dUjD293MfjTsurs"
YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"

home_cache = {}
CACHE_TTL = 1800

# ── ytmusicapi search (selalu jadi primary) ──────────────────
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

def search_ytmusic(query: str, limit: int = 15):
    """Primary search — pakai ytmusicapi, hasilnya pasti bisa diplay"""
    try:
        results = ytmusic.search(query, filter="songs", limit=limit)
        data = fmt_ytmusic(results)
        if data:
            return data
    except Exception as e:
        print(f"ytmusicapi songs error: {e}")
    # Fallback tanpa filter
    try:
        results = ytmusic.search(query, limit=limit)
        return fmt_ytmusic(results)
    except Exception as e:
        print(f"ytmusicapi fallback error: {e}")
        return []

# ── YouTube Data API (secondary, buat trending aja) ──────────
async def yt_trending(max_results: int = 12):
    try:
        params = {
            "part": "snippet,status",
            "chart": "mostPopular",
            "videoCategoryId": "10",
            "regionCode": "ID",
            "maxResults": 20,
            "key": YT_API_KEY,
        }
        async with httpx.AsyncClient(timeout=8) as client:
            res = await client.get(YT_VIDEOS_URL, params=params)
            data = res.json()

        results = []
        for item in data.get("items", []):
            vid_id = item.get("id")
            if not vid_id:
                continue
            status = item.get("status", {})
            if not status.get("embeddable", True):
                continue
            snippet = item.get("snippet", {})
            thumb = snippet.get("thumbnails", {})
            img = (thumb.get("maxres") or thumb.get("high") or thumb.get("medium") or thumb.get("default") or {}).get("url", "")
            results.append({
                "videoId": vid_id,
                "title": snippet.get("title", "Unknown"),
                "artist": snippet.get("channelTitle", "Unknown"),
                "thumbnail": img
            })
            if len(results) >= max_results:
                break
        return results
    except Exception as e:
        print(f"yt_trending error: {e}")
        # Fallback trending via ytmusicapi
        return search_ytmusic("lagu indonesia trending terpopuler", 12)

# ── Endpoints ────────────────────────────────────────────────
@app.get("/api/search")
async def search_music(query: str):
    try:
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
        import asyncio
        trending_task = yt_trending(12)
        trending = await trending_task

        anyar, gembira, galau, tiktok = await asyncio.gather(
            asyncio.to_thread(search_ytmusic, "lagu indonesia terbaru 2025 2026", 10),
            asyncio.to_thread(search_ytmusic, "lagu pop semangat ceria 2025", 10),
            asyncio.to_thread(search_ytmusic, "lagu galau sedih indonesia 2025", 10),
            asyncio.to_thread(search_ytmusic, "lagu viral tiktok indonesia 2025 2026", 10),
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
    """Endpoint debug — cek status API"""
    result = {"ytmusicapi": "error", "yt_data_api": "error", "search_result": []}
    try:
        r = search_ytmusic("pop", 3)
        result["ytmusicapi"] = "ok" if r else "empty"
        result["search_result"] = r[:2]
    except Exception as e:
        result["ytmusicapi"] = str(e)
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.get(YT_VIDEOS_URL, params={
                "part": "snippet", "chart": "mostPopular",
                "videoCategoryId": "10", "regionCode": "ID",
                "maxResults": 1, "key": YT_API_KEY
            })
            data = res.json()
            result["yt_data_api"] = "ok" if "items" in data else data.get("error", {}).get("message", "unknown error")
    except Exception as e:
        result["yt_data_api"] = str(e)
    return result
