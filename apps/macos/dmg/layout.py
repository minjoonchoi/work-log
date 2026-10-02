"""Regenerate finder-layout.bin from a mounted WorkLog DMG.

Development-only dependencies: ds-store==1.3.3, mac-alias==2.2.3.
Normal make build copies the checked-in layout and needs no Python packages.
Run from the repository root after mounting the DMG at /Volumes/WorkLog.
"""
from ds_store import DSStore
from mac_alias import Alias

with DSStore.open('apps/macos/dmg/finder-layout.bin', 'w+') as store:
    store['.']['bwsp'] = {
        'ShowStatusBar': False, 'ShowPathbar': False, 'ShowToolbar': False,
        'ShowSidebar': False, 'ContainerShowSidebar': False,
        'PreviewPaneVisibility': False, 'SidebarWidth': 0, 'ShowTabView': False,
        'WindowBounds': '{{300, 200}, {640, 380}}',
    }
    store['.']['icvp'] = {
        'viewOptionsVersion': 1, 'backgroundType': 2,
        'backgroundImageAlias': Alias.for_file('/Volumes/WorkLog/.background.png').to_bytes(),
        'backgroundColorRed': 1.0, 'backgroundColorGreen': 1.0, 'backgroundColorBlue': 1.0,
        'iconSize': 96.0, 'textSize': 13.0, 'gridSpacing': 100.0,
        'gridOffsetX': 0.0, 'gridOffsetY': 0.0,
        'scrollPositionX': 0.0, 'scrollPositionY': 0.0,
        'arrangeBy': 'none', 'showIconPreview': True,
        'showItemInfo': False, 'labelOnBottom': True,
    }
    store['.']['vSrn'] = ('long', 1)
    store['.']['icvl'] = ('type', b'icnv')
    store['WorkLog.app']['Iloc'] = (170, 190)
    store['Applications']['Iloc'] = (470, 190)
