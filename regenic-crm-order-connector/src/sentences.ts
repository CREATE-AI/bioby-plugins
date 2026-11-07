import type { AskDoc, FactDoc, OrderDoc } from "./model";

const MATTER: Record<string, (quote: string) => string> = {
  CONFIRM: (quote) => `接受现在的合作内容。报价 ${quote}。请问要不要推进？`,
  OWN_TOTAL: (quote) => `接受现在的合作内容。报价 ${quote}。请问要不要推进？`,
  TOO_LOW: (quote) => `觉得现在的价格偏低。报价 ${quote}。请问还有没有空间，要不要继续？`,
  COUNTER: (quote) => `觉得现在的价格偏低。报价 ${quote}。请问还有没有空间，要不要继续？`,
  FLOOR: (quote) => `给了这次能做的最低价。报价 ${quote}。请问接不接受？`,
  ACCEPT_SCOPE: () => "接受价格，但要改合作内容。请问接不接受这次调整？",
  PRICE_AND_SCOPE: () => "同时改了价格和合作内容。请问接不接受这次调整？",
  PARTIAL: () => "只接受做一部分。请问接不接受？",
  SCOPE_NO_PRICE: () => "还在谈合作内容，价格还没定。范围可能影响预算，请问要不要继续？",
  REJECT: () => "明确说这次不做了。",
  SCHEDULE: () => "档期已满。请问是放弃，还是预约新档期？",
  NEED_INFO: () => "报价前还要一些信息。请问这些信息能不能提供？",
  ASK_CONTRACT: () => "在问合同或合作怎么进行。需要确认合同时，再同步具体条款。",
  CONTRACT_EDIT: () => "希望修改合同措辞。需要看时，只说改了哪一条。",
  PAYMENT: () => "在问付款方式。合作确认后，按 PayPal 支付。",
  DEPOSIT: () => "要求先付款或付定金。我们还没有答应任何比例。请问能不能破例？",
  HOW_TO_SHOOT: () => "在问怎么拍。需要提供拍法时，再补充具体要求。",
  NOT_RECEIVED: () => "说没收到上一封。我们会再发一次上次的合作内容和报价。",
  INTEREST: () => "只表示有兴趣，还没有报价。",
  UNCLEAR: () => "这封回复暂时看不懂。先不同步原话。",
};

export function customerScriptFromScene(order: OrderDoc): string {
  const scene = order.sharedScene?.trim();
  if (!scene || !MATTER[scene]) {
    return "";
  }
  const quote = order.externalQuote == null ? "" : String(order.externalQuote);
  const nick = order.nickname?.trim() || "（未填昵称）";
  const link = order.bloggerLink?.trim() || "（未填链接）";
  return `达人：${nick}\n链接：${link}\n${MATTER[scene](quote)}`;
}

export function customerScriptFromAsk(order: OrderDoc, ask: AskDoc | undefined): string {
  const template = ask?.scriptTemplate?.trim() ?? "";
  // 跟进里「确认合作、档期满」把 party 记成运营，真正要发给客户的是 scriptTemplate。
  // 只有运营说明、没有这句话术时，不用 lead，避免把内部交接写成给客户的话。
  const lead = ask?.party === "OPS" ? "" : ask?.lead?.trim() ?? "";
  const pattern = template || lead;
  if (!pattern) {
    return "";
  }
  const link = order.bloggerLink?.trim();
  const sentence = fillTemplate(pattern, order, ask?.facts ?? []);
  if (!sentence) {
    return "";
  }
  return link ? `${link}\n${sentence}` : sentence;
}

function fillTemplate(pattern: string, order: OrderDoc, facts: FactDoc[]): string {
  const price = factValue(facts, "EXTERNAL_PRICE");
  const benefits = factValue(facts, "BENEFITS");
  const scope = facts
    .filter((fact) => fact.kind === "TEXT" && fact.value?.trim())
    .map((fact) => fact.value!.trim())
    .join("，");
  const platform = order.platform?.trim() ?? "";
  let text = pattern;
  text = put(text, "{price}", price);
  text = put(text, "{platform}", platform);
  text = text.replace("{scope}", scope ? `，${scope}` : "");
  if (text.includes("含{benefits}")) {
    text = text.replace("含{benefits}", benefits ? `含${benefits}` : "");
  }
  text = text.replace("{benefits}", benefits ? (scope ? `，含${benefits}` : `含${benefits}`) : "");
  return text.replace(/\s{2,}/g, " ").replace(/，，/g, "，").trim();
}

function factValue(facts: FactDoc[], kind: string): string {
  return facts.find((fact) => fact.kind === kind && fact.value?.trim())?.value?.trim() ?? "";
}

function put(text: string, token: string, value: string): string {
  if (!text.includes(token)) {
    return text;
  }
  if (!value) {
    return text.replace(`含${token}`, "").replaceAll(token, "");
  }
  return text.replaceAll(token, value);
}
