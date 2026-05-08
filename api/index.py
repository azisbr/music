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
    try:
        results = ytmusic.search(query, filter="songs", limit=limit)
        data = fmt_ytmusic(results)
        if data:
            return data
    except:
        pass
    try:
        results = ytmusic.search(query, limit=limit)
        return fmt_ytmusic(results)
    except:
        return []

async def check_embeddable_batch(video_ids: list) -> dict:
    if not video_ids:
        return {}
    uncached = [vid for vid in video_ids if vid not in embed_cache]
    if uncached:
        try:
            ids_str = ",".join(uncached[:50])
            params = {"part": "status", "id": ids_str, "key": YT_API_KEY}
            async with httpx.AsyncClient(timeout=8) as client:
                res = await client.get(YT_VIDEOS_URL, params=params)
                data = res.json()
            found_ids = set()
            for item in data.get("items", []):
                vid_id = item.get("id")
                if vid_id:
                    embed_cache[vid_id] = item.get("status", {}).get("embeddable", False)
                    found_ids.add(vid_id)
            for vid_id in uncached:
                if vid_id not in found_ids:
                    embed_cache[vid_id] = False
        except:
            for vid_id in uncached:
                embed_cache[vid_id] = True
    return {vid: embed_cache.get(vid, True) for vid in video_ids}

async def get_embeddable_tracks(query: str, need: int = 12) -> list:
    raw = search_ytmusic(query, limit=need * 2)
    if not raw:
        return []
    video_ids = [t['videoId'] for t in raw]
    embed_status = await check_embeddable_batch(video_ids)
    filtered = [t for t in raw if embed_status.get(t['videoId'], True)]
    # Kalau filtered kurang dari need, fallback pakai unfiltered
    if len(filtered) < need // 2:
        return raw[:need]
    return filtered[:need]

@app.get("/api/search")
async def search_music(query: str):
    try:
        # Ambil banyak dulu dari ytmusicapi
        raw = search_ytmusic(query, limit=40)
        if not raw:
            return {"status": "error", "message": "Tidak ada hasil"}

        # Batch check embeddable
        video_ids = [t['videoId'] for t in raw]
        embed_status = await check_embeddable_batch(video_ids)

        # Filter yang embeddable
        filtered = [t for t in raw if embed_status.get(t['videoId'], True)]

        # Kalau hasil filter terlalu sedikit (<8), kembalikan semua aja
        # daripada kosong
        final = filtered if len(filtered) >= 8 else raw
        return {"status": "success", "data": final[:25]}
    except Exception as e:
        # Fallback total — return tanpa filter
        try:
            raw = search_ytmusic(query, limit=25)
            return {"status": "success", "data": raw}
        except:
            return {"status": "error", "message": str(e)}

@app.get("/api/home")
async def get_home_data():
    """Preload semua 11 section sekaligus — 1 hit, hemat quota"""
    current_time = time.time()
    if "data" in home_cache and (current_time - home_cache.get("timestamp", 0) < CACHE_TTL):
        return {"status": "success", "data": home_cache["data"]}
    try:
        queries = [
            ("lagu indonesia hits terbaru", 8),
            ("lagu pop indonesia rilis terbaru 2025 2026", 10),
            ("lagu ceria gembira semangat indonesia", 10),
            ("top 50 indonesia hits populer", 10),
            ("lagu galau sedih indonesia terpopuler", 10),
            ("lagu viral terbaru 2026 indonesia", 10),
            ("lagu fyp tiktok viral indonesia 2025 2026", 10),
            ("penyanyi pop indonesia paling hits 2025", 10),
            ("hit terpopuler hari ini indonesia", 10),
            ("lagu tiktok playlist indonesia 2025", 10),
            ("album single populer indonesia 2025 2026", 10),
        ]

        # Jalankan semua search parallel
        raw_results = await asyncio.gather(
            *[asyncio.to_thread(search_ytmusic, q, limit * 2) for q, limit in queries]
        )

        # Kumpulkan semua videoId unik untuk batch check — 1 request YT API!
        all_tracks = []
        for tracks in raw_results:
            all_tracks.extend(tracks)

        all_ids = list({t['videoId'] for t in all_tracks})
        embed_status = await check_embeddable_batch(all_ids)

        def filter_tracks(tracks, need):
            filtered = [t for t in tracks if embed_status.get(t['videoId'], True)]
            if len(filtered) < need // 2:
                return tracks[:need]  # fallback
            return filtered[:need]

        keys = ['recent', 'anyar', 'gembira', 'charts', 'galau', 'baru', 'tiktok', 'artists', 'hitsHariIni', 'untukTiktok', 'albumSingle']
        data = {}
        for i, key in enumerate(keys):
            data[key] = filter_tracks(raw_results[i], queries[i][1])

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
        test_ids = [r['videoId'] for r in result.get("sample", [])][:2]
        if test_ids:
            embed = await check_embeddable_batch(test_ids)
            result["yt_data_api"] = "ok"
            result["embed_check"] = embed
    except Exception as e:
        result["yt_data_api"] = str(e)
    return result
