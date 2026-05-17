import pathlib

tag = "m" + "otion"
p = pathlib.Path(__file__).parent.parent / "media/chat/chat.js"
t = p.read_text(encoding="utf-8")
t = t.replace("<" + tag, "<div")
t = t.replace("</" + tag + ">", "</div>")
t = t.replace("createElement(\"" + tag + "\")", "createElement(\"motion\")")
# fix the botched line above - use div
t = t.replace("createElement(\"motion\")", "createElement(\"div\")")
p.write_text(t, encoding="utf-8")
assert "createElement(\"motion\")" not in t
assert "<" + tag not in t
print("fixed chat.js")
