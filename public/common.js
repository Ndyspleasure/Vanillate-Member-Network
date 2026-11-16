export const $ = (s) => document.querySelector(s);
let toastTimer;
export function notify(message, error = false) {
  const n = $("#status");
  n.textContent = message;
  n.classList.toggle("error", error);
  n.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    n.hidden = true;
  }, 7000);
}
export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error || "Permintaan gagal"), {
      status: response.status,
    });
  return data;
}
export function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
export function action(label, fn, style = "secondary small") {
  const b = node("button", label, style);
  b.type = "button";
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      notify(e.message, true);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
export function empty(target, title, description = "") {
  target.replaceChildren();
  const d = node("div", undefined, "empty");
  d.append(node("strong", title), node("p", description));
  target.append(d);
}
export function table(target, headers, rows) {
  target.replaceChildren();
  if (!rows.length)
    return empty(
      target,
      "Belum ada data",
      "Data akan muncul setelah layanan mulai digunakan.",
    );
  const wrap = node("div", undefined, "table-wrap");
  const t = node("table");
  const thead = node("thead");
  const tr = node("tr");
  headers.forEach((h) => tr.append(node("th", h)));
  thead.append(tr);
  t.append(thead);
  const tbody = node("tbody");
  rows.forEach((row) => {
    const tr = node("tr");
    row.forEach((cell) => {
      const td = node("td");
      if (cell instanceof Node) td.append(cell);
      else td.textContent = String(cell ?? "Belum ada");
      tr.append(td);
    });
    tbody.append(tr);
  });
  t.append(tbody);
  wrap.append(t);
  target.append(wrap);
}
export const date = (value) =>
  new Date(value).toLocaleString("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  });
