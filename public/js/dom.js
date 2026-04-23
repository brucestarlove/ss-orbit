// Cached DOM references queried once at module-load time. Importing this
// module assumes the body has been parsed (the script tag is at the bottom
// of <body> and uses type="module", so this holds).

export const $ = (selector) => document.querySelector(selector);

export const boardMenuBtn = $("#boardMenuBtn");
export const boardFlyout = $("#boardFlyout");
export const kanban = $("#kanban");
export const drawer = $("#drawer");
export const drawerInner = $("#drawerInner");
export const drawerBackdrop = $("#drawerBackdrop");
export const createFlyout = $("#createFlyout");
export const createFlyoutInner = $("#createFlyoutInner");
export const createFlyoutBackdrop = $("#createFlyoutBackdrop");
export const searchInput = $("#searchInput");
export const searchResults = $("#searchResults");
export const themeToggle = $("#themeToggle");
export const themeIcon = $("#themeIcon");
