/** 只留这封新写的话。历史引用按 CRM 订单往来的处理去掉。 */

const WROTE_ON = /^.{0,160}?\bwrote on\s+\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2})?:?\s*$/i;
const CHINESE_WROTE = /^.{0,40}(?:在|于).{0,80}(?:19|20)\d{2}年.{0,60}写道[：:]\s*$/;
const INLINE_WROTE_ON = /(?:^|\s)>?\s*\S+@\S+\s+wrote on\s+\d{4}-\d{1,2}-\d{1,2}/i;
const INLINE_ON_WROTE = /\bOn\s+\S.{0,160}?wrote:/i;
const INLINE_CHINESE = /(?:在|于)\s*(?:19|20)\d{2}年.{0,60}写道[：:]/;
const INLINE_ORIGINAL = /-{5,}\s*Original Message|原始邮件|Begin forwarded message|-{2,}\s*Forwarded message/i;

export function latestMailText(raw: string | undefined): string {
  if (!raw?.trim()) {
    return "";
  }
  const plain = htmlToPlain(raw);
  const kept = cutQuote(plain).trim();
  if (kept) {
    return kept;
  }
  return plain.trim() ? "（这封只有历史引用）" : "";
}

function htmlToPlain(raw: string): string {
  const stripped = raw
    .replace(/<(style|script|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<blockquote\b[^>]*>[\s\S]*$/i, " ")
    .replace(/<div\b[^>]*\bgmail_quote\b[^>]*>[\s\S]*/i, " ")
    .replace(/<div\b[^>]*\bid\s*=\s*["'](?:divRplyFwdMsg|appendonsend)["'][^>]*>[\s\S]*/i, " ");
  return stripped
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cutQuote(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(">") || trimmed === "--" || quoteHeader(trimmed)) {
      break;
    }
    const inline = inlineQuoteAt(line);
    if (inline >= 0) {
      const prefix = line.slice(0, inline).replace(/[\s>]+$/, "").trim();
      if (prefix) {
        kept.push(prefix);
      }
      break;
    }
    if (clientChrome(trimmed)) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function quoteHeader(line: string): boolean {
  if (!line) {
    return false;
  }
  if (
    line.startsWith("-----Original")
    || line.startsWith("原始邮件")
    || line.startsWith("Original Message")
    || line.startsWith("发件人")
    || /^-{6,}\s*original\s*-{6,}$/i.test(line)
    || /^[-—]{6,}\s*原始/.test(line)
  ) {
    return true;
  }
  if (/^from:/i.test(line)) {
    return true;
  }
  if (
    /^On .+ wrote:?\s*$/i.test(line)
    || /^Begin forwarded message:\s*$/i.test(line)
    || /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i.test(line)
  ) {
    return true;
  }
  return WROTE_ON.test(line) || CHINESE_WROTE.test(line);
}

function inlineQuoteAt(line: string): number {
  let at = -1;
  for (const pattern of [INLINE_WROTE_ON, INLINE_ON_WROTE, INLINE_CHINESE, INLINE_ORIGINAL]) {
    const found = pattern.exec(line);
    if (found && (at < 0 || found.index < at)) {
      at = found.index;
    }
  }
  return at;
}

function clientChrome(line: string): boolean {
  if (!line) {
    return false;
  }
  const lower = line.toLowerCase();
  if (/^sent from my (iphone|ipad|android|mobile)[.!]?$/.test(lower)) {
    return true;
  }
  if (/^sent from (outlook|yahoo mail|mail for windows)( for (ios|android|mac))?[.!?]?$/.test(lower)) {
    return true;
  }
  if (/^get outlook for (ios|android|mac)[.!]?$/.test(lower)) {
    return true;
  }
  if (/^发自我的\s*(iPhone|iPad|华为手机|华为|小米手机|小米|QQ邮箱|QQ|安卓)[.。]?$/.test(line)) {
    return true;
  }
  return false;
}
