import { $, api, notify, node, action, empty, table, date } from "./common.js";
let view = "overview",
  role = null,
  next = null,
  items = [];
const titles = {
  overview: "Ringkasan jaringan",
  members: "Anggota jaringan",
  communities: "Komunitas",
  campaigns: "Campaign",
  analytics: "Analitik campaign",
  audit: "Audit aktivitas",
};
const labels = {
  added: "Berhasil ditambahkan",
  already_member: "Sudah menjadi anggota",
  pending: "Menunggu screening",
  queued: "Dalam antrean",
  processing: "Sedang diproses",
  retry: "Dijadwalkan ulang",
  failed: "Gagal",
  cancelled: "Dibatalkan",
  unknown: "Perlu rekonsiliasi",
};
const split = (s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
async function overview() {
  const a = await api("/api/admin/analytics");
  const metrics = $("#metrics");
  metrics.replaceChildren();
  [
    ["Total anggota", a.members],
    ["Komunitas terdaftar", a.communities],
    ["Campaign", a.campaigns],
    ["Bergabung baru", a.joins.find((x) => x.status === "added")?.count || 0],
  ].forEach(([label, value]) => {
    const m = node("div", undefined, "metric");
    m.append(
      node("span", label),
      node("strong", value.toLocaleString("id-ID")),
    );
    metrics.append(m);
  });
  const bars = $("#join-bars");
  bars.replaceChildren();
  const max = Math.max(1, ...a.joins.map((x) => x.count));
  for (const row of a.joins) {
    const b = node("div", undefined, "bar");
    const fill = node("i");
    fill.style.width = `${Math.round((row.count / max) * 150)}px`;
    b.append(
      node("span", labels[row.status] || row.status),
      fill,
      node("strong", row.count),
    );
    bars.append(b);
  }
  if (!a.joins.length)
    empty(
      bars,
      "Belum ada aktivitas",
      "Hasil campaign akan muncul setelah auto-join dijalankan.",
    );
  $("#join-state").textContent = a.auto_join_enabled
    ? "Auto-join aktif. Setiap job tetap memeriksa izin anggota dan status campaign."
    : "Auto-join belum aktif. Operator perlu mengaktifkannya setelah konfigurasi Discord diverifikasi.";
  return a;
}
function buttons(...bs) {
  const d = node("div", undefined, "actions");
  d.append(...bs);
  return d;
}
async function load(append = false) {
  document
    .querySelectorAll("[data-view]")
    .forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  $("#overview-view").hidden = view !== "overview";
  $("#data-view").hidden = ![
    "members",
    "communities",
    "campaigns",
    "audit",
  ].includes(view);
  $("#analytics-view").hidden = view !== "analytics";
  $("#page-title").textContent = titles[view];
  $("#breadcrumb").textContent = titles[view];
  $("#create").hidden =
    role !== "admin" || !["communities", "campaigns"].includes(view);
  if (view === "overview") return overview();
  if (view === "analytics") {
    const a = await overview();
    table(
      $("#daily-table"),
      ["Tanggal", "Hasil", "Jumlah"],
      a.daily.map((x) => [date(x.day), labels[x.status] || x.status, x.count]),
    );
    return;
  }
  $("#list-title").textContent = titles[view];
  $("#list-description").textContent =
    view === "audit"
      ? "Maksimum 100 aktivitas terakhir. Data rahasia tidak ditampilkan."
      : "Data dimuat sesuai permintaan, tanpa polling otomatis.";
  const data = await api(
    `/api/admin/${view}${append && next ? `?after=${next}` : ""}`,
  );
  items = append ? [...items, ...data.items] : data.items || data;
  next = data.next;
  $("#load-more").hidden = !next;
  if (view === "members")
    table(
      $("#data-table"),
      ["Anggota", "Discord ID", "Koneksi", "Terdaftar", "Tindakan"],
      items.map((m) => [
        m.username,
        m.discord_id,
        `${m.connection_status} · ${m.active ? "Aktif" : "Nonaktif"}`,
        date(m.created_at),
        buttons(
          action("Riwayat", async () => {
            const r = await api(`/api/admin/members/${m.id}/activity`);
            $("#activity-dialog h2").textContent = "Riwayat aktivitas anggota";
            table(
              $("#member-activity"),
              ["Aksi", "Waktu"],
              r.map((x) => [x.action, date(x.created_at)]),
            );
            $("#activity-dialog").showModal();
          }),
          action(m.active ? "Nonaktifkan" : "Aktifkan", async () => {
            await api(`/api/admin/members/${m.id}`, {
              method: "PATCH",
              body: JSON.stringify({ active: !m.active }),
            });
            await load();
          }),
          action(
            "Cabut",
            async () => {
              if (!confirm("Cabut koneksi Discord anggota ini?")) return;
              await api(`/api/admin/members/${m.id}/disconnect`, {
                method: "POST",
                body: "{}",
              });
              await load();
            },
            "danger small",
          ),
        ),
      ]),
    );
  if (view === "communities")
    table(
      $("#data-table"),
      ["Komunitas", "Bahasa / minat", "Status", "Tindakan"],
      items.map((c) => [
        c.name,
        [c.language, ...c.tags].join(", "),
        c.status,
        role === "admin"
          ? buttons(
              action(
                c.status === "approved" ? "Tangguhkan" : "Setujui",
                async () => {
                  await api(`/api/admin/communities/${c.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                      status:
                        c.status === "approved" ? "suspended" : "approved",
                    }),
                  });
                  await load();
                },
              ),
            )
          : node("span", "Hanya baca"),
      ]),
    );
  if (view === "campaigns")
    table(
      $("#data-table"),
      ["Campaign", "Jadwal", "Batas", "Status", "Tindakan"],
      items.map((c) => [
        c.name,
        `${date(c.starts_at)} sampai ${date(c.ends_at)}`,
        c.member_limit,
        c.status,
        role === "admin"
          ? buttons(
              action("Mulai", async () => {
                if (
                  !confirm(
                    "Mulai campaign untuk anggota yang telah memberi persetujuan?",
                  )
                )
                  return;
                const r = await api(`/api/admin/campaigns/${c.id}/start`, {
                  method: "POST",
                  body: "{}",
                });
                notify(`${r.queued} anggota masuk antrean`);
                await load();
              }),
              action("Jeda", async () => {
                await api(`/api/admin/campaigns/${c.id}/pause`, {
                  method: "POST",
                  body: "{}",
                });
                await load();
              }),
              action("Hasil", async () => {
                const r = await api(`/api/admin/campaigns/${c.id}/jobs`);
                table(
                  $("#member-activity"),
                  ["Hasil", "Percobaan", "Diperbarui"],
                  r.items.map((j) => [
                    labels[j.status] || j.status,
                    j.attempts,
                    date(j.updated_at),
                  ]),
                );
                $("#activity-dialog h2").textContent = "Hasil campaign terbaru";
                $("#activity-dialog").showModal();
              }),
              action("Selesai", async () => {
                if (!confirm("Tutup campaign dan batalkan antrean tersisa?"))
                  return;
                await api(`/api/admin/campaigns/${c.id}/complete`, {
                  method: "POST",
                  body: "{}",
                });
                await load();
              }),
            )
          : node("span", "Hanya baca"),
      ]),
    );
  if (view === "audit")
    table(
      $("#data-table"),
      ["Waktu", "Aksi", "Aktor", "Objek"],
      items.map((x) => [date(x.created_at), x.action, x.actor, x.entity]),
    );
}
async function session() {
  try {
    const s = await api("/api/admin/session");
    role = s.role;
    if (role !== "admin" && ["members", "audit"].includes(view))
      view = "overview";
    $("#role").textContent = role === "admin" ? "Admin" : "Viewer";
    $("#login").hidden = true;
    $("#shell").hidden = false;
    document
      .querySelectorAll('[data-view="members"],[data-view="audit"]')
      .forEach((b) => {
        b.hidden = role !== "admin";
      });
    await load();
  } catch (e) {
    $("#shell").hidden = true;
    $("#login").hidden = false;
    if (e.status !== 401) notify(e.message, true);
  }
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  e.submitter.disabled = true;
  try {
    await api("/auth/admin/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    e.target.reset();
    await session();
  } catch (e) {
    notify(e.message, true);
  } finally {
    e.submitter.disabled = false;
  }
});
for (const b of document.querySelectorAll("[data-view]"))
  b.addEventListener("click", async () => {
    view = b.dataset.view;
    document
      .querySelectorAll("[data-view]")
      .forEach((n) => n.classList.toggle("active", n === b));
    try {
      await load();
    } catch (e) {
      empty($("#data-table"), "Data belum tersedia", e.message);
      notify(e.message, true);
    }
  });
$("#refresh").addEventListener("click", () =>
  load().catch((e) => notify(e.message, true)),
);
$("#load-more").addEventListener("click", () =>
  load(true).catch((e) => notify(e.message, true)),
);
$("#logout").addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST", body: "{}" });
    location.reload();
  } catch (e) {
    notify(e.message, true);
  }
});
for (const b of document.querySelectorAll(".close-dialog"))
  b.addEventListener("click", () => b.closest("dialog").close());
$("#create").addEventListener("click", async () => {
  try {
    if (view === "communities") {
      $("#community-form").reset();
      $("#community-dialog").showModal();
    }
    if (view === "campaigns") {
      const list = [];
      let cursor;
      do {
        const r = await api(
          `/api/admin/communities${cursor ? `?after=${cursor}` : ""}`,
        );
        list.push(...r.items);
        cursor = r.next;
      } while (cursor && list.length < 1000);
      const select = $("#community-select");
      select.replaceChildren();
      for (const c of list.filter((c) => c.status === "approved")) {
        const o = node("option", c.name);
        o.value = c.id;
        select.append(o);
      }
      if (!select.children.length)
        return notify("Setujui komunitas terlebih dahulu", true);
      $("#campaign-form").reset();
      $("#campaign-dialog").showModal();
    }
  } catch (e) {
    notify(e.message, true);
  }
});
for (const kind of ["community", "campaign"])
  $(`#${kind}-form`).addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = e.submitter;
    b.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(e.target));
      values.tags = split(values.tags);
      if (kind === "campaign") {
        values.limit = Number(values.limit);
        values.starts_at = new Date(values.starts_at).toISOString();
        values.ends_at = new Date(values.ends_at).toISOString();
      }
      await api(
        `/api/admin/${kind === "community" ? "communities" : "campaigns"}`,
        { method: "POST", body: JSON.stringify(values) },
      );
      $(`#${kind}-dialog`).close();
      notify("Data berhasil disimpan");
      await load();
    } catch (e) {
      notify(e.message, true);
    } finally {
      b.disabled = false;
    }
  });
if (Object.hasOwn(titles, location.hash.slice(1)))
  view = location.hash.slice(1);
session();
