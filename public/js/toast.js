// Toast notifications + small UI utilities (downloadJson, debounce).

import { escapeHtml } from "./format.js";

const toastIcons = {
  info: `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clip-rule="evenodd"/></svg>`,
  success: `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clip-rule="evenodd"/></svg>`,
  error: `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd"/></svg>`
};

let toastContainer = null;

function ensureToastContainer() {
  if (toastContainer && toastContainer.isConnected) return toastContainer;
  toastContainer = document.createElement("div");
  toastContainer.className = "toast-container";
  document.body.append(toastContainer);
  return toastContainer;
}

export function toast(message, type = "info", duration = 4000) {
  const container = ensureToastContainer();

  const node = document.createElement("div");
  node.className = `toast toast-${type}`;
  node.setAttribute("role", "status");

  const icon = toastIcons[type];
  node.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close" aria-label="Dismiss">&times;</button>`;

  node.querySelector(".toast-close").addEventListener("click", () => dismissToast(node));

  container.prepend(node);
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add("toast-enter")));

  const timer = setTimeout(() => dismissToast(node), duration);
  node.addEventListener("mouseenter", () => clearTimeout(timer));
  node.addEventListener("mouseleave", () => {
    const t2 = setTimeout(() => dismissToast(node), 1500);
    node.addEventListener("mouseenter", () => clearTimeout(t2), { once: true });
  });
}

toast.info = (msg, dur) => toast(msg, "info", dur);
toast.success = (msg, dur) => toast(msg, "success", dur);
toast.warning = (msg, dur) => toast(msg, "warning", dur);
toast.error = (msg, dur) => toast(msg, "error", dur);

function dismissToast(node) {
  if (node.classList.contains("toast-exit")) return;
  node.classList.add("toast-exit");
  node.addEventListener("animationend", () => node.remove(), { once: true });
}

export function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
