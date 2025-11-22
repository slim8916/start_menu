// extension.js — GNOME 45+/48, ES Modules

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

// -------- Constants --------
const ALL_APPS_CAT = 'All apps';
const SEARCH_APP_CAT = 'Search app';
const RECENTS_CAT = 'Recent apps';
const MAX_RECENTS = 15;
const RELOAD_DELAY_MS = 500;
const ALLOWED_IMAGE_EXTENSIONS = ['jpeg', 'jpg', 'png', 'bmp', 'webp', 'ico', 'svg'];

// -------- Module State --------
let basePath = null;
let filesDir = null;
let categoriesFilePath = null;
let recentsFilePath = null;
let iconDir = null;
let iconCategoriesDir = null;
let iconAppsDir = null;
let pathCategoryGenericIcon = null;

let categories = new Map();
let allIconCategories = new Map();
let allIconApps = new Map();
let allApps = [];
let recents = [];

let myPopup = null;
let monitors = [];
let reloadTimeoutId = 0;
let signalConnections = [];

// -------- Signal Management --------

/**
 * Connects a signal and tracks it for cleanup.
 * @param {GObject.Object} obj - Object to connect signal to
 * @param {string} signal - Signal name
 * @param {Function} handler - Signal handler function
 * @returns {number} Signal ID
 */
function connectAndTrack(obj, signal, handler) {
    const id = obj.connect(signal, handler);
    signalConnections.push({ obj, id });
    return id;
}

/**
 * Disconnects all tracked signals.
 */
function disconnectAllSignals() {
    signalConnections.forEach(({ obj, id }) => {
        if (obj && !obj.is_finalized?.())
            obj.disconnect(id);
    });
    signalConnections = [];
}

// -------- Icon Management --------

/**
 * Scans a folder for image files and builds a map of base names to extensions.
 * @param {string} folderPath - Path to the folder containing icon files
 * @returns {Map<string, string>} Map of base filename to extension
 */
function getAllIcons(folderPath) {
    try {
        const folder = Gio.File.new_for_path(folderPath);
        const enumerator = folder.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null
        );

        const fileMap = new Map();
        let fileInfo;

        while ((fileInfo = enumerator.next_file(null)) !== null) {
            const fileName = fileInfo.get_name();
            if (!fileName.includes('.'))
                continue;

            const parts = fileName.split('.');
            const extension = parts.pop();
            const baseName = parts.join('.');

            if (ALLOWED_IMAGE_EXTENSIONS.includes(extension))
                fileMap.set(baseName, extension);
        }

        enumerator.close(null);
        return fileMap;
    } catch (e) {
        logError(e, `Failed to build icon map from ${folderPath}`);
        return new Map();
    }
}

// -------- Category Management --------

/**
 * Loads categories from the categories.jsonl file.
 */
function loadCategoriesFromDisk() {
    try {
        const file = Gio.File.new_for_path(categoriesFilePath);
        const [success, contents] = file.load_contents(null);

        if (!success)
            return;

        const text = new TextDecoder().decode(contents);
        const lines = text.split('\n').filter(line => line.trim().length > 0);

        categories.clear();
        lines.forEach(line => {
            const category = JSON.parse(line);
            categories.set(category.name, category);
        });
    } catch (e) {
        // First run or missing file - this is expected, not an error
    }
}

/**
 * Returns an array of standard application directories to monitor.
 * @returns {string[]} Array of directory paths
 */
function getApplicationDirectories() {
    return [
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'applications']),
        '/usr/share/applications',
    ];
}

// -------- UI Item Creation --------

/**
 * Creates an icon widget for menu items.
 * @param {number} iconSize - Size of the icon in pixels
 * @param {string|null} customIconPath - Path to custom icon file, or null
 * @param {Gio.Icon|null} gicon - GIcon to use if no custom path
 * @returns {St.Widget|St.Icon} Icon widget
 */
