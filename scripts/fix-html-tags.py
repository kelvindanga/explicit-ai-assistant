import pathlib
import sys

for path in sys.argv[1:]:
    p = pathlib.Path(path)
    t = p.read_text(encoding="utf-8")
    t = t.replace("<motion", "<div").replace("</motion>", "</div>")
    p.write_text(t, encoding="utf-8")
    if "motion" in t:
        raise SystemExit(f"still has motion: {path}")
    print("fixed", path)
