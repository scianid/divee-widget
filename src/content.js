// Paste in browser console. Uses Readability (if available) + code.js-style filtering.
function getContent(articleClass) {
  const selectors = [
    "article",
    ".article-content",
    "[role='main']",
    "main",
    ".post-content",
    ".entry-content",
    ".content",
  ];

  const pickContainer = () => {
    // If articleClass is provided, try it first
    if (articleClass) {
      const el = document.querySelector(articleClass);
      if (el) return el;
    }
    
    // Fall back to default selectors
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  };

  const isInside = (el, tag) => !!el.closest(tag);

  const isCaption = (el, text) => {
    const prev = el.previousElementSibling?.tagName?.toLowerCase();
    const next = el.nextElementSibling?.tagName?.toLowerCase();
    if (prev === "figcaption" || next === "figcaption") return true;
    if (text.length < 100 && (prev === "img" || next === "img")) return true;
    const hasEm = !!el.querySelector("i, em");
    const hasSmall = !!el.querySelector("small");
    const style = (el.getAttribute("style") || "").toLowerCase();
    const cls = (el.className || "").toLowerCase();
    return (
      ((hasEm || hasSmall) && text.length < 150) ||
      cls.includes("caption") ||
      cls.includes("credit") ||
      cls.includes("source") ||
      (style.includes("font-size") && style.includes("small"))
    );
  };

  const linkDensity = (el, text) => {
    if (!text) return 0;
    const links = el.getElementsByTagName("a");
    if (!links.length) return 0;
    let linkText = 0;
    for (const a of links) linkText += (a.textContent || "").trim().length;
    return linkText / text.length;
  };

  const isAdContent = (el, text) => {
    const t = text.toLowerCase();
    const textFlags = [
      /\badvertisement\b/,
      /\bsponsored\b/,
      /\bpromotion\b/,
      /\bpartner content\b/,
      /\baffiliate\b/,
      /\bcontinue reading below\b/,
      /\bread more\b/,
      /\bclick here\b/,
      /\bsign up for\b/,
      /\bsubscribe to\b/,
      /\bnewsletter\b/,
      /special offer/,
      /limited time/,
      /\bdiscount\b/,
      /\bsale\b.*\bends\b/,
    ];
    if (textFlags.some(r => r.test(t))) return true;

    const cls = (el.className || "").toLowerCase();
    const id = (el.id || "").toLowerCase();
    const parentCls = (el.parentElement?.className || "").toLowerCase();
    const tokens = [
      "ad","ads","advertisement","sponsor","promoted","promo","banner","commercial",
      "widget","sidebar","related","recommended",
    ];
    const matchesToken = (str) => tokens.some(k => new RegExp(`\\b${k}\\b`).test(str));
    if (matchesToken(cls) || matchesToken(id) || matchesToken(parentCls)) return true;

    const links = Array.from(el.getElementsByTagName("a"));
    if (links.length === 1 && (links[0].textContent || "").trim() === text) return true;
    return links.some(a => {
      const href = a.getAttribute("href") || "";
      return href.includes("utm_") || href.includes("ref=") || href.includes("click=") || href.includes("campaign=");
    });
  };

  const getReadabilityContent = () => {
    try {
      if (typeof Readability !== "function") return null;
      const docClone = document.cloneNode(true);
      const parsed = new Readability(docClone).parse();
      if (!parsed) return null;
      return { title: parsed.title || document.title || "Untitled", content: parsed.content || "" };
    } catch {
      return null;
    }
  };

  const readability = getReadabilityContent();
  const container = pickContainer();
  const htmlSource = readability?.content || container.innerHTML;
  const root = document.createElement("div");
  root.innerHTML = htmlSource;

  let nodes = Array.from(root.querySelectorAll("p"))
    .filter(el => (el.textContent || "").trim().length > 0);

  if (nodes.length < 3) {
    nodes = Array.from(root.querySelectorAll("span, div"))
      .filter(el => (el.textContent || "").trim().length > 30)
      .filter(el => !el.querySelector("p"));
  }

  const paragraphs = [];
  const stats = { empty:0, insideFigure:0, insideAside:0, caption:0, highLinkDensity:0, adContent:0, tooShort:0 };

  for (const el of nodes) {
    const text = (el.textContent || "").trim();
    if (!text) { stats.empty++; continue; }
    if (isInside(el, "figure")) { stats.insideFigure++; continue; }
    if (isInside(el, "aside")) { stats.insideAside++; continue; }
    if (isCaption(el, text)) { stats.caption++; continue; }
    if (linkDensity(el, text) > 0.8) { stats.highLinkDensity++; continue; }
    if (isAdContent(el, text)) { stats.adContent++; continue; }
    if (text.length < 20) { stats.tooShort++; continue; }
    paragraphs.push(text);
  }

  const content = paragraphs.join("\n\n");
  return content;
}

// Call manually:
// getContent();

// Gets the article title similar to code.js (Readability -> document.title -> "Untitled")
function getContentTitle() {
  try {
    if (typeof Readability === "function") {
      const docClone = document.cloneNode(true);
      const parsed = new Readability(docClone).parse();
      if (parsed && parsed.title) return parsed.title;
    }
  } catch {
    // ignore
  }
  return document.title || "Untitled";
}

// Call manually:
// getContentTitle();

// Gets the article URL (same as code.js detectUrl)
function getContentUrl() {
  return window.location.href;
}

// Call manually:
// getContentUrl();