function createIconWidget(iconSize, customIconPath = null, gicon = null) {
    if (customIconPath) {
        const icon = new St.Widget({
            style_class: 'my-image-style',
            width: iconSize,
            height: iconSize,
        });
        icon.set_style(`background-image: url("file://${customIconPath}");`);
        return icon;
    }

    return new St.Icon({
        gicon,
        style_class: 'system-status-icon',
        icon_size: iconSize,
    });
}

/**
 * Creates a menu item for a category.
 * @param {Object} category - Category object with name and apps
 * @returns {PopupMenu.PopupBaseMenuItem} The created menu item
 */
function createCategoryItem(category) {
    const menuItem = new PopupMenu.PopupBaseMenuItem({
        can_focus: true,
        reactive: true,
    });
    menuItem.add_style_class_name('popup-menu-category');

    const label = new St.Label({
        text: category.name,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'category-name',
    });

    const fontSize = label.get_theme_node()?.get_length('font-size') || 24;
    const iconSize = Math.round(fontSize * 2);

    const iconPath = allIconCategories.has(category.name)
        ? GLib.build_filenamev([
            iconCategoriesDir,
            `${category.name}.${allIconCategories.get(category.name)}`,
        ])
        : pathCategoryGenericIcon;

    const icon = createIconWidget(iconSize, iconPath);

    menuItem.insert_child_at_index(icon, 0);
    menuItem.insert_child_at_index(label, 1);

    connectAndTrack(menuItem, 'enter-event', () => {
        myPopup.appsMenu?.destroy_all_children();

        category.apps.forEach(app => {
            const appMenuItem = createAppItem(app);
            if (appMenuItem) {
                myPopup.appsMenu.add_child(appMenuItem);
            }
        });

        if (myPopup.focusedCategory && myPopup.focusedCategory !== menuItem)
            myPopup.focusedCategory.remove_style_class_name('selected-item');

        menuItem.add_style_class_name('selected-item');
        myPopup.focusedCategory = menuItem;

        myPopup.menuItemSearch?.searchEntry.clutter_text.set_text('');
    });

    return menuItem;
}


/**
 * Creates a menu item for an application.
 * @param {Object} app - App object with id and name properties
 * @returns {PopupMenu.PopupBaseMenuItem|null} The created menu item, or null if app doesn't exist
 */
