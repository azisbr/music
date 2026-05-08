from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from ytmusicapi import YTMusic
import httpx
import time

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ytmusic = YTMusic()

YT_API_KEY = "AIzaSyDiAOWqmXkbbjDoP3e-dUjD293MfjTsurs"
YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"

home_cache = {}
CACHE_TTL = 1800

def fmt_ytmusic(results):
    """Format ytmusicapi results — videoId-nya pasti bisa diplay"""
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

async def get_trending_ids():
    """Ambil videoId trending dari YT Data API, lalu cari di ytmusicapi biar bisa diplay"""
    try:
        params = {
            "part": "snippet",
            "chart": "mostPopular",
            "videoCategoryId": "10",
            "regionCode": "ID",
            "maxResults": 12,
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
            snippet = item.get("snippet", {})
            thumb = snippet.get("thumbnails", {})
            img = (thumb.get("maxres") or thumb.get("high") or thumb.get("medium") or thumb.get("default") or {}).get("url", "")
            results.append({
                "videoId": vid_id,
                "title": snippet.get("title", "Unknown"),
                "artist": snippet.get("channelTitle", "Unknown"),
                "thumbnail": img
            })
        return results
    except:
        return []

def search_ytmusic(query, limit=12):
    """Search via ytmusicapi — hasilnya pasti bisa diplay karena dari YouTube Music"""
    try:
        results = ytmusic.search(query, filter="songs", limit=limit)
        return fmt_ytmusic(results)
    except:
        try:
            results = ytmusic.search(query, limit=limit)
            return fmt_ytmusic(results)
        except:
            return []

@app.get("/api/search")
async def search_music(query: str):
    try:
        data = search_ytmusic(query, limit=15)
        if not data:
            return {"status": "error", "message": "Tidak ada hasil"}
        return {"status": "success", "data": data}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/home")
async def get_home_data():
    current_time = time.time()
    if "data" in home_cache and (current_time - home_cache.get("timestamp", 0) < CACHE_TTL):
        return {"status": "success", "data": home_cache["data"]}
    try:
        trending = await get_trending_ids()
        data = {
            "trending": trending,
            "anyar": search_ytmusic("lagu indonesia terbaru 2025 2026", 10),
            "gembira": search_ytmusic("lagu pop semangat ceria 2025 hits", 10),
            "galau": search_ytmusic("lagu galau sedih indonesia 2025", 10),
            "tiktok": search_ytmusic("lagu viral tiktok indonesia 2025 2026", 10),
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
