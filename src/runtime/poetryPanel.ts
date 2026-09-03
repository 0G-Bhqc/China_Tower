import type { PavilionId } from '../createPavilionGalleryModel';
import { getPavilionContent, type PavilionWork } from '../content/pavilionContent';

// 诗文抽屉面板:用现成 pavilionContent 渲染每楼两篇作品 + 楼阁志。
// 皮肤全部来自 style.css 既有类(.poetry-panel / .content-tabs / .poem-entry),
// 本模块只负责 DOM 装配、标签页切换与随楼刷新。

export type PoetryPanel = {
  setOpen: (open: boolean) => void;
  isOpen: () => boolean;
  toggle: () => void;
  showWork: (index: number) => void;
  setPavilion: (id: PavilionId) => void;
};

const ABOUT_TAB = 'about';

function formatVerse(text: string): string {
  // 律诗/骈文在句号处断行,逗号保留在行内,得到双句一行的阅读节奏。
  return text.replace(/([。？！])/g, '$1\n');
}

function renderWorkEntry(work: PavilionWork, index: number): HTMLElement {
  const entry = document.createElement('article');
  entry.className = 'poem-entry';
  entry.dataset.tab = String(index);

  const label = document.createElement('p');
  label.className = 'poem-label';
  label.textContent = `作品 0${index + 1} · ${work.dynasty}`;
  entry.appendChild(label);

  const heading = document.createElement('h3');
  heading.textContent = work.title;
  entry.appendChild(heading);

  const byline = document.createElement('p');
  byline.className = 'poem-byline';
  byline.textContent = `${work.author} · ${work.dynasty}`;
  entry.appendChild(byline);

  const quote = document.createElement('blockquote');
  // 竖排模式由 CSS 在 .quote-body 上展开 (writing-mode: vertical-rl)。滚动
  // 容器保持横排: vertical-rl 的列向左溢出且 LTR 容器不计入可滚动区, 直接
  // 立文本块会把开头几列裁掉 — 内层 width:max-content 让溢出变成真实的
  // 右向滚动量, snapVerticalScroll 才能把读者送到文本开头。
  const quoteBody = document.createElement('span');
  quoteBody.className = 'quote-body';
  quoteBody.textContent = formatVerse(work.excerpt);
  quoteBody.style.whiteSpace = 'pre-line';
  quote.appendChild(quoteBody);
  entry.appendChild(quote);

  const gloss = document.createElement('p');
  gloss.className = 'poem-gloss';
  gloss.textContent = work.gloss;
  entry.appendChild(gloss);

  const appreciation = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = '赏析 · 与场景同读';
  appreciation.appendChild(summary);
  const body = document.createElement('p');
  body.textContent = work.appreciation;
  appreciation.appendChild(body);
  entry.appendChild(appreciation);

  const source = document.createElement('p');
  source.className = 'poem-gloss source-line';
  source.textContent = `出处 · ${work.source}`;
  entry.appendChild(source);

  return entry;
}

