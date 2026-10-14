/** 把后台/技术报错转成运营能看懂的说明 */

export type ErrorGuidance = {
  title: string;
  body: string;
  action?: string;
};

type ErrorContext = {
  mockApiEnabled?: boolean;
  apiBaseUrl?: string;
};

export function explainError(raw: string | undefined, ctx: ErrorContext = {}): ErrorGuidance | null {
  const msg = raw?.trim();
  if (!msg) return null;

  const lower = msg.toLowerCase();

  if (/accountlabel|至少.*商务号|至少.*平台|启用.*渠道/i.test(lower)) {
    if (ctx.mockApiEnabled) {
      return {
        title: '还没配置要跑的渠道',
        body: '检查连接前，需要先打开要使用的平台。',
        action:
          '在上方 Instagram / TikTok 卡片勾选「自动发送」→ 填写商务号编号 → 保存。\nMock 测试：也可在底部调试区勾选 Mock 并填测试主页。',
      };
    }
    return {
      title: '还没启用发送渠道',
      body: '请先在要使用的平台旁打开「自动发送」，再填写商务号编号。',
      action:
        '在上方 Instagram 或 TikTok 卡片勾选「自动发送」→ 填写商务号编号（与后台一致）→ 点「保存设置」→ 再点「检查连接是否正常」。',
    };
  }

  if (/access token|同步工作台|mock api/i.test(lower)) {
    return {
      title: '还没完成登录配置',
      body: '检查连接需要已登录工作台，或开启 Mock 做本地测试。',
      action: '点「同步工作台登录」；若后端未就绪，可展开底部「调试与高级设置」勾选 Mock API。',
    };
  }

  if (/后台地址/.test(msg)) {
    return {
      title: '还没填写后台地址',
      body: '需要知道 bioby-email 服务地址，插件才能和后台通信。',
      action: '在「账号设置」第一项填写后台地址（不要带 /api），保存后再检查连接。',
    };
  }

  if (/熔断|halted|已暂停/.test(msg)) {
    return {
      title: '发送已暂停',
      body: localizeTechnical(msg),
      action: '处理完验证码/重新登录后，点上方「恢复 Instagram」或「恢复 TikTok」。',
    };
  }

  if (/401|403|unauthorized|forbidden/i.test(msg)) {
    return {
      title: '登录已过期或无权限',
      body: '工作台 Token 失效，或账号没有私信相关权限。',
      action: '重新打开工作台登录 → 点「同步工作台登录」→ 保存后再试。',
    };
  }

  return {
    title: '需要处理',
    body: localizeTechnical(msg),
    action: undefined,
  };
}

function localizeTechnical(msg: string): string {
  return msg
    .replace(/accountLabel/gi, '商务号编号')
    .replace(/\binstagram\b/gi, 'Instagram')
    .replace(/\btiktok\b/gi, 'TikTok')
    .replace(/HTTP \d+:/g, '后台返回错误：')
    .replace(/Profile mismatch/gi, '打开的达人主页与任务不一致')
    .replace(/Message button not found/gi, '达人主页上找不到「发消息」按钮')
    .replace(/composer not found/gi, '打不开私信输入框')
    .replace(/send button not found/gi, '找不到发送按钮')
    .replace(/Send not confirmed/gi, '无法确认是否发送成功')
    .replace(/report-reply:/gi, '上报回复失败：')
    .replace(/reply-scan:/gi, '扫描回复失败：');
}
