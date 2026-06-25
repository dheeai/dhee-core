#!/usr/bin/env python3
"""Karaoke / Instagram-style animated caption overlay.

ASR engines:
  - whisper : local faster-whisper (word timestamps in the spoken language).
  - llm     : an audio-capable LLM (e.g. Gemini via OpenRouter) that can
              transcribe AND translate in one call, returning word timestamps.
              Creds from env: CAPTIONS_LLM_BASE, CAPTIONS_LLM_KEY, CAPTIONS_LLM_MODEL.

Render: Pillow draws the active word in the accent colour (no box) per frame
(cv2), then the original audio is muxed back (ffmpeg stream-copy). No ffmpeg
text filters needed.
"""
import sys, os, json, base64, subprocess, argparse, re
import urllib.request, urllib.error
import cv2, numpy as np
from PIL import Image, ImageDraw, ImageFont

def log(*a): print("[captions]", *a, flush=True)

# ── ASR: local faster-whisper ──────────────────────────────────────────
def transcribe_whisper(video, model_size, language, translate_to):
    from faster_whisper import WhisperModel
    task = "translate" if (translate_to or "").lower().startswith("en") else "transcribe"
    log(f"faster-whisper '{model_size}' task={task} lang={language or 'auto'}")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segs, info = model.transcribe(video, word_timestamps=True, task=task,
                                  language=language or None, vad_filter=True)
    words = []
    for s in segs:
        for w in (s.words or []):
            t = w.word.strip()
            if t: words.append({"w": t, "start": float(w.start), "end": float(w.end)})
    log(f"  language={info.language} words={len(words)}")
    return words

# ── ASR: audio-capable LLM (transcribe + optional translate) ───────────
def transcribe_llm(video, translate_to):
    base = os.environ["CAPTIONS_LLM_BASE"].rstrip("/")
    key = os.environ["CAPTIONS_LLM_KEY"]
    model = os.environ["CAPTIONS_LLM_MODEL"]
    wav = "/tmp/_cap_audio.wav"
    subprocess.run(["ffmpeg","-y","-i",video,"-ac","1","-ar","16000","-f","wav",wav],
                   capture_output=True)
    b64 = base64.b64encode(open(wav, "rb").read()).decode()
    if translate_to:
        instr = (f"Listen to this speech audio. TRANSLATE its meaning into natural, fluent "
                 f"{translate_to}. Output {translate_to} words ONLY (no other script). "
                 f"Time-align each output word to when its content is spoken.")
    else:
        instr = "Transcribe this speech audio verbatim, word by word, with timestamps."
    prompt = (instr + " Return ONLY JSON: "
              '{"words":[{"w":"<word>","start":<sec>,"end":<sec>}]} with one entry per word.')
    payload = {"model": model, "max_tokens": 4000, "messages": [{"role":"user","content":[
        {"type":"text","text":prompt},
        {"type":"input_audio","input_audio":{"data":b64,"format":"wav"}}]}]}
    log(f"LLM ASR via {model} (translate_to={translate_to or 'none'}, audio={os.path.getsize(wav)}B)")
    req = urllib.request.Request(f"{base}/chat/completions", data=json.dumps(payload).encode(),
        headers={"Authorization":f"Bearer {key}","Content-Type":"application/json"})
    r = urllib.request.urlopen(req, timeout=180)
    msg = json.load(r)["choices"][0]["message"]["content"]
    m = re.search(r'\{.*\}', msg, re.S)
    if not m: raise RuntimeError(f"LLM returned no JSON: {msg[:200]}")
    raw = json.loads(m.group(0)).get("words", [])
    words = []
    for i, w in enumerate(raw):
        word = str(w.get("w","")).strip()
        if not word: continue
        start = float(w.get("start", 0))
        end = w.get("end")
        end = float(end) if end is not None else (float(raw[i+1]["start"]) if i+1 < len(raw) else start+0.4)
        if end <= start: end = start + 0.25
        words.append({"w": word, "start": start, "end": end})
    log(f"  words={len(words)}")
    return words

def group_words(words, max_words=10, max_gap=0.7):
    # Semantic chunking: keep a phrase/clause together (1-2 lines), breaking at
    # clause punctuation, a long gap, or a word cap — not a fixed tiny count.
    groups, cur = [], []
    def closes(tok): return bool(re.search(r'[.,;:!?…—]$', tok.strip()))
    for w in words:
        if cur and (len(cur) >= max_words or w["start"] - cur[-1]["end"] > max_gap):
            groups.append(cur); cur = []
        cur.append(w)
        if len(cur) >= 3 and closes(w["w"]):   # end the chunk on clause punctuation
            groups.append(cur); cur = []
    if cur: groups.append(cur)
    for gi, g in enumerate(groups):
        gs = g[0]["start"]
        ge = groups[gi+1][0]["start"] if gi+1 < len(groups) else g[-1]["end"] + 0.6
        for w in g: w["disp_start"], w["disp_end"] = gs, ge
    return groups