function renderAboutSection(pavilionId: PavilionId): HTMLElement {
  const content = getPavilionContent(pavilionId);
  const section = document.createElement('article');
  section.className = 'content-section';
  section.dataset.tab = ABOUT_TAB;

  const addBlock = (heading: string, text: string, lead = false): void => {
    const h3 = document.createElement('h3');
    h3.textContent = heading;
    section.appendChild(h3);
    const p = document.createElement('p');
    p.textContent = text;
    if (lead) p.className = 'content-lead';
    section.appendChild(p);
  };
  addBlock('楼阁志', content.historicalSummary, true);
  addBlock('建筑意匠', content.architecturalSummary);
  addBlock('登临线索', content.sceneCue);

  const list = document.createElement('ul');
  list.className = 'source-list';
  for (const source of content.sources) {
    const item = document.createElement('li');
    item.textContent = source;
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

export function createPoetryPanel(): PoetryPanel {
  const rootEl = document.getElementById('poetry-panel');
  const towerTitleEl = document.getElementById('poetry-tower');
  const tabsNavEl = document.getElementById('poetry-tabs');
  const bodyEl = document.getElementById('poetry-body');
  const closeButton = document.getElementById('poetry-close');
  const toggleButton = document.getElementById('poetry-toggle');
  const verticalButton = document.getElementById('poetry-vertical');
  if (!rootEl || !towerTitleEl || !tabsNavEl || !bodyEl) {
    throw new Error('Poetry panel DOM missing: expected #poetry-panel shell in index.html');
  }
  const root: HTMLElement = rootEl;
  const towerTitle: HTMLElement = towerTitleEl;
  const tabsNav: HTMLElement = tabsNavEl;
  const body: HTMLElement = bodyEl;

  let activeTab: string = '0';
  let currentId: PavilionId = 'yueyang';

  // 竖排阅读: 只翻转诗文引文块 (blockquote), 注解/赏析保持横排以保可读性。
  // 偏好存 localStorage, 跨会话记住。
  const VERTICAL_KEY = 'poetry-vertical';
  // vertical-rl 的滚动原点在文本末尾一侧: 不归位的话读者先看到结尾。
  // 右起第一列 (文本开头) 在 scrollLeft 的另一端, 打开/切换时统一送过去。
  function snapVerticalScroll(): void {
    if (!body.classList.contains('is-vertical')) return;
    requestAnimationFrame(() => {
      for (const quote of body.querySelectorAll<HTMLElement>('.poem-entry blockquote')) {
        quote.scrollLeft = quote.scrollWidth;
      }
    });
  }
  function applyVertical(on: boolean): void {
    body.classList.toggle('is-vertical', on);
    verticalButton?.setAttribute('aria-pressed', String(on));
    snapVerticalScroll();
  }
  applyVertical(localStorage.getItem(VERTICAL_KEY) === '1');
  verticalButton?.addEventListener('click', () => {
    const on = !body.classList.contains('is-vertical');
    applyVertical(on);
    try {
      localStorage.setItem(VERTICAL_KEY, on ? '1' : '0');
    } catch { /* 私密模式下存储不可用, 本次会话内仍然生效 */ }
  });

  function render(pavilionId: PavilionId): void {
    const content = getPavilionContent(pavilionId);
    currentId = pavilionId;
    towerTitle.textContent = `${content.id === 'yueyang' ? '岳阳楼' : content.id === 'huanghe' ? '黄鹤楼' : '滕王阁'} · 诗文`;
    tabsNav.textContent = '';
    body.textContent = '';

    content.works.forEach((work, index) => {
      const tab = document.createElement('button');
      tab.dataset.tab = String(index);
      tab.textContent = work.title;
      tabsNav.appendChild(tab);
      body.appendChild(renderWorkEntry(work, index));
    });
    const aboutTab = document.createElement('button');
    aboutTab.dataset.tab = ABOUT_TAB;
    aboutTab.textContent = '楼阁志';
    tabsNav.appendChild(aboutTab);
    body.appendChild(renderAboutSection(pavilionId));

    setActiveTab(activeTab === ABOUT_TAB || Number(activeTab) < content.works.length ? activeTab : '0');
  }

  function setActiveTab(tab: string): void {
    activeTab = tab;
    for (const button of tabsNav.querySelectorAll('button')) {
      button.classList.toggle('is-active', button.dataset.tab === tab);
    }
    let visibleCount = 0;
    for (const entry of body.children) {
      const show = (entry as HTMLElement).dataset.tab === tab;
      (entry as HTMLElement).hidden = !show;
      if (show) visibleCount += 1;
    }
    if (visibleCount === 0) {
      // Fallback: never leave the drawer blank if tab ids ever drift.
      for (const entry of body.children) (entry as HTMLElement).hidden = false;
    }
    body.scrollTop = 0;
    snapVerticalScroll();
  }

  tabsNav.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest('button[data-tab]');
    if (button) setActiveTab((button as HTMLElement).dataset.tab ?? '0');
  });

  function setOpen(open: boolean): void {
    root.classList.toggle('is-open', open);
    // The HUD's right-hand column tracks the drawer: nav/meta/status/footer
    // slide with the panel via the --hud-gutter custom property in style.css.
    document.body.classList.toggle('poetry-open', open);
    root.setAttribute('aria-hidden', String(!open));
    toggleButton?.setAttribute('aria-pressed', String(open));
  }

  closeButton?.addEventListener('click', () => setOpen(false));
  toggleButton?.addEventListener('click', () => setOpen(!root.classList.contains('is-open')));

  render(currentId);

  return {
    setOpen,
    isOpen: () => root.classList.contains('is-open'),
    toggle: () => setOpen(!root.classList.contains('is-open')),
    showWork: (index: number) => {
      setActiveTab(String(index));
      setOpen(true);
    },
    setPavilion: (id: PavilionId) => {
      if (id === currentId) return;
      render(id);
    },
  };
}
