# Start Menu

A customizable start menu for GNOME Shell with category management, recent apps, and search functionality.

## Features

- Custom categories with drag-and-drop ordering
- Recent apps tracking
- Fast application search
- Custom icons for categories and applications
- Full keyboard navigation
- Automatic application monitoring

## Compatibility

GNOME Shell 45, 46, 47, 48

## Installation

```bash
cp -r start_menu@slim8916.github.io ~/.local/share/gnome-shell/extensions/
gnome-extensions enable start_menu@slim8916.github.io
```

Restart GNOME Shell (Alt+F2, type `r` on X11, or log out/in on Wayland).

## Usage

Click the Start Menu icon in the top panel. Use arrow keys to navigate, Enter to launch, or type to search.

### Configuration

```bash
gnome-extensions prefs start_menu@slim8916.github.io
```

**Create Category**: Enter name, select apps, click "Add Category"
**Edit Category**: Click category, modify, click "Update Category"
**Custom Icons**: Right-click applications to customize
**Reorder**: Use up/down arrows to reorder categories

## Troubleshooting

- **Extension not showing**: Restart GNOME Shell and verify with `gnome-extensions list`
- **Categories not saving**: Check `.files/` directory permissions
- **Custom icons failing**: Use supported formats (PNG, JPG, SVG, etc.)

## License

MIT License - Copyright (c) 2020 Just Perfection
