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

BLOCKED_CHANNELS = {
    "vevo", "official", "records", "music official",
    "warner", "sony", "universal", "umg", "sme", "wme"
}

def is_likely_embeddable(title: str, channel: str) -> bool:
    """Filter video yang kemungkinan besar BISA di-embed"""
    combined = (title + " " + channel).lower()
    # Prioritaskan audio/lyric/cover yang biasanya bisa embed
    good_keywords = ["audio", "lyrics", "lyric", "cover", "unofficial", "slowed", "reverb", "remix", "karaoke"]
    for kw in good_keywords:
        if kw in combined:
            return True
    # Block channel VEVO / label besar
    for blocked in BLOCKED_CHANNELS:
        if blocked in combined:
            return False
    return True

async def yt_search_embeddable(query: str, max_results: int = 20) -> list:
    """
    Search YouTube Data API v3, filter hanya yang embeddable,
    cek status embed via videos endpoint
    """
    search_params = {
        "part": "snippet",
        "q": query + " audio",
        "type": "video",
        "videoCategoryId": "10",
        "maxResults": max_results,
        "regionCode": "ID",
        "key": YT_API_KEY,
        "videoEmbeddable": "true",  # ← filter langsung dari API!
    }
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(YT_SEARCH_URL, params=search_params)
        data = res.json()

    results = []
    for item in data.get("items", []):
        vid_id = item.get("id", {}).get("videoId")
        if not vid_id:
            continue
        snippet = item.get("snippet", {})
        thumb = snippet.get("thumbnails", {})
        img = (thumb.get("high") or thumb.get("medium") or thumb.get("default") or {}).get("url", "")
        title = snippet.get("title", "Unknown")
        channel = snippet.get("channelTitle", "Unknown")
        results.append({
            "videoId": vid_id,
            "title": title,
            "artist": channel,
            "thumbnail": img
        })

    return results[:12]

async def yt_trending_embeddable(max_results: int = 12) -> list:
    """Trending musik Indonesia, filter embeddable"""
    params = {
        "part": "snippet,status",
        "chart": "mostPopular",
        "videoCategoryId": "10",
        "regionCode": "ID",
        "maxResults": 20,
        "key": YT_API_KEY,
    }
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(YT_VIDEOS_URL, params=params)
        data = res.json()

    results = []
    for item in data.get("items", []):
        vid_id = item.get("id")
        if not vid_id:
            continue
        status = item.get("status", {})
        # Cek embeddable langsung dari status
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

@app.get("/api/search")
async def search_music(query: str):
    try:
        results = await yt_search_embeddable(query, max_results=20)
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
        trending, anyar, gembira, galau, tiktok = await asyncio.gather(
            yt_trending_embeddable(12),
            yt_search_embeddable("lagu indonesia terbaru 2025 2026", 10),
            yt_search_embeddable("lagu pop semangat ceria 2025", 10),
            yt_search_embeddable("lagu galau sedih indonesia 2025", 10),
            yt_search_embeddable("lagu viral tiktok indonesia 2025 2026", 10),
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