function createAppItem(app) {
    const desktopId = app.id.endsWith('.desktop') ? app.id : `${app.id}.desktop`;
    const appInfo = Gio.DesktopAppInfo.new(desktopId);

    // Skip if app is not installed or shouldn't be shown
    if (!appInfo || !appInfo.should_show())
        return null;

    const menuItem = new PopupMenu.PopupBaseMenuItem({
        can_focus: true,
        reactive: true,
    });
    menuItem.add_style_class_name('popup-menu-category');

    const label = new St.Label({
        text: app.name,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const fontSize = label.get_theme_node()?.get_length('font-size') || 24;
    const iconSize = Math.round(fontSize * 1.8);

    const customIconPath = allIconApps.has(app.id)
        ? GLib.build_filenamev([iconAppsDir, `${app.id}.${allIconApps.get(app.id)}`])
        : null;

    const gicon = appInfo?.get_icon() ?? null;
    const icon = createIconWidget(iconSize, customIconPath, gicon);

    menuItem.insert_child_at_index(icon, 0);
    menuItem.insert_child_at_index(label, 1);

    connectAndTrack(menuItem, 'activate', () => {
        const appSystem = Shell.AppSystem.get_default();
        const shellApp = appSystem.lookup_app(desktopId);

        bumpRecent(desktopId);

        if (shellApp) {
            shellApp.activate();
        } else if (appInfo) {
            appInfo.launch([], null);
        } else {
            Main.notifyError('Start Menu', `Could not launch app: ${desktopId}`);
        }

        myPopup.menu.close();
    });

    return menuItem;
}

/**
 * Creates a menu item for a searched application (from Gio.AppInfo).
 * @param {Gio.AppInfo} app - Application info object
 * @returns {PopupMenu.PopupBaseMenuItem} The created menu item
 */
function createSearchedAppItem(app) {
    const menuItem = new PopupMenu.PopupBaseMenuItem({
        can_focus: true,
        reactive: true,
    });
    menuItem.add_style_class_name('popup-menu-category');

    const label = new St.Label({
        text: app.get_display_name(),
        y_align: Clutter.ActorAlign.CENTER,
    });
    const fontSize = label.get_theme_node()?.get_length('font-size') || 24;
    const iconSize = Math.round(fontSize * 1.8);

    const icon = createIconWidget(iconSize, null, app.get_icon());

    menuItem.insert_child_at_index(icon, 0);
    menuItem.insert_child_at_index(label, 1);

    connectAndTrack(menuItem, 'activate', () => {
        const desktopId = app.get_id?.() ?? '';
        const appSystem = Shell.AppSystem.get_default();
        const shellApp = desktopId ? appSystem.lookup_app(desktopId) : null;

        if (desktopId)
            bumpRecent(desktopId);

        if (shellApp) {
            shellApp.activate();
        } else {
            app.launch([], null);
        }

        myPopup.menu.close();
    });

    return menuItem;
}

// -------- Recent Apps Management --------

/**
 * Loads recent apps from the recents.jsonl file.
 */
function loadRecentsFromDisk() {
    try {
        const file = Gio.File.new_for_path(recentsFilePath);
        const [success, contents] = file.load_contents(null);

        if (!success)
            return;

        const text = new TextDecoder().decode(contents);
        const lines = text.split('\n').filter(line => line.trim().length > 0);

        recents = lines
            .map(line => JSON.parse(line))
            .filter(recent => recent && typeof recent.id === 'string')
            .slice(0, MAX_RECENTS);
    } catch (e) {
        recents = [];
    }
}

/**
 * Saves recent apps to disk.
 */
function saveRecentsToDisk() {
    try {
        const data = recents.map(recent => JSON.stringify(recent)).join('\n');
        GLib.file_set_contents(recentsFilePath, data);
    } catch (e) {
        logError(e, 'Failed to write recents.jsonl');
        Main.notifyError('Start Menu', 'Could not save recents.jsonl');
    }
}

/**
 * Adds or moves an app to the top of the recent list.
 * @param {string} desktopId - Desktop file ID
 */
function bumpRecent(desktopId) {
    if (!desktopId || !desktopId.endsWith('.desktop'))
        return;

    recents = recents.filter(recent => recent.id !== desktopId);
    recents.unshift({ id: desktopId, ts: Date.now() });

    if (recents.length > MAX_RECENTS)
        recents.length = MAX_RECENTS;

    saveRecentsToDisk();
}

/**
 * Gets AppInfo objects for all valid recent apps.
 * @returns {Gio.AppInfo[]} Array of valid AppInfo objects
 */
function getRecentAppInfos() {
    return recents
        .map(recent => Gio.DesktopAppInfo.new(recent.id))
        .filter(appInfo => appInfo !== null && appInfo.should_show());
}

/**
 * Creates the recent apps category menu item.
 * @returns {PopupMenu.PopupBaseMenuItem} The created menu item
 */
function createRecentsCategoryItem() {
    const menuItem = new PopupMenu.PopupBaseMenuItem({
        can_focus: true,
        reactive: true,
    });
    menuItem.add_style_class_name('popup-menu-category');
    menuItem._tag = 'recents';

    const label = new St.Label({
        text: RECENTS_CAT,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'category-name',
    });

    const fontSize = label.get_theme_node()?.get_length('font-size') || 24;
    const iconSize = Math.round(fontSize * 2);

    const icon = new St.Icon({
        icon_name: 'document-open-recent-symbolic',
        style_class: 'system-status-icon',
        icon_size: iconSize,
    });

    menuItem.insert_child_at_index(icon, 0);
    menuItem.insert_child_at_index(label, 1);

    connectAndTrack(menuItem, 'enter-event', () => {
        myPopup.appsMenu?.destroy_all_children();

        const recentAppInfos = getRecentAppInfos();

        if (recentAppInfos.length === 0) {
            const emptyLabel = new St.Label({
                text: 'No recent apps yet',
                y_align: Clutter.ActorAlign.CENTER,
            });
            myPopup.appsMenu.add_child(emptyLabel);
        } else {
            recentAppInfos.forEach(appInfo => {
                myPopup.appsMenu.add_child(createSearchedAppItem(appInfo));
            });
        }

        if (myPopup.focusedCategory && myPopup.focusedCategory !== menuItem)
            myPopup.focusedCategory.remove_style_class_name('selected-item');

        menuItem.add_style_class_name('selected-item');
        myPopup.focusedCategory = menuItem;

        myPopup.menuItemSearch?.searchEntry.clutter_text.set_text('');
    });

    return menuItem;
}


// -------- Main Popup Button --------

/**
 * Main popup button for the start menu.
 */
const MyPopup = GObject.registerClass(
    class MyPopup extends PanelMenu.Button {
        _init() {
            super._init(2);
            this.set_style('padding: 0; margin: 0;');

            const icon = new St.Icon({
                gicon: Gio.icon_new_for_string(
                    GLib.build_filenamev([iconDir, 'icon.svg'])
                ),
            });
            this.add_child(icon);

            const mainMenuItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            if (mainMenuItem._ornamentLabel) {
                mainMenuItem.remove_child(mainMenuItem._ornamentLabel);
                mainMenuItem._ornamentLabel = null;
            }

            const mainMenu = new St.BoxLayout({ vertical: false });

            this.categoriesMenu = new St.BoxLayout({ vertical: true });
            mainMenu.add_child(this.categoriesMenu);

            this.appsMenu = new St.BoxLayout({ vertical: true });
            this.scrollView = new St.ScrollView({
                style_class: 'scroll-view',
                overlay_scrollbars: true,
                x_expand: true,
            });
            this.scrollView.set_child(this.appsMenu);
            mainMenu.add_child(this.scrollView);

            this._populateCategoriesMenu();

            this.categoriesMenu.add_child(createRecentsCategoryItem());

            this._setupSearchEntry();

            mainMenuItem.add_child(mainMenu);
            this.menu.addMenuItem(mainMenuItem);

            this._setupMenuBehavior();
        }

        _populateCategoriesMenu() {
            // Get normal categories (excluding special ones) and sort by rank
            const normalCategories = Array.from(categories.values())
                .filter(category => category.name !== ALL_APPS_CAT && category.name !== SEARCH_APP_CAT)
                .sort((a, b) => {
                    // Handle null ranks (though normal categories shouldn't have null)
                    if (a.rank === null) return 1;
                    if (b.rank === null) return -1;
                    return a.rank - b.rank;
                });

            // Add sorted categories
            normalCategories.forEach(category => {
                this.categoriesMenu.add_child(createCategoryItem(category));
            });

            // Add "All Apps" category if exists
            if (categories.has(ALL_APPS_CAT)) {
                const menuItem = createCategoryItem(categories.get(ALL_APPS_CAT));
                const label = menuItem.get_child_at_index(1);

                if (label)
                    label.text = 'Show all applications';

                connectAndTrack(menuItem, 'activate', () => {
                    this.menu.close();

                    if (!Main.overview.visible)
                        Main.overview.show();

                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        Main.overview.viewSelector?.showApps?.();
                        return GLib.SOURCE_REMOVE;
                    });
                });

                connectAndTrack(menuItem, 'enter-event', () => {
                    this.appsMenu.destroy_all_children();
                });

                this.categoriesMenu.add_child(menuItem);
            }
        }

        _setupSearchEntry() {
            if (!categories.has(SEARCH_APP_CAT))
                return;

            this.menuItemSearch = new PopupMenu.PopupBaseMenuItem({
                reactive: true,
                can_focus: true,
            });

            if (typeof this.menuItemSearch.setOrnament === 'function' && PopupMenu.Ornament) {
                this.menuItemSearch.setOrnament(PopupMenu.Ornament.NONE);
            } else if (this.menuItemSearch._ornamentLabel) {
                this.menuItemSearch.remove_child(this.menuItemSearch._ornamentLabel);
                this.menuItemSearch._ornamentLabel = null;
            }

            this.menuItemSearch.searchEntry = new St.Entry({
                hint_text: 'Search for an app...                 ',
                can_focus: true,
                x_expand: true,
                y_expand: true,
                style_class: 'category-name',
            });

            this.menuItemSearch.add_child(this.menuItemSearch.searchEntry);
            this.categoriesMenu.add_child(this.menuItemSearch);

            connectAndTrack(this.menuItemSearch, 'enter-event', () => {
                if (this.focusedCategory && this.focusedCategory !== this.menuItemSearch)
                    this.focusedCategory.remove_style_class_name('selected-item');

                this.menuItemSearch.add_style_class_name('selected-item');
                this.focusedCategory = this.menuItemSearch;
                this.menuItemSearch.searchEntry.grab_key_focus();
            });

            connectAndTrack(this.menuItemSearch.searchEntry.clutter_text, 'text-changed', clutterText => {
                this.appsMenu.destroy_all_children();

                const searchText = clutterText.get_text().trim().toLowerCase();

                // Filter apps that should be shown and match search text
                const matchingApps = allApps.filter(app =>
                    app.should_show() && app.get_display_name().toLowerCase().includes(searchText)
                );

                // Deduplicate by app ID to avoid showing the same app multiple times
                const seenIds = new Set();
                const uniqueApps = matchingApps.filter(app => {
                    const appId = app.get_id?.() ?? '';
                    if (!appId || seenIds.has(appId)) {
                        return false;
                    }
                    seenIds.add(appId);
                    return true;
                });

                uniqueApps.forEach(app => {
                    this.appsMenu.add_child(createSearchedAppItem(app));
                });
            });
        }

        _setupMenuBehavior() {
            this.focusedCategory = null;
            this.focusedApp = null;
            this.isInAppsColumn = false;

            connectAndTrack(this.menu, 'open-state-changed', (_menu, isOpen) => {
                if (!isOpen)
                    return;

                this.scrollView.height = this.categoriesMenu.get_height();
                this.appsMenu.destroy_all_children();
                this.focusedApp = null;
                this.isInAppsColumn = false;

                if (this.focusedCategory)
                    this.focusedCategory.remove_style_class_name('selected-item');

                if (this.menuItemSearch) {
                    this.menuItemSearch.add_style_class_name('selected-item');
                    this.menuItemSearch.searchEntry.clutter_text.set_text('');

                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this.menuItemSearch.searchEntry.grab_key_focus();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });

            // Add keyboard navigation
            connectAndTrack(this.menu.actor, 'key-press-event', (_actor, event) => {
                const symbol = event.get_key_symbol();

                // Handle arrow keys
                if (symbol === Clutter.KEY_Up) {
                    this._navigateVertical(-1);
                    return Clutter.EVENT_STOP;
                } else if (symbol === Clutter.KEY_Down) {
                    this._navigateVertical(1);
                    return Clutter.EVENT_STOP;
                } else if (symbol === Clutter.KEY_Left) {
                    this._navigateToCategories();
                    return Clutter.EVENT_STOP;
                } else if (symbol === Clutter.KEY_Right) {
                    this._navigateToApps();
                    return Clutter.EVENT_STOP;
                } else if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                    this._activateFocusedItem();
                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_PROPAGATE;
            });
        }

        _navigateVertical(direction) {
            if (this.isInAppsColumn) {
                // Navigate in apps list
                const children = this.appsMenu.get_children();
                if (children.length === 0) return;

                let currentIndex = this.focusedApp ? children.indexOf(this.focusedApp) : -1;
                let newIndex = currentIndex + direction;

                // Wrap around
                if (newIndex < 0) newIndex = children.length - 1;
                if (newIndex >= children.length) newIndex = 0;

                const newFocus = children[newIndex];
                if (this.focusedApp && this.focusedApp !== newFocus)
                    this.focusedApp.remove_style_pseudo_class('hover');

                newFocus.add_style_pseudo_class('hover');
                this.focusedApp = newFocus;

                // Scroll to make visible
                this._scrollToActor(newFocus);
            } else {
                // Navigate in categories list
                const children = Array.from(this.categoriesMenu.get_children()).filter(
                    child => child instanceof PopupMenu.PopupBaseMenuItem
                );
                if (children.length === 0) return;

                let currentIndex = this.focusedCategory ? children.indexOf(this.focusedCategory) : -1;
                let newIndex = currentIndex + direction;

                // Wrap around
                if (newIndex < 0) newIndex = children.length - 1;
                if (newIndex >= children.length) newIndex = 0;

                const newFocus = children[newIndex];
                if (newFocus) {
                    // Trigger the category's enter-event to load its apps
                    newFocus.emit('enter-event', null);
                }
            }
        }

        _navigateToApps() {
            if (this.isInAppsColumn) return;

            const appChildren = this.appsMenu.get_children();
            if (appChildren.length === 0) return;

            this.isInAppsColumn = true;

            // Focus first app
            const firstApp = appChildren[0];
            firstApp.add_style_pseudo_class('hover');
            this.focusedApp = firstApp;
            this._scrollToActor(firstApp);
        }

        _navigateToCategories() {
            if (!this.isInAppsColumn) return;

            this.isInAppsColumn = false;

            // Remove hover from apps
            if (this.focusedApp) {
                this.focusedApp.remove_style_pseudo_class('hover');
                this.focusedApp = null;
            }

            // Focus stays on current category
        }

        _activateFocusedItem() {
            if (this.isInAppsColumn && this.focusedApp) {
                this.focusedApp.emit('activate', null);
            } else if (this.focusedCategory && !this.isInAppsColumn) {
                // If it's a special category (All Apps), activate it
                this.focusedCategory.emit('activate', null);
            }
        }

        _scrollToActor(actor) {
            const adjustment = this.scrollView.get_vscroll_bar().get_adjustment();
            const [value, lower, upper, stepIncrement, pageIncrement, pageSize] = [
                adjustment.value,
                adjustment.lower,
                adjustment.upper,
                adjustment.step_increment,
                adjustment.page_increment,
                adjustment.page_size,
            ];

            let offset = 0;
            const box = this.appsMenu;
            const children = box.get_children();

            for (let child of children) {
                if (child === actor) break;
                offset += child.get_height();
            }

            if (offset < value) {
                adjustment.value = offset;
            } else if (offset + actor.get_height() > value + pageSize) {
                adjustment.value = offset + actor.get_height() - pageSize;
            }
        }
    });

// -------- Application Directory Monitoring --------

/**
 * Rebuilds the categories menu in the popup.
 */
function rebuildCategoriesMenu() {
    if (!myPopup)
        return;

    // Clear existing categories (except search which is added separately)
    myPopup.categoriesMenu.destroy_all_children();

    // Repopulate categories
    myPopup._populateCategoriesMenu();

    // Re-add recent apps category
    myPopup.categoriesMenu.add_child(createRecentsCategoryItem());

    // Re-setup search entry
    myPopup._setupSearchEntry();
}

/**
 * Sets up listeners to watch for application installations/uninstallations.
 */
function setupAppListWatcher() {
    // Use Shell.AppSystem which reliably detects app changes
    const appSystem = Shell.AppSystem.get_default();

    connectAndTrack(appSystem, 'installed-changed', () => {
        if (reloadTimeoutId)
            GLib.source_remove(reloadTimeoutId);

        reloadTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            RELOAD_DELAY_MS,
            () => {
                allApps = Gio.AppInfo.get_all();
                reloadTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }
        );
    });

    // Also monitor application directories as a fallback
    getApplicationDirectories().forEach(dirPath => {
        const dirFile = Gio.File.new_for_path(dirPath);

        try {
            const monitor = dirFile.monitor_directory(
                Gio.FileMonitorFlags.NONE,
                null
            );

            connectAndTrack(monitor, 'changed', () => {
                if (reloadTimeoutId)
                    GLib.source_remove(reloadTimeoutId);

                reloadTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    RELOAD_DELAY_MS,
                    () => {
                        allApps = Gio.AppInfo.get_all();
                        reloadTimeoutId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                );
            });

            monitors.push(monitor);
        } catch (e) {
            // Ignore directories we can't monitor
        }
    });
}

