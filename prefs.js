// prefs.js — GNOME 48+, GTK4, ES Modules

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// -------- Constants --------
const ALL_APPS_CAT_NAME = 'All apps';
const SEARCH_APP_CAT_NAME = 'Search app';
const ALLOWED_IMAGE_EXTENSIONS = ['jpeg', 'jpg', 'png', 'bmp', 'webp', 'ico', 'svg'];

// UI Constants
const ICON_SIZE = 40;
const DEFAULT_MARGIN = 16;
const MIN_DIALOG_WIDTH = 400;
const MAX_VISIBLE_ROWS = 10;

// -------- Module State --------
let basePath = null;
let filesDir = null;
let categoriesFilePath = null;
let iconDir = null;
let iconCategoriesDir = null;
let iconAppsDir = null;
let pathCategoryGenericIcon = null;

let allIconCategories = null;
let allIconApps = null;

let categories = new Map();
let categoriesListBox = null;
let upButton = null;
let downButton = null;
let categoryEntry = null;
let addButton = null;
let appsListBox = null;
let categoryIcon = null;

// -------- UI Helper Functions --------

/**
 * Creates a horizontal box with standard spacing.
 * @param {number} spacing - Spacing between children (default: 10)
 * @returns {Gtk.Box} Horizontal box
 */
function createHorizontalBox(spacing = 10) {
    return new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing,
    });
}

/**
 * Creates a Gtk.Image widget for icons.
 * @param {number} size - Icon size in pixels
 * @param {string|null} iconPath - Path to icon file, or null
 * @returns {Gtk.Image} Image widget
 */
function createIconImage(size, iconPath = null) {
    const image = new Gtk.Image({ pixel_size: size });
    if (iconPath)
        image.set_from_file(iconPath);
    return image;
}

// -------- Icon Management --------

/**
 * Scans a folder for image files and builds a map of base names to extensions.
 * @param {string} folderPath - Path to the folder containing icon files
 * @returns {Map<string, string>|null} Map of base filename to extension, or null on error
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
        logError(e, `Failed to create filtered file map from ${folderPath}`);
        return null;
    }
}

// -------- Category Management --------

/**
 * Loads categories from the categories.jsonl file.
 * @param {Map} categoriesMap - Map to populate with loaded categories
 */
function loadCategories(categoriesMap) {
    try {
        const file = Gio.File.new_for_path(categoriesFilePath);
        const [success, contents] = file.load_contents(null);

        if (!success)
            return;

        const text = new TextDecoder().decode(contents);
        const lines = text.split('\n').filter(line => line.trim().length > 0);

        categoriesMap.clear();
        lines.forEach(line => {
            const category = JSON.parse(line);
            categoriesMap.set(category.name, category);
        });
    } catch (error) {
        logError(error, 'Failed to load categories.jsonl');
    }
}

/**
 * Saves categories to the categories.jsonl file.
 */
function saveCategoriesToFile() {
    try {
        const lines = Array.from(categories.values())
            .map(category => JSON.stringify(category))
            .join('\n');

        const categoriesFile = Gio.File.new_for_path(categoriesFilePath);
        const outputStream = categoriesFile.replace(
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null
        );

        outputStream.write_all(lines + '\n', null);
        outputStream.close(null);
    } catch (error) {
        logError(error, 'Failed to save categories.jsonl');
    }
}

/**
 * Cleans up categories by removing uninstalled apps and fixing rankings.
 * @returns {boolean} True if any changes were made, false otherwise
 */
function cleanupCategories() {
    let changesMade = false;

    categories.forEach((category, categoryName) => {
        // Skip special categories without apps
        if (!category.apps || category.apps.length === 0)
            return;

        const originalLength = category.apps.length;

        // Filter out apps that are no longer installed or shouldn't be shown
        const validApps = category.apps.filter(app => {
            const desktopId = app.id.endsWith('.desktop') ? app.id : `${app.id}.desktop`;
            const appInfo = Gio.DesktopAppInfo.new(desktopId);
            return appInfo !== null && appInfo.should_show();
        });

        // Check if any apps were removed
        if (validApps.length !== originalLength) {
            changesMade = true;

            // Recalculate rankings to ensure they're sequential (1, 2, 3, ...)
            validApps.sort((a, b) => a.rank - b.rank);
            validApps.forEach((app, index) => {
                app.rank = index + 1;
            });

            // Update the category
            category.apps = validApps;
            categories.set(categoryName, category);
        }
    });

    return changesMade;
}