def load_font(path, size):
    try: return ImageFont.truetype(path, size)
    except Exception as e:
        log("font fallback:", e)
        return ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", size)

def render(video, out, words, font_path, font_frac=0.075, accent=(0,230,118),
           pos_frac=0.78, max_words=4):
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    log(f"video {W}x{H} @ {fps:.2f}fps")
    groups = group_words(words, max_words=max_words)
    fs = max(20, int(H * font_frac))
    font = load_font(font_path, fs)
    stroke = max(2, int(fs * 0.16))
    space = int(fs * 0.34)
    tmp = out + ".silent.mp4"
    vw = cv2.VideoWriter(tmp, cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))

    def active_group(t):
        for g in groups:
            if g[0]["disp_start"] <= t < g[0]["disp_end"]: return g
        return None

    fi = 0
    while True:
        ok, frame = cap.read()
        if not ok: break
        t = fi / fps
        g = active_group(t)
        if g:
            sizes = [font.getbbox(w["w"], stroke_width=stroke) for w in g]
            widths = [b[2]-b[0] for b in sizes]
            line_h = max(b[3]-b[1] for b in sizes)
            line_gap = int(line_h * 0.30)
            max_line_w = int(W * 0.84)
            # wrap the semantic chunk into centered lines (1-2, occasionally 3)
            lines, cur, curw = [], [], 0
            for w, ww in zip(g, widths):
                add = ww + (space if cur else 0)
                if cur and curw + add > max_line_w:
                    lines.append(cur); cur, curw = [], 0; add = ww
                cur.append((w, ww)); curw += add
            if cur: lines.append(cur)
            total_h = line_h*len(lines) + line_gap*(len(lines)-1)
            y = int(H*pos_frac) - total_h//2
            ov = Image.new("RGBA", (W, H), (0,0,0,0)); d = ImageDraw.Draw(ov)
            for ln in lines:
                lw = sum(ww for _, ww in ln) + space*(len(ln)-1)
                x = (W - lw)//2
                for w, ww in ln:
                    active = w["start"] <= t < w["end"]
                    fill = accent+(255,) if active else (255,255,255,255)
                    d.text((x, y), w["w"], font=font, fill=fill,
                           stroke_width=stroke, stroke_fill=(0,0,0,255))
                    x += ww + space
                y += line_h + line_gap
            base = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)).convert("RGBA")
            base.alpha_composite(ov)
            frame = cv2.cvtColor(np.array(base.convert("RGB")), cv2.COLOR_RGB2BGR)
        vw.write(frame); fi += 1
    cap.release(); vw.release()
    log(f"rendered {fi} frames; muxing audio")
    r = subprocess.run(["ffmpeg","-y","-i",tmp,"-i",video,"-map","0:v:0","-map","1:a:0?",
                        "-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-shortest",out],
                       capture_output=True, text=True)
    if r.returncode != 0: log("mux failed:", r.stderr[-500:]); sys.exit(1)
    os.remove(tmp); log("wrote", out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--engine", default="whisper", choices=["whisper","llm"])
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="")
    ap.add_argument("--translate-to", dest="translate_to", default="")
    ap.add_argument("--font", default="/System/Library/Fonts/Supplemental/Arial Unicode.ttf")
    ap.add_argument("--max-words", dest="max_words", type=int, default=4)
    ap.add_argument("--pos-frac", dest="pos_frac", type=float, default=0.78)
    ap.add_argument("--font-frac", dest="font_frac", type=float, default=0.075)
    ap.add_argument("--accent", default="00E676")
    a = ap.parse_args()
    if a.engine == "llm":
        words = transcribe_llm(a.inp, a.translate_to)
    else:
        words = transcribe_whisper(a.inp, a.model, a.language, a.translate_to)
    if not words: log("no words"); sys.exit(1)
    h = a.accent.lstrip("#"); accent = tuple(int(h[i:i+2],16) for i in (0,2,4))
    render(a.inp, a.out, words, a.font, font_frac=a.font_frac, accent=accent,
           pos_frac=a.pos_frac, max_words=a.max_words)

if __name__ == "__main__":
    main()
