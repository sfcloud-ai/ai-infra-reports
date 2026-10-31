// 修改自 MetriCraft 728caaa；保留 Pagefind、主题、对话框、键盘与代码复制交互，移除 SDK/API 与语言切换。见 LICENSE、NOTICE。
import { translator } from "../data/translate";
const root = document.documentElement;
const locale = root.lang.startsWith("zh") ? "zh" : "en";
const t = translator(locale);
const themeButton = document.querySelector<HTMLButtonElement>("button#theme-toggle");
function themeLabel() {
  themeButton?.setAttribute(
    "aria-label",
    t(
      root.dataset.theme === "dark"
        ? "Switch to light theme"
        : "Switch to dark theme",
    ),
  );
}
themeLabel();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", event => {
  let chosen = false; try { chosen = ["light", "dark"].includes(localStorage.getItem("ai-brief-theme") || ""); } catch {}
  if (!chosen) { root.dataset.theme = event.matches ? "dark" : "light"; themeLabel(); }
});
themeButton?.addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("ai-brief-theme", root.dataset.theme);
  } catch {
    /* Preference storage is optional. */
  }
  themeLabel();
});

const search = document.querySelector<HTMLDialogElement>("dialog#search-dialog")!;
const menu = document.querySelector<HTMLDialogElement>("dialog#mobile-navigation")!;
const input = search.querySelector<HTMLInputElement>("input#search-input")!;
const status = search.querySelector<HTMLElement>("p#search-status")!;
const results = search.querySelector<HTMLOListElement>("ol#search-results")!;
const base = import.meta.env.BASE_URL.replace(/\/$/, "");
let opener: HTMLElement | null = null;
function openDialog(dialog: HTMLDialogElement) {
  if (dialog.open) return;
  opener = document.activeElement as HTMLElement;
  document
    .querySelectorAll<HTMLDialogElement>("dialog[open]")
    .forEach((other) => other.close());
  dialog.showModal();
  document.body.classList.add("dialog-open");
  if (dialog === search) input.focus();
}
document
  .querySelectorAll<HTMLButtonElement>("[data-search-open]")
  .forEach((button) =>
    button.addEventListener("click", () => openDialog(search)),
  );
document
  .querySelector("button#menu-open")
  ?.addEventListener("click", () => openDialog(menu));
document.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) => {
  dialog
    .querySelector("[data-close-dialog]")
    ?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const box = dialog.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    if (!document.querySelector("dialog[open]")) {
      document.body.classList.remove("dialog-open");
      opener?.focus();
    }
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (search.open || menu.open)) {
    event.preventDefault();
    (search.open ? search : menu).close();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openDialog(search);
  }
});
if (!/Mac|iPhone|iPad/.test(navigator.userAgent))
  document
    .querySelectorAll(".search-trigger kbd")
    .forEach((key) => (key.textContent = "Ctrl K"));

interface SearchPage {
  url: string;
  meta: { title?: string };
  excerpt: string;
  sub_results?: {title:string;url:string;excerpt:string}[];
}
interface SearchIndex {
  search: (
    query: string,
  ) => Promise<{ results: { data: () => Promise<SearchPage> }[] }>;
}
let pagefind: Promise<SearchIndex> | undefined;
let revision = 0;
let timer: ReturnType<typeof setTimeout>;
input.addEventListener("input", () => {
  const current = ++revision;
  clearTimeout(timer);
  const query = input.value.trim();
  results.replaceChildren();
  if (!query) {
    status.textContent = t("Search guides, examples and the Python API.");
    return;
  }
  status.textContent = t("Searching…");
  timer = setTimeout(async () => {
    try {
      pagefind ??= import(/* @vite-ignore */ `${base}/pagefind/pagefind.js`);
      const index = await pagefind;
      const found = await index.search(query);
      const matches = await Promise.all(
        found.results.slice(0, 12).map((result) => result.data()),
      );
      if (current !== revision) return;
      status.textContent = found.results.length
        ? locale === "zh"
          ? `找到 ${found.results.length} 个匹配页面。`
          : `${found.results.length} matching page${found.results.length === 1 ? "" : "s"}.`
        : t("No matching pages. Try a method name or a shorter phrase.");
      for (const page of matches) {
        const url = new URL(page.url, location.origin);
        if (
          url.origin !== location.origin ||
          !url.pathname.startsWith(`${base}/`)
        )
          continue;
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = url.href;
        const title = document.createElement("strong");
        title.textContent = page.meta.title || t("AI Infra report");
        const excerpt = document.createElement("p");
        const parsed = new DOMParser().parseFromString(
          page.excerpt,
          "text/html",
        );
        excerpt.textContent = parsed.body.textContent;
        link.append(title, excerpt);
        item.append(link);
        results.append(item);
        for (const section of (page.sub_results || []).filter(s => s.url.includes("#")).slice(0, 3)) {
          const sectionURL = new URL(section.url, location.origin);
          if (sectionURL.origin !== location.origin || !sectionURL.pathname.startsWith(base + "/")) continue;
          const row = document.createElement("li"), anchor = document.createElement("a");
          anchor.className = "search-section"; anchor.href = sectionURL.href; anchor.textContent = section.title;
          row.append(anchor); results.append(row);
        }
      }
    } catch {
      pagefind = undefined;
      if (current === revision)
        status.textContent = t(
          "Search could not load. Please retry, or use the navigation. Local previews need a full site build first.",
        );
    }
  }, 150);
});
input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    results.querySelector("a")?.focus();
    event.preventDefault();
  }
});
results.addEventListener("click", (event) => {
  if (!(event.target instanceof Element) || !event.target.closest("a[href]")) return;
  // A fragment can stay in this document; let native navigation follow closing the modal.
  opener = null;
  search.close();
});
results.addEventListener("keydown", (event) => {
  const links = [...results.querySelectorAll("a")];
  const index = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (event.key === "ArrowDown") {
    links[Math.min(index + 1, links.length - 1)]?.focus();
    event.preventDefault();
  }
  if (event.key === "ArrowUp") {
    if (index <= 0) input.focus();
    else links[index - 1].focus();
    event.preventDefault();
  }
});

document
  .querySelectorAll<HTMLPreElement>("pre:not([data-no-copy])")
  .forEach((pre) => {
    const code =
      pre.querySelector("code") ||
      (pre.hasAttribute("data-copy-plain") ? pre : null);
    if (!code) return;
    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    pre.replaceWith(wrapper);
    wrapper.append(pre);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-code";
    button.textContent = t("Copy");
    button.setAttribute("aria-label", t("Copy code"));
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent || "");
        button.textContent = t("Copied");
      } catch {
        button.textContent = t("Select to copy");
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(code);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setTimeout(() => (button.textContent = t("Copy")), 1800);
    });
    wrapper.append(button);
  });