/**
 * Refreshes the categories list box by rebuilding it from the categories map.
 */
function refreshCategoriesListBox() {
    // Clear existing rows
    let row = categoriesListBox.get_first_child();
    while (row) {
        const next = row.get_next_sibling();
        categoriesListBox.remove(row);
        row = next;
    }

    // Sort categories by rank (null ranks go to end) and rebuild
    const sortedCategories = Array.from(categories.values()).sort((a, b) => {
        if (a.rank === null && b.rank === null) return 0;
        if (a.rank === null) return 1;
        if (b.rank === null) return -1;
        return a.rank - b.rank;
    });

    for (const category of sortedCategories) {
        if (category.apps?.length)
            fillCategoriesList(category);
    }
}

/**
 * Moves the selected category up or down in the list.
 * @param {number} delta - Direction to move (-1 for up, +1 for down)
 */
function moveSelectedCategory(delta) {
    try {
        const selectedRow = categoriesListBox?.get_selected_row();
        if (!selectedRow)
            return;

        const categoryName = selectedRow.category;
        const currentCategory = categories.get(categoryName);

        // Only move categories with non-null ranks
        if (!currentCategory || currentCategory.rank === null)
            return;

        // Get all categories with non-null ranks, sorted by rank
        const rankedCategories = Array.from(categories.values())
            .filter(cat => cat.rank !== null)
            .sort((a, b) => a.rank - b.rank);

        const currentIndex = rankedCategories.findIndex(cat => cat.name === categoryName);
        const newIndex = currentIndex + delta;

        if (currentIndex < 0 || newIndex < 0 || newIndex >= rankedCategories.length)
            return;

        // Swap ranks with the target category
        const targetCategory = rankedCategories[newIndex];
        const tempRank = currentCategory.rank;
        currentCategory.rank = targetCategory.rank;
        targetCategory.rank = tempRank;

        saveCategoriesToFile();
        refreshCategoriesListBox();

        // Restore selection on moved row
        let row = categoriesListBox.get_first_child();
        while (row) {
            if (row.category === categoryName) {
                categoriesListBox.select_row(row);
                break;
            }
            row = row.get_next_sibling();
        }
    } catch (e) {
        logError(e, 'Failed to move category');
    }
}

// -------- UI Building --------

/**
 * Populates the applications list box with all available applications.
 * @param {Gtk.ListBox} appsListBox - The list box to populate
 */
function fillApplicationsList(appsListBox) {
    const idNameMap = new Map();
    categories.forEach(category => {
        category.apps.forEach(app => {
            idNameMap.set(app.id, app.name);
        });
    });

    const apps = Gio.AppInfo.get_all();

    apps.forEach(app => {
        if (!app.should_show())
            return;

        const row = new Gtk.ListBoxRow();
        row.selectionRank = 0;
        row.id = app.get_id();
        row.name = idNameMap.get(row.id) ?? app.get_display_name();
        row.iconPath = '';

        const box = createHorizontalBox();

        const customIconPath = allIconApps.has(row.id)
            ? GLib.build_filenamev([iconAppsDir, `${row.id}.${allIconApps.get(row.id)}`])
            : null;

        const appIcon = createIconImage(32, customIconPath);
        if (!customIconPath && app.get_icon())
            appIcon.set_from_gicon(app.get_icon());

        box.append(appIcon);

        const appLabel = new Gtk.Label({ label: row.name, xalign: 0 });
        appLabel.set_hexpand(true);
        box.append(appLabel);

        const rankLabel = new Gtk.Label({ label: '', xalign: 1 });
        rankLabel.get_style_context().add_class('padding-label');
        box.append(rankLabel);

        row.set_child(box);
        row.get_style_context().add_class('custom-row');
        appsListBox.append(row);
    });

    appsListBox.invalidate_sort();
    appsListBox.set_selection_mode(Gtk.SelectionMode.MULTIPLE);
    appsListBox.show();
}

