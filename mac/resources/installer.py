from os.path import join

assets = defines["assets"]
app = defines["app"]

format = "UDZO"
files = [(app, "Orbit.app")]
symlinks = {"Applications": "/Applications"}
icon = join(assets, "Orbit.icns")
background = join(assets, "Installer.png")
window_rect = ((180, 160), (580, 350))
icon_locations = {"Orbit.app": (173, 200), "Applications": (407, 200)}
icon_size = 96
text_size = 14
