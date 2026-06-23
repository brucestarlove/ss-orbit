// Custom typeahead dropdown for the ticket-detail drawer inputs (Add label,
// Set parent epic, Add related ticket). Replaces the native <datalist>, which
// browsers render in their own un-styleable popup, with a results list that
// reuses the topbar search styling (bold label + title + state badge). The
// component only fills the input on selection — the surrounding form's Add/Set
// button and Enter handler still own the actual mutation, so swapping the
// datalist for this is a pure presentation change.

const ACTIVE_CLASS = "is-active";

/**
 * Wire a styled suggestion dropdown onto a text input.
 *
 * Options:
 *   - getItems():        returns the full candidate list (re-read on each keystroke).
 *   - match(item, q):    whether an item matches the lowercased query string.
 *   - renderItem(item):  inner HTML for the .search-hit row.
 *   - valueOf(item):     string written into the input when the item is chosen.
 *   - onSelect(item):    optional hook fired after the value is filled.
 *   - emptyText:         message shown when a non-empty query matches nothing.
 *   - minChars:          minimum query length before the list opens (default 0).
 *   - maxItems:          cap on rendered rows (default 8).
 *
 * Returns a teardown function (rarely needed — the drawer is re-rendered wholesale).
 */
export function attachTypeahead(
  input,
  {
    getItems,
    match,
    renderItem,
    valueOf,
    onSelect,
    emptyText = "No matches",
    minChars = 0,
    maxItems = 8,
  },
) {
  if (!input) return () => {};

  // Appended to <body> (not the input's wrapper) so the ancestor
  // .settings-card overflow:hidden can't clip it; positioned as fixed from the
  // input's viewport rect and re-anchored on scroll/resize while open.
  const list = document.createElement("div");
  list.className = "search-results typeahead-results";
  list.hidden = true;
  list.setAttribute("role", "listbox");
  list._ownerInput = input;
  document.body.appendChild(list);

  // The drawer re-renders wholesale, detaching the old inputs but leaving their
  // body-level dropdowns behind. Sweep those orphans (owner no longer in the
  // document) whenever a fresh typeahead mounts.
  for (const el of document.querySelectorAll(".typeahead-results")) {
    if (el !== list && el._ownerInput && !el._ownerInput.isConnected) {
      el.remove();
    }
  }

  let visible = [];
  let activeIndex = -1;
  let blurTimer = 0;

  const position = () => {
    const r = input.getBoundingClientRect();
    list.style.left = `${r.left}px`;
    list.style.width = `${r.width}px`;
    list.style.top = `${r.bottom + 4}px`;
  };

  const onReposition = () => {
    if (list.hidden) return;
    position();
  };

  const close = () => {
    list.hidden = true;
    list.innerHTML = "";
    visible = [];
    activeIndex = -1;
    window.removeEventListener("scroll", onReposition, true);
    window.removeEventListener("resize", onReposition);
  };

  const open = () => {
    if (!list.hidden) return;
    list.hidden = false;
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
  };

  const render = () => {
    const query = input.value.trim().toLowerCase();
    if (query.length < minChars) {
      close();
      return;
    }
    const all = getItems() || [];
    visible = (query ? all.filter((item) => match(item, query)) : all).slice(
      0,
      maxItems,
    );
    if (visible.length === 0) {
      // Only surface the empty state once the user has typed something —
      // an empty focused field just shows the full (capped) list below.
      if (query) {
        open();
        list.innerHTML = `<div class="search-hit typeahead-empty">${emptyText}</div>`;
        position();
      } else {
        close();
      }
      return;
    }
    activeIndex = -1;
    open();
    list.innerHTML = visible
      .map(
        (item, i) =>
          `<div class="search-hit" role="option" data-index="${i}">${renderItem(item)}</div>`,
      )
      .join("");
    position();
  };

  const setActive = (next) => {
    const rows = list.querySelectorAll("[data-index]");
    if (!rows.length) return;
    activeIndex = (next + rows.length) % rows.length;
    rows.forEach((row, i) => {
      const on = i === activeIndex;
      row.classList.toggle(ACTIVE_CLASS, on);
      if (on) row.scrollIntoView({ block: "nearest" });
    });
  };

  const choose = (item) => {
    if (!item) return;
    input.value = valueOf(item);
    // Let the host form react (e.g. the clear-button has-value toggle).
    input.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    input.focus();
    if (onSelect) onSelect(item);
  };

  const onInput = () => render();
  const onFocus = () => render();

  const onKeydown = (event) => {
    if (list.hidden) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(activeIndex - 1);
    } else if (event.key === "Enter") {
      // Only swallow Enter when a suggestion is highlighted; otherwise let the
      // form submit the typed value as before.
      if (activeIndex >= 0 && visible[activeIndex]) {
        event.preventDefault();
        // stopImmediatePropagation so a sibling keydown listener on the same
        // input (e.g. the label field's add-on-Enter) doesn't also fire.
        event.stopImmediatePropagation();
        choose(visible[activeIndex]);
      }
    } else if (event.key === "Escape") {
      if (!list.hidden) {
        event.stopPropagation();
        close();
      }
    }
  };

  const onBlur = () => {
    blurTimer = window.setTimeout(close, 120);
  };

  // mousedown beats the input's blur, so the row click registers before close().
  const onMouseDown = (event) => {
    const row = event.target.closest("[data-index]");
    if (!row) return;
    event.preventDefault();
    window.clearTimeout(blurTimer);
    choose(visible[Number(row.dataset.index)]);
  };

  input.addEventListener("input", onInput);
  input.addEventListener("focus", onFocus);
  input.addEventListener("keydown", onKeydown);
  input.addEventListener("blur", onBlur);
  list.addEventListener("mousedown", onMouseDown);

  return () => {
    window.clearTimeout(blurTimer);
    window.removeEventListener("scroll", onReposition, true);
    window.removeEventListener("resize", onReposition);
    input.removeEventListener("input", onInput);
    input.removeEventListener("focus", onFocus);
    input.removeEventListener("keydown", onKeydown);
    input.removeEventListener("blur", onBlur);
    list.removeEventListener("mousedown", onMouseDown);
    list.remove();
  };
}