/**
 * Clears the selection in the applications list box.
 * @param {Gtk.ListBox} appsListBox - The list box to clear
 */
function initializeAppsList(appsListBox) {
    const selectedRows = appsListBox.get_selected_rows();

    selectedRows.forEach(row => {
        row.selectionRank = 0;
        row.get_child().get_last_child().set_label('');
        appsListBox.unselect_row(row);
    });
}

/**
 * Creates and adds a category item to the categories list.
 * @param {Object} category - Category object with name and apps
 * @param {number} pos - Position to insert at (-1 for end)
 */
function fillCategoriesList(category, pos = -1) {
    const row = new Gtk.ListBoxRow();
    row.category = category.name;

    const box = createHorizontalBox();
    box.set_hexpand(false);

    const iconPath = allIconCategories.has(category.name)
        ? GLib.build_filenamev([
            iconCategoriesDir,
            `${category.name}.${allIconCategories.get(category.name)}`,
        ])
        : pathCategoryGenericIcon;

    const rowIcon = createIconImage(ICON_SIZE, iconPath);
    box.append(rowIcon);

    const categoryLabel = new Gtk.Label({
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.END,
    });
    const apps = category.apps;
    const appNames = apps.map(app => app.name).join(', ');
    categoryLabel.set_markup(
        `<span font_desc="20px"><b>${category.name}</b></span>: ${appNames}`
    );
    categoryLabel.set_hexpand(true);
    box.append(categoryLabel);

    const appCountLabel = new Gtk.Label({
        label: String(apps.length),
        xalign: 1,
    });
    appCountLabel.get_style_context().add_class('padding-label');
    box.append(appCountLabel);

    const closeButton = new Gtk.Button();
    const closeIconPath = GLib.build_filenamev([iconDir, 'close_icon.png']);
    closeButton.set_child(Gtk.Image.new_from_file(closeIconPath));
    closeButton.get_style_context().add_class('close-button');
    closeButton.connect('clicked', () => {
        // Check if this category is currently selected before deleting
        const selectedRow = categoriesListBox.get_selected_row();
        const isSelectedCategory = selectedRow && selectedRow.category === category.name;

        // Reset UI elements BEFORE deleting if this category was selected
        if (isSelectedCategory && categoryIcon) {
            // Reset the GLOBAL image-button, not the row icon
            categoryIcon.path = '';
            categoryIcon.set_from_file(pathCategoryGenericIcon);
        }
        if (isSelectedCategory) {
            if (categoryEntry) {
                categoryEntry.set_text('');
            }
            if (addButton) {
                addButton.set_label('Add Category');
                addButton.set_sensitive(false);
            }
            if (appsListBox) {
                initializeAppsList(appsListBox);
            }
        }

        categories.delete(category.name);

        // Recalculate ranks to ensure they're continuous (no gaps)
        const rankedCategories = Array.from(categories.values())
            .filter(cat => cat.rank !== null)
            .sort((a, b) => a.rank - b.rank);

        rankedCategories.forEach((cat, index) => {
            cat.rank = index + 1;
        });

        saveCategoriesToFile();

        // Remove the row from the list
        categoriesListBox.remove(row);
        removePicture(true, category.name);

        // Force unselect all rows to prevent GTK auto-selection
        categoriesListBox.unselect_all();

        // Reset UI state to ensure consistency (even if category wasn't selected before)
        if (categoryEntry) {
            categoryEntry.set_text('');
        }
        if (categoryIcon) {
            categoryIcon.path = '';
            categoryIcon.set_from_file(pathCategoryGenericIcon);
        }
        if (addButton) {
            addButton.set_label('Add Category');
            addButton.set_sensitive(false);
        }
        if (appsListBox) {
            initializeAppsList(appsListBox);
        }

        // Disable up/down buttons since nothing is selected
        if (upButton)
            upButton.set_sensitive(false);
        if (downButton)
            downButton.set_sensitive(false);
    });
    box.append(closeButton);

    row.set_child(box);
    row.get_style_context().add_class('custom-row');
    categoriesListBox.insert(row, pos);
    categoriesListBox.show();
}