/**
 * Sets up a file monitor to watch the categories file for changes.
 */
function setupCategoriesFileWatcher() {
    try {
        const categoriesFile = Gio.File.new_for_path(categoriesFilePath);

        const monitor = categoriesFile.monitor_file(
            Gio.FileMonitorFlags.NONE,
            null
        );

        connectAndTrack(monitor, 'changed', (_monitor, _file, _otherFile, eventType) => {
            // Only reload on changes or creation, not on attribute changes
            if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                eventType === Gio.FileMonitorEvent.CREATED) {

                if (reloadTimeoutId)
                    GLib.source_remove(reloadTimeoutId);

                reloadTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    RELOAD_DELAY_MS,
                    () => {
                        loadCategoriesFromDisk();
                        allIconCategories = getAllIcons(iconCategoriesDir);
                        allIconApps = getAllIcons(iconAppsDir);
                        rebuildCategoriesMenu();
                        reloadTimeoutId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                );
            }
        });

        monitors.push(monitor);
    } catch (e) {
        // Categories file doesn't exist yet - this is ok on first run
    }
}

// -------- Extension Entry Point --------

/**
 * Main extension class for Start Menu.
 */
export default class StartMenuExtension extends Extension {
    enable() {
        // Initialize paths
        basePath = this.path;
        filesDir = GLib.build_filenamev([basePath, '.files']);
        categoriesFilePath = GLib.build_filenamev([filesDir, 'categories.jsonl']);
        recentsFilePath = GLib.build_filenamev([filesDir, 'recents.jsonl']);
        iconDir = GLib.build_filenamev([filesDir, 'icons']);
        iconCategoriesDir = GLib.build_filenamev([iconDir, 'categories']);
        iconAppsDir = GLib.build_filenamev([iconDir, 'apps']);
        pathCategoryGenericIcon = GLib.build_filenamev([iconDir, 'category_icon.png']);

        // Load data
        loadCategoriesFromDisk();
        loadRecentsFromDisk();
        allIconCategories = getAllIcons(iconCategoriesDir);
        allIconApps = getAllIcons(iconAppsDir);
        allApps = Gio.AppInfo.get_all();

        // Create UI
        myPopup = new MyPopup();
        Main.panel.addToStatusArea('startMenu', myPopup, 1, 'left');

        // Watch for application and category changes
        setupAppListWatcher();
        setupCategoriesFileWatcher();
    }

    disable() {
        // Disconnect all tracked signals
        disconnectAllSignals();

        // Cancel file monitors
        monitors.forEach(monitor => {
            if (monitor && !monitor.is_cancelled())
                monitor.cancel();
        });
        monitors = [];

        // Remove timeout
        if (reloadTimeoutId) {
            GLib.source_remove(reloadTimeoutId);
            reloadTimeoutId = 0;
        }

        // Destroy popup
        if (myPopup) {
            myPopup.destroy();
            myPopup = null;
        }

        // Clear data structures
        categories.clear();
        allIconCategories.clear();
        allIconApps.clear();
        allApps = [];
        recents = [];

        // Clear paths
        basePath = null;
        filesDir = null;
        categoriesFilePath = null;
        recentsFilePath = null;
        iconDir = null;
        iconCategoriesDir = null;
        iconAppsDir = null;
        pathCategoryGenericIcon = null;
    }
}
