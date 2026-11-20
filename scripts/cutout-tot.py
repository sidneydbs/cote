# Détoure les visuels de boosters Trick or Trade (fond blanc des photos produit) -> media/brand/totXX-l.png
import io, sys, urllib.request
from collections import deque
from PIL import Image
SRC = {"tot22": "https://tcgplayer-cdn.tcgplayer.com/product/280301_in_1000x1000.jpg",
       "tot23": "https://tcgplayer-cdn.tcgplayer.com/product/505945_in_1000x1000.jpg",
       "tot24": "https://tcgplayer-cdn.tcgplayer.com/product/579930_in_1000x1000.jpg"}
def cut(im, tol=34):
    im = im.convert("RGBA"); W, H = im.size; px = im.load()
    near = lambda c: c[0] > 255-tol and c[1] > 255-tol and c[2] > 255-tol
    seen = bytearray(W*H); q = deque()
    for x in range(W): q.extend([(x, 0), (x, H-1)])
    for y in range(H): q.extend([(0, y), (W-1, y)])
    while q:   # remplissage depuis les bords : seul le fond blanc relié au bord devient transparent
        x, y = q.popleft(); i = y*W+x
        if seen[i]: continue
        seen[i] = 1
        if not near(px[x, y]): continue
        px[x, y] = (255, 255, 255, 0)
        if x > 0: q.append((x-1, y))
        if x < W-1: q.append((x+1, y))
        if y > 0: q.append((x, y-1))
        if y < H-1: q.append((x, y+1))
    # bord adouci : les pixels presque blancs collés au fond deviennent semi-transparents
    a = im.split()[3]
    im = im.crop(a.getbbox())
    im.thumbnail((520, 520))
    return im
for k, u in SRC.items():
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    im = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=30).read()))
    im2 = cut(im); im2.thumbnail((200, 360)); im2.save(f"media/brand/{k}-l.webp", quality=86, method=6); print(k, "ok")