/**
 * Builds the preferences widget.
 * @returns {Gtk.Widget} The preferences widget
 */
function buildPrefsWidget() {
    const builder = new Gtk.Builder();
    builder.add_from_file(`${basePath}/prefs.ui`);

    const prefsWidget = builder.get_object('prefs_box');
    categoryEntry = builder.get_object('category_entry');
    const appEntry = builder.get_object('search_app');
    appsListBox = builder.get_object('applications_list');
    const appsScrolledList = builder.get_object('applications_list_scroll');
    const catScrolledList = builder.get_object('categories_list_scroll');
    addButton = builder.get_object('add_category_button');
    categoriesListBox = builder.get_object('categories_list_box');
    upButton = builder.get_object('up_arrow');
    downButton = builder.get_object('down_arrow');

    // Set arrow icons with absolute paths
    const upArrowIcon = builder.get_object('up_arrow_icon');
    const downArrowIcon = builder.get_object('down_arrow_icon');
    const upArrowIconPath = GLib.build_filenamev([iconDir, 'arrow_drop_up.png']);
    const downArrowIconPath = GLib.build_filenamev([iconDir, 'arrow_drop_down.png']);
    upArrowIcon.set_from_file(upArrowIconPath);
    downArrowIcon.set_from_file(downArrowIconPath);

    function setupIconButton(iconId, buttonId, iconPath) {
        const icon = builder.get_object(iconId);
        const button = builder.get_object(buttonId);
        icon.set_from_file(iconPath);
        icon.path = '';
        button.connect('clicked', () => selectImage(icon));
        return icon;
    }

    categoryIcon = setupIconButton(
        'category_icon',
        'category_button',
        pathCategoryGenericIcon
    );

    const allAppsIconPath = GLib.build_filenamev([
        iconCategoriesDir,
        `${ALL_APPS_CAT_NAME}.${allIconCategories.get(ALL_APPS_CAT_NAME)}`,
    ]);
    const searchAppIconPath = GLib.build_filenamev([
        iconCategoriesDir,
        `${SEARCH_APP_CAT_NAME}.${allIconCategories.get(SEARCH_APP_CAT_NAME)}`,
    ]);

    const allAppsIcon = setupIconButton('all_apps_icon', 'all_apps_button', allAppsIconPath);
    const searchAppIcon = setupIconButton('search_app_icon', 'search_app_button', searchAppIconPath);

    const allAppsCheckbox = builder.get_object('all_apps_checkbox');
    const searchAppCheckbox = builder.get_object('search_app_checkbox');

    function handleCheckboxToggle(checkbox, icon, categoryName) {
        if (checkbox.get_active()) {
            const category = { name: categoryName, rank: null, apps: [] };
            if (icon.path !== '')
                copyRenameFile(true, category.name, icon);
            categories.set(category.name, category);
        } else {
            icon.path = '';
            categories.delete(categoryName);
        }
        saveCategoriesToFile();
        refreshCategoriesListBox();
    }

    allAppsCheckbox.connect('toggled', () =>
        handleCheckboxToggle(allAppsCheckbox, allAppsIcon, ALL_APPS_CAT_NAME)
    );
    searchAppCheckbox.connect('toggled', () =>
        handleCheckboxToggle(searchAppCheckbox, searchAppIcon, SEARCH_APP_CAT_NAME)
    );

    function createClickableLabel(labelId, checkbox, icon, categoryName) {
        const label = builder.get_object(labelId);
        label.set_can_focus(true);
        label.set_focus_on_click(true);

        const clickGesture = Gtk.GestureClick.new();
        clickGesture.connect('pressed', () => {
            if (checkbox.active) {
                icon.path = '';
                categories.delete(categoryName);
            } else {
                const category = { name: categoryName, rank: null, apps: [] };
                if (icon.path !== '')
                    copyRenameFile(true, category.name, icon);
                categories.set(category.name, category);
            }
            checkbox.active = !checkbox.active;
            saveCategoriesToFile();
            refreshCategoriesListBox();
        });
        label.add_controller(clickGesture);
    }

    createClickableLabel('all_apps_label', allAppsCheckbox, allAppsIcon, ALL_APPS_CAT_NAME);
    createClickableLabel('search_app_label', searchAppCheckbox, searchAppIcon, SEARCH_APP_CAT_NAME);

    // Initial list population
    refreshCategoriesListBox();
    allAppsCheckbox.active = categories.has(ALL_APPS_CAT_NAME);
    searchAppCheckbox.active = categories.has(SEARCH_APP_CAT_NAME);

    appsListBox.set_sort_func((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    fillApplicationsList(appsListBox);

    const firstApp = appsListBox.get_row_at_index(0);
    if (firstApp) {
        const rowHeight = firstApp.get_allocated_height();
        appsScrolledList.set_size_request(-1, rowHeight * 12);
        catScrolledList.set_size_request(-1, rowHeight * 10);
    }

    categoryEntry.connect('changed', () => {
        const hasText = categoryEntry.text.trim().length > 0;
        appsListBox.set_sensitive(hasText);
        addButton.set_sensitive(hasText && appsListBox.get_selected_rows().length > 0);
        if (!hasText) {
            initializeAppsList(appsListBox);
            addButton.set_sensitive(false);
        }
    });

    appEntry.connect('changed', () => {
        const re = new RegExp(appEntry.text.trim(), 'i');
        let app = appsListBox.get_first_child();
        while (app) {
            app.set_visible(re.source.length === 0 ? true : re.test(app.name));
            app = app.get_next_sibling();
        }
    });

    appsListBox.connect('row-activated', (listBox, row) => {
        const selectedRows = listBox.get_selected_rows();
        let selectedCount = selectedRows.length;
        const rowRank = row.selectionRank;
        if (rowRank === 0) {
            row.selectionRank = selectedCount;
            row.get_child().get_last_child().set_label(String(selectedCount));
        } else {
            selectedRows.forEach(sr => {
                if (sr.selectionRank > rowRank) {
                    sr.selectionRank--;
                    sr.get_child().get_last_child().set_label(String(sr.selectionRank));
                }
            });
            selectedCount--;
            row.selectionRank = 0;
            row.get_child().get_last_child().set_label('');
            listBox.unselect_row(row);
        }
        addButton.set_sensitive(listBox.get_sensitive() && selectedCount > 0);
    });

    categoriesListBox.connect('row-activated', (listBox, row) => {
        upButton.set_sensitive(true);
        downButton.set_sensitive(true);

        const selectedCategoryName = categoryEntry.get_text();
        const category = categories.get(row.category);
        if (category.name === selectedCategoryName) {
            categoryEntry.set_text('');
            initializeAppsList(appsListBox);
            listBox.unselect_row(row);
            addButton.set_label('Add Category');
            addButton.set_sensitive(false);
            categoryIcon.set_from_file(pathCategoryGenericIcon);
            categoryIcon.path = '';
        } else {
            categoryEntry.set_text(`${category.name}`);
            const selectedApps = category.apps;
            selectedApps.forEach(sel => {
                let ra = appsListBox.get_first_child();
                while (ra) {
                    if (ra.id === sel.id) {
                        ra.selectionRank = sel.rank;
                        ra.get_child().get_last_child().set_label(String(sel.rank));
                        appsListBox.select_row(ra);
                        break;
                    }
                    ra = ra.get_next_sibling();
                }
            });
            if (allIconCategories.has(category.name)) {
                const iconPath = GLib.build_filenamev([
                    iconCategoriesDir,
                    `${category.name}.${allIconCategories.get(category.name)}`,
                ]);
                categoryIcon.set_from_file(iconPath);
                // Don't set categoryIcon.path here - it should only be set when user selects a NEW icon
            } else {
                // Ensure we visibly fall back to the generic icon
                categoryIcon.set_from_file(pathCategoryGenericIcon);
                categoryIcon.path = '';
            }
            addButton.set_sensitive(true);
            addButton.set_label('Update Category');
        }
    });

    upButton.connect('clicked',   () => moveSelectedCategory(-1));
    downButton.connect('clicked', () => moveSelectedCategory(+1));

    addButton.connect('clicked', () => {
        try {
            const apps = [];
            const selectedRows = appsListBox.get_selected_rows();
            selectedRows.forEach(row => {
                if (row.iconPath !== '') {
                    copyRenameFile(false, row.id, row);
                    row.iconPath = '';
                }
                apps.push({ id: row.id, name: row.name, rank: row.selectionRank });
            });
            apps.sort((a, b) => a.rank - b.rank);

            const newCategory = { name: categoryEntry.text.trim(), apps };
            const selectedRow = categoriesListBox.get_selected_row();
            let insertPosition = -1;
            let oldCategoryName = '';

            // Check if this is an update based on button label (more reliable than selectedRow)
            // The button label changes to "Update Category" when a category is selected
            const isUpdate = addButton.get_label() === 'Update Category' && selectedRow !== null;

            if (isUpdate) {
                oldCategoryName = selectedRow.category;
                const categoryArray = Array.from(categories.keys());
                insertPosition = categoryArray.indexOf(oldCategoryName);
                // Keep the existing rank for updates
                const oldCategory = categories.get(oldCategoryName);
                newCategory.rank = oldCategory?.rank ?? 1;
            } else {
                // New category - assign next available rank
                const maxRank = Math.max(
                    0,
                    ...Array.from(categories.values())
                        .map(cat => cat.rank)
                        .filter(rank => rank !== null)
                );
                newCategory.rank = maxRank + 1;
            }

            // Handle category icon
            if (categoryIcon.path !== '') {
                // User selected a new icon
                copyRenameFile(true, newCategory.name, categoryIcon);
                // Remove old icon only if category name changed
                if (oldCategoryName !== '' && oldCategoryName !== newCategory.name) {
                    removePicture(true, oldCategoryName);
                }
            } else if (isUpdate && oldCategoryName !== newCategory.name && allIconCategories.has(oldCategoryName)) {
                // User is renaming category without selecting new icon, but old icon exists
                // Copy the old icon to the new name
                const oldExtension = allIconCategories.get(oldCategoryName);
                const oldIconPath = GLib.build_filenamev([
                    iconCategoriesDir,
                    `${oldCategoryName}.${oldExtension}`,
                ]);
                const newIconPath = GLib.build_filenamev([
                    iconCategoriesDir,
                    `${newCategory.name}.${oldExtension}`,
                ]);

                try {
                    const oldFile = Gio.File.new_for_path(oldIconPath);
                    const newFile = Gio.File.new_for_path(newIconPath);
                    oldFile.copy(newFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                    allIconCategories.set(newCategory.name, oldExtension);
                    removePicture(true, oldCategoryName);
                } catch (e) {
                    logError(e, 'Failed to copy icon during category rename');
                }
            }

            // Update categories Map
            if (insertPosition >= 0) {
                // This is an update - replace at the same position
                const categoryArray = Array.from(categories.entries());

                // Remove old entry
                categoryArray.splice(insertPosition, 1);

                // Insert updated category at same position
                categoryArray.splice(insertPosition, 0, [newCategory.name, newCategory]);
                categories = new Map(categoryArray);
            } else {
                // New category - add at the end
                categories.set(newCategory.name, newCategory);
            }

            saveCategoriesToFile();

            // Reset icon widget but don't reset the path yet
            categoryIcon.set_from_file(pathCategoryGenericIcon);
            categoryIcon.path = '';

            categoryEntry.set_text('');
            appEntry.set_text('');
            refreshCategoriesListBox();
        } catch (e) {
            logError(e, 'Failed to add/update category');
        }
    });

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        categoryEntry.grab_focus();
        return GLib.SOURCE_REMOVE;
    });

    prefsWidget.connect('realize', () => {
        const root = prefsWidget.get_root();
        const display = Gdk.Display.get_default();
        const monitor = display.get_monitor_at_surface(root.get_surface());
        const geometry = monitor.get_geometry();
        const workAreaHeight = geometry.height;
        const [curW, curH] = root.get_default_size();
        const [, natSize] = prefsWidget.get_preferred_size();
        const newHeight = Math.min(Math.max(curH, natSize.height) * 1.2, workAreaHeight);
        root.set_default_size(curW, newHeight);
    });

    const gesture = Gtk.GestureClick.new();
    gesture.set_button(Gdk.BUTTON_SECONDARY);
    gesture.connect('pressed', (_g, _n, _x, y) => {
        const row = appsListBox.get_row_at_y(y);
        if (row) showEditApplicationDialog(appsListBox.get_root(), row);
    });
    appsListBox.add_controller(gesture);

    prefsWidget.set_margin_bottom(0);
    prefsWidget.set_spacing(0);

    return prefsWidget;
}

// -------- Image Selection --------

/**
 * Opens a file chooser dialog to select an image file.
 * @param {Gtk.Image} icon - The icon widget to update with the selected image
 */
function selectImage(icon) {
    const fileChooser = new Gtk.FileChooserDialog({
        title: 'Select an Image',
        action: Gtk.FileChooserAction.OPEN,
        modal: true,
    });

    fileChooser.add_button('_Cancel', Gtk.ResponseType.CANCEL);
    fileChooser.add_button('_Open', Gtk.ResponseType.ACCEPT);

    const imageFilter = new Gtk.FileFilter();
    imageFilter.set_name('Image Files');
    ALLOWED_IMAGE_EXTENSIONS.forEach(ext => {
        imageFilter.add_mime_type(`image/${ext}`);
        imageFilter.add_pattern(`*.${ext}`);
    });
    fileChooser.set_filter(imageFilter);

    fileChooser.connect('response', (dialog, responseId) => {
        if (responseId === Gtk.ResponseType.ACCEPT) {
            const file = fileChooser.get_file();
            if (file) {
                const filePath = file.get_path();
                const extension = filePath.split('.').pop().toLowerCase();
                if (ALLOWED_IMAGE_EXTENSIONS.includes(extension)) {
                    icon.path = filePath;
                    icon.set_from_file(filePath);
                }
            }
        }
        dialog.close();
        dialog.destroy();
    });

    fileChooser.show();
}

function showEditApplicationDialog(parent, row) {
    const dialog = new Gtk.Dialog({
        transient_for: parent,
        modal: true,
        title: 'Edit Application',
    });
    dialog.add_button('_Reset', Gtk.ResponseType.CANCEL);
    dialog.add_button('_Save', Gtk.ResponseType.OK);

    const contentBox = dialog.get_content_area();
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 4,
        margin_top: 16,
        margin_bottom: 16,
    });
    box.get_style_context().add_class('min-width-box');

    const appIcon = new Gtk.Image({ pixel_size: 32 });
    if (allIconApps.has(row.id)) {
        appIcon.set_from_file(GLib.build_filenamev([iconAppsDir, `${row.id}.${allIconApps.get(row.id)}`]));
    } else {
        const icon = row.get_child().get_first_child().get_gicon();
        if (icon) appIcon.set_from_gicon(icon);
    }
    appIcon.path = '';

    const appButton = new Gtk.Button({ has_frame: false });
    appButton.set_child(appIcon);
    appButton.connect('clicked', () => selectImage(appIcon));

    const entry = new Gtk.Entry({ placeholder_text: 'Enter a new name...', hexpand: true });
    entry.set_text(row.name);

    box.append(appButton);
    box.append(entry);
    contentBox.append(box);

    dialog.connect('response', (_d, response) => {
        if (response === Gtk.ResponseType.OK) {
            if (appIcon.path !== '' || entry.text.trim().length > 0) {
                const icon = row.get_child().get_first_child();
                if (appIcon.path !== '') {
                    row.iconPath = appIcon.path;
                    icon.set_from_file(appIcon.path);
                }
                const name = entry.text.trim();
                if (name.length > 0) {
                    row.name = name;
                    icon.get_next_sibling().set_label(name);
                }
            }
        } else if (response === Gtk.ResponseType.CANCEL) {
            try {
                const allApps = Gio.AppInfo.get_all();
                const appInfo = allApps.find(app => app.get_id() === row.id);
                const icon = row.get_child().get_first_child();
                if (appInfo?.get_icon()) icon.set_from_gicon(appInfo.get_icon());
                const originalName = appInfo.get_display_name();
                row.name = originalName;
                icon.get_next_sibling().set_label(originalName);
                row.path = '';
                removePicture(false, row.id);
            } catch (error) {
                log(error.message);
            }
        }

        row.set_sensitive(false);
        row.set_sensitive(true);
        dialog.destroy();
    });

    dialog.show();
}

