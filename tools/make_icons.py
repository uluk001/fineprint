import sys
from PIL import Image, ImageDraw, ImageFont

def make(size, path):
    scale = 8
    S = size * scale
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(S * 0.22)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(31, 58, 95, 255))
    # document sheet
    m = int(S * 0.2)
    d.rounded_rectangle([m, int(S * 0.14), S - m, int(S * 0.86)], radius=int(S * 0.06), fill=(255, 255, 255, 255))
    # text lines
    lx0, lx1 = int(S * 0.3), int(S * 0.7)
    for i, y in enumerate([0.3, 0.42, 0.54, 0.66]):
        yy = int(S * y)
        x1 = lx1 if i != 3 else int(S * 0.56)
        color = (198, 46, 46, 255) if i == 2 else (150, 160, 175, 255)
        h = int(S * 0.055) if i == 2 else int(S * 0.04)
        d.rounded_rectangle([lx0, yy, x1, yy + h], radius=h // 2, fill=color)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)

for s in (16, 32, 48, 128):
    make(s, f"extension/public/icons/icon{s}.png")
make(128, "web/public/icon128.png")
print("ok")
