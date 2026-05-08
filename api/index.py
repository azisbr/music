# api/index.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from ytmusicapi import YTMusic
import httpx
import time

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ytmusic = YTMusic()

YT_API_KEY = "AIzaSyDiAOWqmXkbbjDoP3e-dUjD293MfjTsurs"
YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"

home_cache = {}
CACHE_TTL = 1800  # 30 menit

def format_yt_api_results(items, videos_data=None):
    """Format hasil dari YouTube Data API v3"""
    videos_map = {}
    if videos_data:
        for v in videos_data.get("items", []):
            videos_map[v["id"]] = v

    cleaned = []
    for item in items:
        vid_id = item.get("id", {}).get("videoId") if isinstance(item.get("id"), dict) else item.get("id")
        if not vid_id:
            continue
        snippet = item.get("snippet", {})
        thumb = snippet.get("thumbnails", {})
        img = (thumb.get("high") or thumb.get("medium") or thumb.get("default") or {}).get("url", "")
        title = snippet.get("title", "Unknown Title")
        channel = snippet.get("channelTitle", "Unknown Artist")
        cleaned.append({
            "videoId": vid_id,
            "title": title,
            "artist": channel,
            "thumbnail": img
        })
    return cleaned

async def yt_search(query: str, max_results: int = 12):
    """Search menggunakan YouTube Data API v3 - hasil lebih fresh & relevan"""
    params = {
        "part": "snippet",
        "q": query,
        "type": "video",
        "videoCategoryId": "10",  # Music category
        "maxResults": max_results,
        "regionCode": "ID",
        "relevanceLanguage": "id",
        "key": YT_API_KEY,
        "order": "relevance",
    }
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(YT_SEARCH_URL, params=params)
        data = res.json()
        return format_yt_api_results(data.get("items", []))

async def yt_trending(max_results: int = 12):
    """Ambil trending musik Indonesia dari YouTube"""
    params = {
        "part": "snippet",
        "chart": "mostPopular",
        "videoCategoryId": "10",  # Music
        "regionCode": "ID",
        "maxResults": max_results,
        "key": YT_API_KEY,
    }
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(YT_VIDEOS_URL, params=params)
        data = res.json()
        return format_yt_api_results(data.get("items", []))

def format_ytmusic_results(search_results):
    cleaned = []
    for item in search_results:
        if 'videoId' in item:
            cleaned.append({
                "videoId": item['videoId'],
                "title": item.get('title', 'Unknown Title'),
                "artist": item.get('artists', [{'name': 'Unknown Artist'}])[0]['name'] if 'artists' in item else 'Unknown Artist',
                "thumbnail": item['thumbnails'][-1]['url'] if 'thumbnails' in item else ''
            })
    return cleaned

@app.get("/api/search")
async def search_music(query: str):
    try:
        results = await yt_search(query, max_results=15)
        return {"status": "success", "data": results}
    except Exception as e:
        # Fallback ke ytmusicapi
        try:
            r = ytmusic.search(query, filter="songs", limit=12)
            return {"status": "success", "data": format_ytmusic_results(r)}
        except:
            return {"status": "error", "message": str(e)}

@app.get("/api/home")
async def get_home_data():
    current_time = time.time()
    if "data" in home_cache and (current_time - home_cache["timestamp"] < CACHE_TTL):
        return {"status": "success", "data": home_cache["data"]}
    try:
        # Trending Indonesia = sumber utama, paling fresh
        trending = await yt_trending(max_results=12)

        data = {
            "recent": trending[:4],
            "anyar": await yt_search("lagu indonesia terbaru 2025 2026", 10),
            "gembira": await yt_search("lagu pop semangat ceria indonesia 2025", 10),
            "charts": trending,
            "galau": await yt_search("lagu galau sedih indonesia 2025 2026", 10),
            "baru": await yt_search("lagu baru rilis 2026 indonesia", 10),
            "tiktok": await yt_search("lagu viral tiktok indonesia 2025 2026", 10),
            "artists": await yt_search("lagu hits artis indonesia populer 2025", 10),
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