// -------- File Operations --------

/**
 * Copies and renames an icon file to the appropriate directory.
 * @param {boolean} isCategory - True if this is a category icon, false for app icon
 * @param {string} newBaseName - Base name for the new file
 * @param {Object} obj - Object containing the source path
 */
function copyRenameFile(isCategory, newBaseName, obj) {
    try {
        const dirPath = isCategory ? iconCategoriesDir : iconAppsDir;
        const fileMap = isCategory ? allIconCategories : allIconApps;
        const srcPath = isCategory ? obj.path : obj.iconPath;

        GLib.mkdir_with_parents(dirPath, 0o755);

        const src = Gio.File.new_for_path(srcPath);
        const extension = GLib.path_get_basename(srcPath).split('.').pop();
        const newFileName = `${newBaseName}.${extension}`;

        const dst = Gio.File.new_for_path(GLib.build_filenamev([dirPath, newFileName]));
        removePicture(isCategory, newBaseName);
        src.copy(dst, Gio.FileCopyFlags.OVERWRITE, null, null);

        fileMap.set(newBaseName, extension);
        obj[isCategory ? 'path' : 'iconPath'] = '';
    } catch (e) {
        logError(e, 'Failed to copy and rename file');
    }
}

/**
 * Removes an icon file from the icon directory.
 * @param {boolean} isCategory - True if this is a category icon, false for app icon
 * @param {string} baseName - Base name of the file to remove
 * @returns {boolean} True if successful, false otherwise
 */
