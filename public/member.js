import { $, api, notify, node, action, empty, table, date } from "./common.js";
let me = null,
  next = null,
  pending = null;
const consents = () => new Set(me?.consents.map((c) => c.community_id) || []);
function card(c) {
  const d = node("article", undefined, "card");
  d.append(
    node("div", "✳", "icon"),
    node("h3", c.name),
    node("p", c.description),
  );
  const tags = node("div", undefined, "tags");
  [c.language, ...c.tags].forEach((t) => tags.append(node("span", t, "tag")));
  d.append(tags);
  if (c.reason) d.append(node("span", c.reason, "muted"));
  const actions = node("div", undefined, "actions");
  if (!me) {
    const a = node(
      "a",
      "Hubungkan Discord untuk bergabung",
      "button secondary",
    );
    a.href = "/auth/discord/start";
    actions.append(a);
  } else if (consents().has(c.id))
    actions.append(
      action(
        "Cabut persetujuan",
        async () => {
          await api(`/api/me/consents/${c.id}`, { method: "DELETE" });
          notify("Persetujuan berhasil dicabut");
          await refresh();
        },
        "danger small",
      ),
    );
  else
    actions.append(
      action("Setujui auto-join", () => {
        pending = c;
        $("#consent-community").textContent = c.name;
        $("#consent-form").reset();
        $("#consent-dialog").showModal();
      }),
    );
  d.append(actions);
  return d;
}
async function catalog(append = false) {
  const form = new FormData($("#filter-form"));
  const params = new URLSearchParams();
  for (const [k, v] of form) if (v) params.set(k, v);
  if (append && next) params.set("after", next);
  const data = await api(`/api/catalog?${params}`);
  const target = $("#catalog");
  if (!append) target.replaceChildren();
  data.items.forEach((c) => target.append(card(c)));
  if (!target.children.length)
    empty(
      target,
      "Ruang baru sedang disiapkan",
      "Komunitas yang telah disetujui akan tampil di sini.",
    );
  next = data.next;
  $("#load-more").hidden = !next;
}
async function refresh() {
  try {
    me = await api("/api/me");
  } catch (e) {
    if (e.status !== 401) notify(e.message, true);
    me = null;
  }
  $("#profile").hidden = !me;
  $("#recommendations").hidden = !me;
  if (me) {
    $("#connect").textContent = me.username;
    $("#connect").href = "#profile";
    $("#member-name").textContent = `Halo, ${me.username}`;
    $("#interests-form").elements.interests.value = me.interests.join(", ");
    const rows = await api("/api/me/recommendations");
    const target = $("#recommended-grid");
    target.replaceChildren(...rows.map(card));
    if (!rows.length)
      empty(
        target,
        "Belum ada rekomendasi baru",
        "Isi minatmu atau jelajahi katalog di bawah.",
      );
  }
  await catalog();
}
$("#filter-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await catalog();
  } catch (e) {
    notify(e.message, true);
  }
});
$("#load-more").addEventListener("click", async () => {
  try {
    await catalog(true);
  } catch (e) {
    notify(e.message, true);
  }
});
$("#cancel-consent").addEventListener("click", () =>
  $("#consent-dialog").close(),
);
$("#consent-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pending) return;
  const b = e.submitter;
  b.disabled = true;
  try {
    await api(`/api/me/consents/${pending.id}`, { method: "POST", body: "{}" });
    $("#consent-dialog").close();
    notify("Persetujuan tersimpan. Kamu bisa mencabutnya kapan saja.");
    await refresh();
  } catch (e) {
    notify(e.message, true);
  } finally {
    b.disabled = false;
  }
});
$("#interests-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/me/interests", {
      method: "PATCH",
      body: JSON.stringify({
        interests: e.target.elements.interests.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    });
    notify("Minatmu telah diperbarui");
    await refresh();
  } catch (e) {
    notify(e.message, true);
  }
});
$("#disconnect").addEventListener("click", async () => {
  if (!confirm("Cabut koneksi dan hentikan semua auto-join berikutnya?"))
    return;
  try {
    await api("/api/me/disconnect", { method: "POST", body: "{}" });
    location.href = "/";
  } catch (e) {
    notify(e.message, true);
  }
});
$("#logout").addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST", body: "{}" });
    location.href = "/";
  } catch (e) {
    notify(e.message, true);
  }
});
$("#show-activity").addEventListener("click", async () => {
  try {
    const rows = await api("/api/me/activity");
    $("#activity").hidden = false;
    table(
      $("#activity"),
      ["Komunitas", "Status", "Diperbarui"],
      rows.map((x) => [x.name, x.status, date(x.updated_at)]),
    );
  } catch (e) {
    notify(e.message, true);
  }
});
if (new URLSearchParams(location.search).get("oauth") === "failed")
  notify("Koneksi Discord belum berhasil. Silakan ulangi.", true);
if (location.search) history.replaceState(null, "", "/");
refresh().catch((e) => {
  empty(
    $("#catalog"),
    "Katalog belum tersedia",
    "Silakan coba kembali setelah layanan dikonfigurasi.",
  );
  notify(e.message, true);
});

$("#delete-account").addEventListener("click", async () => {
  if (
    !confirm(
      "Hapus identitas Member Network dan cabut seluruh persetujuan? Tindakan ini tidak mengeluarkanmu dari server Discord.",
    )
  )
    return;
  try {
    await api("/api/me/delete", { method: "POST", body: "{}" });
    location.href = "/";
  } catch (e) {
    notify(e.message, true);
  }
});
