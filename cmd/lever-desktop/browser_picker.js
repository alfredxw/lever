(() => new Promise((resolve) => {
  window.dispatchEvent(new Event("lever:cancel-element-pick"));
  const controller = new AbortController();
  const capture = {capture: true, signal: controller.signal};
  const shield = document.createElement("div");
  const overlay = document.createElement("div");
  const label = document.createElement("span");
  Object.assign(overlay.style, {
    position: "fixed", inset: "auto", zIndex: "2147483647", pointerEvents: "none",
    border: "2px solid #538cff", background: "rgba(83,140,255,.12)", boxSizing: "border-box",
    display: "none",
  });
  Object.assign(label.style, {
    position: "absolute", left: "0", top: "0", background: "#172849", color: "white",
    font: "12px/18px system-ui", padding: "0 4px", whiteSpace: "nowrap",
  });
  overlay.append(label);
  Object.assign(shield.style, { position: "fixed", inset: "0", zIndex: "2147483647", cursor: "crosshair", pointerEvents: "auto" });
  shield.append(overlay);
  document.documentElement.append(shield);
  const finish = (result) => {
    controller.abort();
    shield.remove();
    resolve(result);
  };
  const cancel = () => finish(null);
  const targetOf = (event) => {
    return document.elementsFromPoint(event.clientX, event.clientY).find((node) => !shield.contains(node));
  };
  const selectorOf = (element) => {
    const parts = [];
    for (let node = element; node && parts.length < 8; node = node.parentElement) {
      if (node.id && node.id.length < 100) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      const tag = CSS.escape(node.localName);
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((sibling) => sibling.localName === node.localName) : [];
      parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")" : tag);
    }
    return parts.join(" > ").slice(0, 800);
  };
  const highlight = (event) => {
    const target = targetOf(event);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    label.textContent = target.localName;
    Object.assign(overlay.style, { display: "block", left: rect.x + "px", top: rect.y + "px", width: rect.width + "px", height: rect.height + "px" });
  };
  const stop = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const pick = (event) => {
    stop(event);
    const target = targetOf(event);
    if (!target) return cancel();
    const sensitive = "input,textarea,select,[contenteditable]:not([contenteditable=false])";
    const text = target.closest(sensitive) || target.querySelector(sensitive) ? "" :
      (target.getAttribute("aria-label") || target.innerText || "").trim().replace(/\s+/g, " ").slice(0, 180);
    finish({ tag: target.localName.slice(0, 80), text, selector: selectorOf(target) });
  };
  window.addEventListener("pointermove", highlight, capture);
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick", "contextmenu"]) {
    window.addEventListener(type, stop, capture);
  }
  window.addEventListener("click", pick, capture);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { stop(event); cancel(); }
  }, capture);
  window.addEventListener("pagehide", cancel, capture);
  window.addEventListener("lever:cancel-element-pick", cancel, capture);
}))()