function removePicture(isCategory, baseName) {
    const dirPath = isCategory ? iconCategoriesDir : iconAppsDir;
    const fileMap = isCategory ? allIconCategories : allIconApps;

    try {
        if (!fileMap.has(baseName)) {
            return false;
        }

        const extension = fileMap.get(baseName);
        const filePath = GLib.build_filenamev([dirPath, `${baseName}.${extension}`]);
        const file = Gio.File.new_for_path(filePath);

        file.delete(null);
        fileMap.delete(baseName);
        return true;
    } catch (e) {
        logError(e, `Failed to remove picture with base name "${baseName}"`);
        return false;
    }
}

// -------- Extension Preferences Entry Point --------

/**
 * Main preferences class for Start Menu extension.
 */
export default class StartMenuPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Initialize paths
        basePath = this.path;
        filesDir = GLib.build_filenamev([basePath, '.files']);
        categoriesFilePath = GLib.build_filenamev([filesDir, 'categories.jsonl']);
        iconDir = GLib.build_filenamev([filesDir, 'icons']);
        iconCategoriesDir = GLib.build_filenamev([iconDir, 'categories']);
        iconAppsDir = GLib.build_filenamev([iconDir, 'apps']);
        pathCategoryGenericIcon = GLib.build_filenamev([iconDir, 'category_icon.png']);

        // Load stylesheet
        const styleProvider = new Gtk.CssProvider();
        styleProvider.load_from_path(`${basePath}/stylesheet.css`);
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            styleProvider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        // Load data and icons
        loadCategories(categories);
        allIconCategories = getAllIcons(iconCategoriesDir) || new Map();
        allIconApps = getAllIcons(iconAppsDir) || new Map();

        // Clean up uninstalled apps from all categories
        const changesMade = cleanupCategories();
        if (changesMade) {
            saveCategoriesToFile();
        }

        // Build UI
        const prefsWidget = buildPrefsWidget();

        const page = new Adw.PreferencesPage({ title: 'General' });
        const group = new Adw.PreferencesGroup();
        group.add(prefsWidget);
        page.add(group);
        window.add(page);
    }
}
